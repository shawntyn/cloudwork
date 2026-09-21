import type { McpRunSnapshot } from '@cloud-work/protocol';
import { HttpError, mcpControlAlias, safeId, type Config } from './config.js';

const responseLimit = 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(502, 'Invalid MCP gateway response');
  return value as Record<string, unknown>;
};

/** Only fixed service routes may be fetched here. Upstream MCP URLs belong to the gateway. */
export class McpGateway {
  constructor(private config: Config, private fetcher: typeof fetch = fetch) {}

  async request(userId: string, suffix: string, method = 'GET', body?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.config.mcpGatewayAdminToken) throw new HttpError(503, 'MCP gateway is not configured');
    if (!/^\/(?:mcp\/connections(?:\/[A-Za-z0-9_-]{1,100}(?:\/test)?)?|workspaces\/[A-Za-z0-9_-]{1,100}\/mcp|runs\/[A-Za-z0-9_-]{1,100}\/mcp(?:\/renew)?)$/.test(suffix)) throw new Error('Invalid MCP gateway route');
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.mcpGatewayUrl}/internal/users/${safeId(userId)}${suffix}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${this.config.mcpGatewayAdminToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new HttpError(502, 'MCP gateway is unavailable'); }
    if (!response.ok) {
      await response.body?.cancel();
      // Never expose upstream headers, credential-bearing URLs or arbitrary response text.
      throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, `MCP gateway request failed (HTTP ${response.status})`);
    }
    if (response.status === 204) return { ok: true };
    const reader = response.body?.getReader();
    if (!reader) throw new HttpError(502, 'Empty MCP gateway response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > responseLimit) { await reader.cancel(); throw new HttpError(502, 'MCP gateway response is too large'); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'Invalid MCP gateway response');
    } finally { reader.releaseLock(); }
  }

  async snapshot(userId: string, runId: string, workspaceId: string, sessionId: string): Promise<McpRunSnapshot> {
    const payload = record(await this.request(userId, `/runs/${safeId(runId)}/mcp`, 'POST', { workspaceId: safeId(workspaceId), sessionId: safeId(sessionId) }));
    const snapshot = record(payload.snapshot);
    if (snapshot.runId !== runId || typeof snapshot.revision !== 'string' || snapshot.revision.length > 200 || !Array.isArray(snapshot.connections) || snapshot.connections.length > 100) throw new HttpError(502, 'Invalid MCP run snapshot');
    const seen = new Set<string>();
    const connections = snapshot.connections.map(value => {
      const entry = record(value);
      if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.id) || typeof entry.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.serverName) || seen.has(entry.serverName) || typeof entry.path !== 'string' || !/^\/mcp\/[A-Za-z0-9_-]{1,200}$/.test(entry.path) || typeof entry.token !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(entry.token)) throw new HttpError(502, 'Invalid MCP run connection');
      seen.add(entry.serverName);
      return { id: entry.id, serverName: entry.serverName, url: `http://${mcpControlAlias(userId)}:4100${entry.path}`, token: entry.token };
    });
    return { runId, revision: snapshot.revision, connections };
  }

  async renew(userId: string, runId: string) { await this.request(userId, `/runs/${safeId(runId)}/mcp/renew`, 'POST'); }
  async revoke(userId: string, runId: string) { await this.request(userId, `/runs/${safeId(runId)}/mcp`, 'DELETE'); }
}
