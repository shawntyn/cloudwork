import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ListToolsResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { redactSecrets } from './crypto.js';
import { createNetwork, DestinationPolicy, GatewayError } from './policy.js';

export type UpstreamTool = Pick<Tool, 'name' | 'description' | 'inputSchema' | 'outputSchema' | 'annotations'>;
const timeout = 60_000;
const validName = (name: string) => /^[A-Za-z0-9_.-]{1,128}$/.test(name);

function boundedJson(value: unknown, maximum: number, depthLimit = 32) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 16_384 || current.depth > depthLimit) throw new Error('JSON complexity limit exceeded');
    if (current.value && typeof current.value === 'object') {
      for (const nested of Object.values(current.value)) pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > maximum) throw new Error('JSON size limit exceeded');
}

export class Upstream {
  private readonly lifecycle = new AbortController();
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private readonly network: ReturnType<typeof createNetwork>;
  private readonly headers: Record<string, string>;
  private connecting?: Promise<void>;
  private closing?: Promise<void>;
  private active = 0;

  constructor(policy: DestinationPolicy, url: string, headers: Record<string, string>) {
    this.headers = { ...headers };
    this.network = createNetwork(policy, url, this.lifecycle.signal);
    this.client = new Client({ name: 'cloud-work-mcp-gateway', version: '0.1.0' }, {
      capabilities: {},
    });
    this.transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: this.network.fetch, requestInit: { headers: this.headers },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    // Error messages from an upstream can contain its URL or authentication headers.
    this.client.onerror = () => {};
  }

  private async connect() {
    if (!this.connecting) {
      this.connecting = this.client.connect(this.transport, {
        signal: AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(timeout)]),
        timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false,
      });
    }
    await this.connecting;
  }

  private async operation<T>(perform: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.lifecycle.signal.aborted) throw new GatewayError(410, 'MCP connection is closed');
    if (this.active >= 4) throw new GatewayError(429, 'MCP connection has too many active requests');
    this.active++;
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(timeout)]);
    try {
      await this.connect();
      signal.throwIfAborted();
      const result = await perform(signal);
      signal.throwIfAborted();
      const redacted = redactSecrets(result, this.headers);
      boundedJson(redacted, 2 * 1024 * 1024);
      return redacted;
    } catch {
      throw new GatewayError(502, 'MCP service request failed');
    } finally { this.active--; }
  }

  async listTools(): Promise<UpstreamTool[]> {
    return this.operation(async signal => {
      const tools: UpstreamTool[] = [];
      const names = new Set<string>(), cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        // Client.listTools compiles arbitrary output schemas before count/size checks.
        // The broker forwards bounded schemas; validation against them belongs to the tenant client.
        const page = await this.client.request({ method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) }, ListToolsResultSchema, { signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false });
        if (tools.length + page.tools.length > 128) throw new Error('Tool count limit exceeded');
        for (const tool of page.tools) {
          if (!validName(tool.name) || names.has(tool.name) || (tool.description?.length ?? 0) > 4096) throw new Error('Invalid tool metadata');
          boundedJson(tool.inputSchema, 64 * 1024);
          if (tool.outputSchema) boundedJson(tool.outputSchema, 64 * 1024);
          if (tool.annotations) boundedJson(tool.annotations, 8192);
          names.add(tool.name);
          tools.push({ name: tool.name, inputSchema: tool.inputSchema, ...(tool.description === undefined ? {} : { description: tool.description }), ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }), ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }) });
        }
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (!cursor || cursor.length > 1024 || cursors.has(cursor) || cursors.size >= 128) throw new Error('Invalid pagination');
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      boundedJson(tools, 2 * 1024 * 1024);
      return tools;
    });
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    if (!validName(name) || (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args)))) throw new GatewayError(400, 'Invalid MCP tool request');
    try { if (args) boundedJson(args, 256 * 1024); }
    catch { throw new GatewayError(400, 'MCP tool arguments exceed the supported limits'); }
    return this.operation(async signal => {
      const result = CallToolResultSchema.parse(await this.client.callTool({ name, ...(args === undefined ? {} : { arguments: args }) }, CallToolResultSchema, { signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false }));
      boundedJson(result, 2 * 1024 * 1024);
      return result;
    });
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.lifecycle.abort(new Error('MCP connection closed'));
      this.closing = (async () => {
        try { await this.client.close(); } catch { /* The transport may already have failed. */ }
        await this.network.close();
      })();
    }
    await this.closing;
  }
}
