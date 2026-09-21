import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as guardedFetch } from 'undici';

export class GatewayError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export class DestinationPolicy {
  readonly allowedOrigins: string[];
  private readonly privateIps: Set<string>;
  constructor(origins = process.env.MCP_ALLOWED_ORIGINS ?? '', privateIps = process.env.MCP_ALLOWED_PRIVATE_IPS ?? '') {
    this.allowedOrigins = [...new Set(origins.split(',').map(value => value.trim()).filter(Boolean).map(value => {
      if (/[?#\x00-\x20\x7f]/.test(value)) throw new Error('Invalid MCP origin');
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
      return url.origin;
    }))];
    this.privateIps = new Set(privateIps.split(',').map(value => value.trim()).filter(Boolean).map(normalizeIp));
  }
  url(value: string): URL {
    if (/[?#\x00-\x20\x7f]/.test(value)) throw new GatewayError(400, 'MCP URL cannot contain whitespace, query or fragment');
    let url: URL;
    try { url = new URL(value); } catch { throw new GatewayError(400, 'Enter a valid MCP HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new GatewayError(400, 'MCP URL must use HTTP(S), without credentials, query or fragment');
    if (!this.allowedOrigins.includes(url.origin)) throw new GatewayError(400, 'This MCP service address has not been allowed by the platform');
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || ['host.docker.internal', 'gateway.docker.internal', 'metadata.google.internal'].includes(host)) throw new GatewayError(400, 'Local and platform control addresses are not allowed');
    return url;
  }
  address(address: string): string {
    const normalized = normalizeIp(address);
    const kind = ipaddr.parse(normalized).range();
    if (['loopback', 'linkLocal', 'unspecified', 'broadcast', 'multicast', 'reserved'].includes(kind)) throw new GatewayError(400, 'MCP destination resolves to a blocked address');
    if (kind !== 'unicast' && !this.privateIps.has(normalized)) throw new GatewayError(400, 'Private MCP addresses must be explicitly allowed by the platform');
    return normalized;
  }
  async resolve(url: URL): Promise<Array<{ address: string; family: number }>> {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
    if (!addresses.length) throw new GatewayError(502, 'MCP service address could not be resolved');
    return addresses.map(item => { const address = this.address(item.address); return { address, family: isIP(address) }; });
  }
}
function normalizeIp(value: string): string {
  if (!isIP(value)) throw new Error('MCP_ALLOWED_PRIVATE_IPS must contain IP addresses');
  const address = ipaddr.parse(value);
  return address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress() ? (address as ipaddr.IPv6).toIPv4Address().toString() : address.toString();
}

/** Resolve, validate, and pin the socket's lookup for EVERY fetch. Redirects never forward credentials. */
export function createNetwork(policy: DestinationPolicy, endpoint: string, lifecycle: AbortSignal) {
  const target = policy.url(endpoint);
  const agents = new Set<Agent>();
  const closed = new AbortController();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    // Normalize Request inputs as well as the SDK's URL + init calls. In particular,
    // a Request's headers, body and abort signal must not be silently discarded.
    const request = new Request(input, init);
    const url = policy.url(request.url);
    if (url.origin !== target.origin || url.pathname !== target.pathname) throw new GatewayError(400, 'MCP transport attempted to change its endpoint');
    const requestAbort = new AbortController();
    const signal = AbortSignal.any([lifecycle, closed.signal, request.signal, requestAbort.signal, AbortSignal.timeout(60_000)]);
    signal.throwIfAborted();
    const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      void policy.resolve(url).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    signal.throwIfAborted();
    const agent = new Agent({ connect: {
      timeout: 10_000,
      lookup: (_hostname, options, callback) => {
        const matching = addresses.filter(item => !options.family || item.family === options.family);
        const selected = matching.length ? matching : addresses;
        if (options.all) callback(null, selected);
        else callback(null, selected[0]!.address, selected[0]!.family);
      },
    } });
    agents.add(agent);
    let released: Promise<void> | undefined;
    const release = () => {
      if (!released) {
        signal.removeEventListener('abort', abortAgent);
        // Each agent serves one request, so destruction is safe after EOF too.
        released = agent.destroy().catch(() => {}).finally(() => { agents.delete(agent); });
      }
      return released;
    };
    const abortAgent = () => { void release(); };
    signal.addEventListener('abort', abortAgent, { once: true });
    try {
      const response = await guardedFetch(url, {
        ...init as Parameters<typeof guardedFetch>[1],
        method: request.method, headers: [...request.headers],
        body: request.body as unknown as NonNullable<Parameters<typeof guardedFetch>[1]>['body'],
        ...(request.body ? { duplex: 'half' as const } : {}),
        dispatcher: agent, redirect: 'manual', signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new GatewayError(502, 'MCP redirects are not allowed');
      }
      const maximum = 2 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > maximum) throw new GatewayError(502, 'MCP response is too large');
      let size = 0;
      const reader = (response.body as unknown as ReadableStream<Uint8Array> | null)?.getReader();
      let finished = false;
      const body = reader ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (finished) return;
          try {
            const chunk = await reader.read();
            if (finished) return;
            if (chunk.done) {
              finished = true;
              controller.close();
              reader.releaseLock();
              await release();
              return;
            }
            size += chunk.value.byteLength;
            if (size > maximum) throw new GatewayError(502, 'MCP response is too large');
            controller.enqueue(chunk.value);
          } catch (error) {
            if (finished) return;
            finished = true;
            requestAbort.abort(error);
            controller.error(error);
            await reader.cancel(error).catch(() => {});
            reader.releaseLock();
            await release();
          }
        },
        async cancel(reason) {
          finished = true;
          requestAbort.abort(reason);
          await reader.cancel(reason).catch(() => {});
          reader.releaseLock();
          await release();
        },
      }) : null;
      if (!reader) await release();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: new Headers([...response.headers]) });
    } catch (error) { requestAbort.abort(error); await release(); throw error; }
  };
  return { fetch, close: async () => { closed.abort(new Error('MCP network closed')); await Promise.allSettled([...agents].map(agent => agent.destroy())); agents.clear(); } };
}
