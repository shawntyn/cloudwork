import { FILE_TRANSFER_LIMITS } from '@cloud-work/protocol';

export class FileProxyError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
const forwardedHeaders = ['content-type', 'content-disposition', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'] as const;

/** Own the upstream lifetime until the browser has consumed or cancelled its body. */
export async function proxyFileTransfer(request: Request, url: string, token: string, json?: unknown): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(new FileProxyError(504, 'File transfer timed out')), FILE_TRANSFER_LIMITS.timeoutMs);
  timer.unref();
  const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener('abort', abort); };
  let inputError: FileProxyError | undefined;
  try {
    const headers = new Headers({ authorization: `Bearer ${token}`, 'accept-encoding': 'identity' });
    const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, signal: controller.signal, cache: 'no-store' };
    if (request.method === 'PUT') {
      if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream') {
        throw new FileProxyError(415, 'Use application/octet-stream');
      }
      const length = request.headers.get('content-length');
      if (length !== null) {
        if (!/^\d+$/.test(length) || Number(length) > FILE_TRANSFER_LIMITS.maxFileBytes) throw new FileProxyError(413, 'Each upload file must be at most 100 MiB');
        headers.set('content-length', length);
      }
      headers.set('content-type', 'application/octet-stream');
      const source = request.body;
      async function* chunks() {
        if (!source) return;
        const reader = source.getReader();
        // Interrupt a pending read when the manager rejects an unfinished upload
        // or the browser disconnects. Releasing the lock preserves the browser
        // socket so an early conflict response can still be delivered.
        const release = () => reader.releaseLock();
        controller.signal.addEventListener('abort', release, { once: true });
        let size = 0;
        try {
          while (true) {
            controller.signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > FILE_TRANSFER_LIMITS.maxFileBytes) {
              inputError = new FileProxyError(413, 'Each upload file must be at most 100 MiB');
              throw inputError;
            }
            yield chunk.value;
          }
        } finally {
          // An early 409 must leave the client socket writable for its response.
          controller.signal.removeEventListener('abort', release);
          reader.releaseLock();
        }
      }
      init.body = chunks() as unknown as BodyInit;
      init.duplex = 'half';
    } else if (json !== undefined) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(json);
    } else if (request.method === 'GET') {
      for (const name of ['range', 'if-range', 'if-none-match', 'if-modified-since']) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
    }
    const upstream = await fetch(url, init);
    if (!upstream.ok && upstream.status !== 304) {
      // Only bounded, structured error messages cross the public boundary.
      let size = 0;
      const parts: Uint8Array[] = [];
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 8192) { await reader.cancel(); break; }
            parts.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      let message = 'File transfer could not be completed';
      try {
        const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
        const value = result.error ?? result.message;
        if (typeof value === 'string' && value.length <= 500) message = value;
      } catch { /* Keep the bounded public fallback. */ }
      throw inputError ?? new FileProxyError(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 503, message);
    }
    const responseHeaders = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    for (const name of forwardedHeaders) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    if (!upstream.body) { cleanup(); controller.abort(); return new Response(null, { status: upstream.status, headers: responseHeaders }); }
    const reader = upstream.body.getReader();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reader.releaseLock();
      controller.abort();
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { output.close(); finish(); }
          else output.enqueue(chunk.value);
        } catch (error) { output.error(error); finish(); }
      },
      async cancel(reason) {
        controller.abort(reason);
        // Abort may already have errored fetch's reader; that rejection is an
        // expected part of cancellation, not a second transfer failure.
        try { await reader.cancel(reason).catch(() => {}); } finally { finish(); }
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    cleanup(); controller.abort();
    if (inputError) throw inputError;
    if (error instanceof FileProxyError) throw error;
    if (request.signal.aborted) throw new FileProxyError(499, 'File transfer cancelled');
    if (controller.signal.reason instanceof FileProxyError) throw controller.signal.reason;
    throw new FileProxyError(503, 'File transfer is temporarily unavailable');
  }
}
