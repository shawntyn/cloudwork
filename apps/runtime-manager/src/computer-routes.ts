import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import { sameSecret } from '@cloud-work/computer';
import { HttpError, safeId } from './config.js';
import type { ComputerService } from './computer.js';

const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
export function registerComputer(app: FastifyInstance, computer: ComputerService) {
  const token = (header?: string) => header?.startsWith('Bearer ') ? header.slice(7) : '';
  app.post('/computer/mcp', async (request, reply) => {
    const scope = await computer.authorize(token(request.headers.authorization), 'run');
    const mcp = new McpServer({ name: 'cloud-work-computer', version: '1.0.0' });
    const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
    mcp.registerTool('start', { description: 'Delegate a graphical desktop/browser task. Use ONLY when GUI or browser interaction is needed; ordinary questions, file analysis and coding do not need a computer. This starts a persistent asynchronous task. Reuse requestId for transport retries. Poll status until completed before claiming success. Manual takeover stops the owning run. Workspace files appear under /workspace.', inputSchema: { requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), goal: z.string().min(1).max(16000) } }, async ({ requestId, goal }) => result({ ...await computer.start(scope, requestId, goal), pollCursor: randomUUID() }));
    mcp.registerTool('status', { description: 'Wait briefly for computer task progress. Continue polling active tasks; a queued/running task has not completed. Pass the latest returned pollCursor as cursor in the next status call. A confirmation needs user input. Never restart an interrupted task automatically or claim an unverified result.', inputSchema: { taskId: z.string(), cursor: z.string().max(100).optional(), waitSeconds: z.number().int().min(0).max(20).default(10) } }, async ({ taskId, waitSeconds }) => {
      let value = await computer.status(scope, taskId);
      if (['queued', 'running', 'confirmation'].includes(value.state)) { await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000)); await computer.parent(scope); value = await computer.status(scope, taskId); }
      return result({ ...value, pollCursor: randomUUID() });
    });
    mcp.registerTool('cancel', { description: 'Cancel a computer subtask without restarting it.', inputSchema: { taskId: z.string() } }, async ({ taskId }) => { await computer.task(scope, taskId); await computer.userTask(scope.userId, scope.workspaceId, taskId, 'cancel', ''); return result({ ok: true }); });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    const cleanup = () => { void Promise.allSettled([transport.close(), mcp.close()]); };
    reply.raw.once('close', cleanup);
    try { await mcp.connect(transport); await transport.handleRequest(request.raw, reply.raw, request.body); }
    catch { if (!reply.raw.headersSent) reply.raw.writeHead(400).end(); else reply.raw.destroy(); cleanup(); }
  });
  app.post('/computer/worker/claim', async request => {
    if (!sameSecret(token(request.headers.authorization), process.env.COMPUTER_RUNNER_TOKEN ?? '')) throw new HttpError(401, 'Unauthorized');
    return { task: await computer.claim(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(object(request.body).runnerId)) };
  });
  app.post<{ Params: { operation: string } }>('/computer/task/:operation', async (request, reply) => {
    const scope = await computer.authorize(token(request.headers.authorization), 'task');
    const body = request.body === undefined ? {} : object(request.body);
    switch (request.params.operation) {
      case 'heartbeat': return computer.heartbeat(scope);
      case 'screenshot': { const response = await computer.screenshot(scope); return reply.type('image/png').send(Buffer.from(await response.arrayBuffer())); }
      case 'action': return computer.action(scope, z.number().int().positive().parse(body.sequence), body.operation);
      case 'progress': return computer.progress(scope, z.object({ text: z.string().max(2000), inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) }).parse(body));
      case 'confirmation': return computer.confirmation(scope, body);
      case 'complete': return computer.complete(scope, z.string().max(16000).parse(body.result), z.boolean().parse(body.success));
      default: throw new HttpError(404, 'Not found');
    }
  });
  type Params = { userId: string; workspaceId: string };
  const base = '/internal/users/:userId/workspaces/:workspaceId/desktop';
  app.get<{ Params: Params }>(base, request => computer.view(safeId(request.params.userId), safeId(request.params.workspaceId)));
  app.post<{ Params: Params }>(base, async request => {
    const user = safeId(request.params.userId), workspace = safeId(request.params.workspaceId), body = object(request.body);
    switch (body.operation) {
      case 'start': return computer.ensure(user, workspace);
      case 'take': case 'release': return computer.manual(user, workspace, safeId(body.clientId), body.operation === 'take');
      case 'clipboard': return computer.manualInput(user, workspace, safeId(body.clientId), '', true);
      case 'input': return computer.manualInput(user, workspace, safeId(body.clientId), z.string().min(1).max(4000).parse(body.text));
      case 'stop': await computer.stopWorkspace(user, workspace); return computer.view(user, workspace);
      case 'approve': case 'steer': case 'cancel': return computer.userTask(user, workspace, safeId(body.taskId), body.operation, typeof body.value === 'string' ? body.value : '');
      default: throw new HttpError(400, 'Invalid desktop operation');
    }
  });
  app.post<{ Params: Params }>(`${base}/viewer`, request => {
    const body = object(request.body); return computer.viewer(safeId(request.params.userId), safeId(request.params.workspaceId), safeId(body.clientId), body.control === true);
  });
}
