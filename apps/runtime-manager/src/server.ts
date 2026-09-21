import Fastify from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db, agentSessions } from '@cloud-work/database';
import { HttpError, safeId, secureEqual } from './config.js';
import { leaseKinds, type LeaseKind } from './leases.js';
import type { RuntimeManager } from './lifecycle.js';
import { ownedSession, ownedWorkspace, responseJson, workspaceDeleted, workspaceLock, type Runs } from './runs.js';

type Params = { userId: string; workspaceId: string; sessionId: string; connectionId: string; kind: string; leaseId: string };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'JSON object required');
  return value as Record<string, unknown>;
};

export function createServer(manager: RuntimeManager, runs: Runs) {
  const app = Fastify({ logger: true, bodyLimit: 3 * 1024 * 1024, requestTimeout: 180_000 });
  let ready = false, startupError: string | undefined;
  app.setErrorHandler((error, request, reply) => {
    const known: Error & { statusCode?: number } = error instanceof Error ? error : new Error('Unexpected manager error');
    const status = typeof known.statusCode === 'number' ? known.statusCode : 500;
    if (status >= 500) request.log.error(error);
    return reply.code(status).send({ error: status < 500 || error instanceof HttpError ? known.message : 'Runtime manager operation failed; check service logs' });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    if (!secureEqual(request.headers.authorization ?? '', `Bearer ${manager.config.managerToken}`)) return reply.code(401).send({ error: 'Unauthorized' });
    if (!ready) return reply.code(503).send({ error: 'Runtime manager is initializing' });
  });
  app.get('/health', async (_request, reply) => {
    if (!ready) return reply.code(503).send({ ok: false, status: startupError ? 'error' : 'initializing' });
    try { await manager.leases.redis.ping(); await manager.docker.ping(); return { ok: true }; }
    catch { return reply.code(503).send({ ok: false, status: 'unavailable' }); }
  });
  const base = '/internal/users/:userId';
  app.post<{ Params: Params }>(`${base}/ensure`, request => manager.ensureRuntime(safeId(request.params.userId)));
  app.get<{ Params: Params }>(`${base}/status`, request => manager.getRuntimeStatus(safeId(request.params.userId)));
  app.post<{ Params: Params }>(`${base}/stop`, request => manager.stopRuntime(safeId(request.params.userId)));
  app.post<{ Params: Params }>(`${base}/remove`, request => manager.removeRuntime(safeId(request.params.userId)));
  app.post<{ Params: Params }>(`${base}/touch`, async request => { await manager.touchRuntime(safeId(request.params.userId)); return { ok: true }; });

  async function checkWorkspace(userId: string, workspaceId: string) {
    await ownedWorkspace(userId, workspaceId);
    if (await manager.leases.redis.exists(workspaceDeleted(workspaceId))) throw new HttpError(410, 'Workspace was deleted');
  }

  for (const method of ['GET', 'POST'] as const) {
    app.route<{ Params: Params }>({ method, url: `${base}/mcp/connections`, handler: request => manager.mcp.request(
      safeId(request.params.userId), '/mcp/connections', method, method === 'POST' ? object(request.body) : undefined,
    ) });
  }
  for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
    app.route<{ Params: Params }>({ method, url: `${base}/mcp/connections/:connectionId`, handler: request => manager.mcp.request(
      safeId(request.params.userId), `/mcp/connections/${safeId(request.params.connectionId)}`, method, method === 'PATCH' ? object(request.body) : undefined,
    ) });
  }
  app.post<{ Params: Params }>(`${base}/mcp/connections/:connectionId/test`, request => {
    const user = safeId(request.params.userId), id = safeId(request.params.connectionId);
    return manager.withActivity(user, () => manager.mcp.request(user, `/mcp/connections/${id}/test`, 'POST', undefined, 90_000), false);
  });
  for (const method of ['GET', 'PUT'] as const) {
    app.route<{ Params: Params }>({ method, url: `${base}/workspaces/:workspaceId/mcp`, handler: async request => {
      const user = safeId(request.params.userId), workspace = safeId(request.params.workspaceId);
      const body = method === 'PUT' ? object(request.body) : undefined;
      if (body && (!Array.isArray(body.connectionIds) || body.connectionIds.length > 100)) throw new HttpError(400, 'connectionIds must be an array of at most 100 identifiers');
      const data = body ? { connectionIds: [...new Set((body.connectionIds as unknown[]).map(safeId))] } : undefined;
      return manager.leases.withLock(workspaceLock(workspace), async () => {
        await checkWorkspace(user, workspace);
        return manager.mcp.request(user, `/workspaces/${workspace}/mcp`, method, data);
      });
    } });
  }

  app.post<{ Params: Params }>(`${base}/workspaces/:workspaceId`, async request => {
    const user = safeId(request.params.userId), workspace = safeId(request.params.workspaceId);
    return manager.leases.withLock(workspaceLock(workspace), async () => {
      await checkWorkspace(user, workspace);
      return manager.withActivity(user, async () => responseJson(await manager.request(user, `/workspaces/${workspace}`, { method: 'POST' })));
    });
  });
  app.delete<{ Params: Params }>(`${base}/workspaces/:workspaceId`, async request => {
    const user = safeId(request.params.userId), workspace = safeId(request.params.workspaceId);
    return manager.leases.withLock(workspaceLock(workspace), async () => {
      await ownedWorkspace(user, workspace);
      if (await manager.leases.redis.get(workspaceDeleted(workspace)) === 'deleted') return { ok: true };
      const running = await db.select().from(agentSessions).where(and(eq(agentSessions.workspaceId, workspace), eq(agentSessions.status, 'running'))).limit(1);
      if (running.length) throw new HttpError(409, 'Stop active agents before deleting this workspace');
      await manager.leases.redis.set(workspaceDeleted(workspace), 'deleting', 'EX', 7 * 24 * 3600);
      try {
        const result = await manager.withActivity(user, async () => {
          const response = await manager.request(user, `/workspaces/${workspace}`, { method: 'DELETE' });
          // A retry after the runtime removed files but its HTTP response was lost is idempotent.
          if (response.status === 404) { await response.body?.cancel(); return { ok: true }; }
          return responseJson(response);
        });
        await manager.leases.redis.set(workspaceDeleted(workspace), 'deleted', 'EX', 7 * 24 * 3600);
        return result;
      } catch (error) { await manager.leases.redis.del(workspaceDeleted(workspace)); throw error; }
    });
  });

  for (const method of ['GET', 'PUT', 'POST', 'DELETE'] as const) {
    const suffixes = method === 'GET' || method === 'PUT' ? method === 'GET' ? ['/files', '/files/content'] : ['/files/content'] : ['/files'];
    for (const suffix of suffixes) app.route<{ Params: Params; Querystring: { path?: string } }>({
      method, url: `${base}/workspaces/:workspaceId${suffix}`,
      handler: async request => {
        const user = safeId(request.params.userId), workspace = safeId(request.params.workspaceId);
        return manager.leases.withLock(workspaceLock(workspace), async () => {
          await checkWorkspace(user, workspace);
          const query = new URLSearchParams();
          if (request.query.path !== undefined) {
            if (typeof request.query.path !== 'string') throw new HttpError(400, 'Path must be a string');
            query.set('path', request.query.path);
          }
          return manager.withActivity(user, async () => responseJson(await manager.request(user, `/workspaces/${workspace}${suffix}?${query}`, {
            method, ...(method === 'PUT' || method === 'POST' ? { body: JSON.stringify(object(request.body)) } : {}),
          })));
        });
      },
    });
  }

  app.post<{ Params: Params }>(`${base}/sessions/:sessionId`, async request => {
    const user = safeId(request.params.userId), id = safeId(request.params.sessionId), body = object(request.body);
    const session = await ownedSession(user, id);
    if (safeId(body.workspaceId) !== session.workspaceId) throw new HttpError(400, 'Session workspace mismatch');
    return manager.leases.withLock(workspaceLock(session.workspaceId), async () => {
      await checkWorkspace(user, session.workspaceId);
      return manager.withActivity(user, async () => {
        await responseJson(await manager.request(user, `/workspaces/${session.workspaceId}`, { method: 'POST' }));
        return responseJson(await manager.request(user, `/sessions/${id}`, { method: 'POST', body: JSON.stringify({ workspaceId: session.workspaceId }) }));
      });
    });
  });
  app.post<{ Params: Params }>(`${base}/sessions/:sessionId/messages`, async (request, reply) => {
    const body = object(request.body);
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 100_000) throw new HttpError(400, 'Prompt must contain 1–100000 characters');
    await runs.launch(safeId(request.params.userId), safeId(request.params.sessionId), body.prompt);
    return reply.code(202).send({ accepted: true });
  });
  app.post<{ Params: Params }>(`${base}/sessions/:sessionId/cancel`, request => runs.cancel(safeId(request.params.userId), safeId(request.params.sessionId)));

  // Internal callers explicitly register/renew finite leases; runtime containers cannot authorize these APIs.
  app.post<{ Params: Params }>(`${base}/leases/:kind/:leaseId`, async request => {
    const user = safeId(request.params.userId), id = safeId(request.params.leaseId), kind = request.params.kind as LeaseKind;
    if (!leaseKinds.includes(kind) || kind === 'active-agent-tasks') throw new HttpError(400, 'Unsupported externally managed lease kind');
    const body = request.body === undefined ? {} : object(request.body);
    const ttlMs = Number(body.ttlMs ?? manager.config.leaseMs);
    if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 86_400_000) throw new HttpError(400, 'Lease TTL must be between 1 second and 24 hours');
    await manager.leases.withUserLock(user, async () => {
      await manager.leases.setBusy(user, kind, id, ttlMs);
      await manager.touchRuntime(user);
    });
    return { ok: true, leaseId: id, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
  });
  app.delete<{ Params: Params }>(`${base}/leases/:kind/:leaseId`, async request => {
    const kind = request.params.kind as LeaseKind;
    if (!leaseKinds.includes(kind) || kind === 'active-agent-tasks') throw new HttpError(400, 'Unsupported externally managed lease kind');
    await manager.leases.clearBusy(safeId(request.params.userId), kind, safeId(request.params.leaseId));
    return { ok: true };
  });
  return { app, setReady: () => { ready = true; }, setStartupError: (error: unknown) => { startupError = String(error); app.log.error(error, 'Runtime initialization failed'); } };
}
