import Fastify from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { secureEqual } from './crypto.ts';
import { GatewayError, DestinationPolicy } from './policy.ts';
import { Store, summary, type Grant } from './store.ts';
import { Upstream } from './upstream.ts';
import { bindingInput, connectionInput, connectionPatch, parse, runInput, safeId } from './validation.ts';

export function createServer(policy: DestinationPolicy, key: Buffer, adminToken: string) {
  if (adminToken.length < 32) throw new Error('MCP_GATEWAY_ADMIN_TOKEN must contain at least 32 characters');
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, requestTimeout: 70_000 });
  const clients = new Map<string, Upstream>();
  const closeGrants = async (ids: string[]) => {
    await Promise.allSettled(ids.map(async id => { const client = clients.get(id); clients.delete(id); await client?.close(); }));
  };
  const store = new Store(policy, key, closeGrants);
  const client = (grant: Grant) => {
    let upstream = clients.get(grant.id);
    if (!upstream) {
      if (clients.size >= 256) throw new GatewayError(429, 'MCP gateway is busy');
      upstream = new Upstream(policy, grant.url, store.grantHeaders(grant));
      clients.set(grant.id, upstream);
    }
    return upstream;
  };
  const checkedClient = async (authorize: () => Promise<Grant>) => {
    const grant = await authorize();
    const upstream = client(grant);
    // Register lifecycle first, then recheck: revocation must also cover a client
    // constructed after its initial authorization query completed.
    try { await authorize(); return upstream; }
    catch (error) { await closeGrants([grant.id]); throw error; }
  };
  app.setErrorHandler((error, _request, reply) => {
    const frameworkCode = (error as { statusCode?: number })?.statusCode;
    const status = error instanceof GatewayError ? error.statusCode : typeof frameworkCode === 'number' && frameworkCode < 500 ? frameworkCode : 500;
    reply.code(status).send({ error: error instanceof GatewayError ? error.message : status < 500 ? 'Invalid MCP request' : 'MCP gateway request failed' });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/internal/') && !secureEqual(request.headers.authorization ?? '', `Bearer ${adminToken}`)) return reply.code(401).send({ error: 'Unauthorized' });
  });
  app.get('/health', async () => ({ ok: true }));
  const root = '/internal/users/:userId';
  type Params = { userId: string; id: string; workspaceId: string; runId: string };
  const ids = (params: unknown) => {
    const input = params as Params;
    for (const value of Object.values(input)) parse(safeId, value);
    return input;
  };
  app.get(`${root}/mcp/connections`, async request => store.list(ids(request.params).userId));
  app.post(`${root}/mcp/connections`, async request => ({ connection: await store.create(ids(request.params).userId, parse(connectionInput, request.body)) }));
  app.get(`${root}/mcp/connections/:id`, async request => { const { userId, id } = ids(request.params); return { connection: summary(await store.connection(userId, id)) }; });
  app.patch(`${root}/mcp/connections/:id`, async request => { const { userId, id } = ids(request.params); return { connection: await store.update(userId, id, parse(connectionPatch, request.body)) }; });
  app.delete(`${root}/mcp/connections/:id`, async request => { const { userId, id } = ids(request.params); await store.remove(userId, id); return { ok: true }; });
  const tests = new Set<string>();
  app.post(`${root}/mcp/connections/:id/test`, async request => {
    const { userId, id } = ids(request.params);
    if (tests.has(userId) || tests.size >= 32) throw new GatewayError(429, 'A connection test is already running');
    const row = await store.connection(userId, id);
    tests.add(userId);
    let upstream: Upstream | undefined;
    try {
      upstream = new Upstream(policy, row.url, store.headers(row));
      const tools = await upstream.listTools();
      return { connection: await store.testResult(row, tools.map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })), null) };
    } catch (error) {
      const message = error instanceof GatewayError && error.statusCode === 400 ? error.message : 'Connection failed. Check the service address, credentials and platform access policy.';
      return { connection: await store.testResult(row, [], message) };
    } finally { tests.delete(userId); await upstream?.close(); }
  });
  app.get(`${root}/workspaces/:workspaceId/mcp`, async request => { const { userId, workspaceId } = ids(request.params); return store.bindings(userId, workspaceId); });
  app.put(`${root}/workspaces/:workspaceId/mcp`, async request => { const { userId, workspaceId } = ids(request.params); return store.bind(userId, workspaceId, parse(bindingInput, request.body).connectionIds); });
  app.post(`${root}/runs/:runId/mcp`, async request => { const { userId, runId } = ids(request.params), input = parse(runInput, request.body); return store.issue(userId, runId, input.workspaceId, input.sessionId); });
  app.post(`${root}/runs/:runId/mcp/renew`, async request => { const { userId, runId } = ids(request.params); await store.renew(userId, runId); return { ok: true }; });
  app.delete(`${root}/runs/:runId/mcp`, async request => { const { userId, runId } = ids(request.params); await store.revoke(userId, runId); return { ok: true }; });
  let activeRequests = 0;
  app.all<{ Params: { grantId: string } }>('/mcp/:grantId', async (request, reply) => {
    parse(safeId, request.params.grantId);
    const token = /^Bearer ([A-Za-z0-9_-]{32,512})$/.exec(request.headers.authorization ?? '')?.[1];
    if (!token) throw new GatewayError(401, 'Unauthorized');
    const authorize = () => store.authorize(request.params.grantId, token);
    await authorize();
    if (activeRequests >= 128) throw new GatewayError(429, 'MCP gateway is busy');
    activeRequests++;
    const server = new Server({ name: 'cloud-work-mcp-gateway', version: '0.1.0' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await (await checkedClient(authorize)).listTools();
      await authorize();
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async message => {
      await authorize();
      try {
        const result = await (await checkedClient(authorize)).callTool(message.params.name, message.params.arguments);
        await authorize(); // A removed binding cannot complete a late result into the model.
        return result;
      } catch {
        return { content: [{ type: 'text' as const, text: 'MCP tool request failed or its authorization was revoked.' }], isError: true };
      }
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true; activeRequests--;
      void server.close().catch(() => {});
    };
    reply.raw.once('close', close);
    try {
      await server.connect(transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch { if (!reply.raw.headersSent) reply.raw.writeHead(502, { 'Content-Type': 'application/json' }); reply.raw.end(JSON.stringify({ error: 'MCP transport failed' })); close(); }
  });
  const cleanup = setInterval(() => { void store.expire([...clients.keys()]).catch(() => console.error('MCP grant cleanup failed')); }, 30_000);
  cleanup.unref();
  app.addHook('onClose', async () => { clearInterval(cleanup); await closeGrants([...clients.keys()]); });
  return app;
}
