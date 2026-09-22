import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import type { AgentRuntime } from '@cloud-work/runtime-core';
import { DshRuntime, parseMcpRunSnapshot } from '@cloud-work/runtime-dsh';
import { workspacePath, validateId, listFiles, readFileContent, writeFileContent, makeDirectory, renameEntry, deleteEntry } from '@cloud-work/workspace';
import { verifySandbox } from './sandbox.ts';
import { WorkspaceFileTransfers } from './file-transfer.ts';
import { FILE_TRANSFER_LIMITS } from '@cloud-work/protocol';
import { FileTransferError } from '@cloud-work/workspace';

const token = process.env.RUNTIME_TOKEN;
if (!token || token.length < 32) throw new Error('RUNTIME_TOKEN must contain at least 32 characters');
const tokenBytes = Buffer.from(`Bearer ${token}`);
const sandbox = verifySandbox();
const runtime: AgentRuntime = new DshRuntime();
const fileTransfers = new WorkspaceFileTransfers();
const sessionWorkspaces = new Map<string, string>();
const active = new Set<string>();
const operations = new Map<string, Promise<void>>();
const deletingWorkspaces = new Set<string>();
// Image-layer HOME directories are masked by the user's persistent bind mount.
await Promise.all(['.dsh', '.cache', '.config', '.npm', '.local/share/pnpm', 'workspaces'].map(directory =>
  mkdir(`/home/work/${directory}`, { recursive: true, mode: 0o700 })));

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function textField(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== 'string') throw new Error(`${key} must be a string`);
  return body[key];
}
async function body(req: IncomingMessage, maxBytes = 3 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) throw new FileTransferError('Request body exceeds its size limit', 413);
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
function authorized(req: IncomingMessage): boolean {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  return supplied.length === tokenBytes.length && timingSafeEqual(supplied, tokenBytes);
}

const server = createServer(async (req, res) => {
  req.setTimeout(30_000);
  try {
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
    const url = new URL(req.url ?? '/', 'http://runtime');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method;
    if (method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, sandbox, activeSessions: active.size, ...fileTransfers.activity });
    if (segments[0] === 'workspaces' && segments[1]) {
      const id = validateId(segments[1]);
      const root = workspacePath(id);
      if (deletingWorkspaces.has(id)) return json(res, 409, { error: 'Workspace is being removed' });
      if (segments.length === 2 && method === 'POST') {
        await mkdir(root, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        await listFiles(root); // Refuse an existing symlink or an invalid root.
        return json(res, 200, { ok: true });
      }
      if (segments.length === 2 && method === 'DELETE') {
        if ([...active].some(sessionId => sessionWorkspaces.get(sessionId) === id)) return json(res, 409, { error: 'Workspace has an active agent run' });
        deletingWorkspaces.add(id);
        try {
          await fileTransfers.cancelWorkspace(root);
          for (const [sessionId, workspaceId] of sessionWorkspaces) if (workspaceId === id) {
            await runtime.destroySession(sessionId);
            sessionWorkspaces.delete(sessionId);
          }
          await deleteEntry('/home/work/workspaces', id);
        } finally { deletingWorkspaces.delete(id); }
        return json(res, 200, { ok: true });
      }
      if (segments[2] === 'files' && segments.length <= 5) {
        if (await fileTransfers.handle(req, res, root, segments, url)) return;
        const relative = url.searchParams.get('path') ?? '';
        if (segments[3] === 'content' && method === 'GET') return json(res, 200, { content: await readFileContent(root, relative) });
        if (segments[3] === 'content' && method === 'PUT') {
          // A JSON string can expand each content byte to six escaped characters.
          const payload = await body(req, FILE_TRANSFER_LIMITS.maxTextBytes * 6 + 65536);
          await writeFileContent(root, textField(payload, 'path'), textField(payload, 'content'));
          return json(res, 200, { ok: true });
        }
        if (segments.length === 3 && method === 'GET') return json(res, 200, { entries: await listFiles(root, relative) });
        if (segments.length === 3 && method === 'DELETE') {
          await deleteEntry(root, relative);
          return json(res, 200, { ok: true });
        }
        if (segments.length === 3 && method === 'POST') {
          const payload = await body(req);
          if (payload.operation === 'mkdir') await makeDirectory(root, textField(payload, 'path'));
          else if (payload.operation === 'rename') await renameEntry(root, textField(payload, 'path'), textField(payload, 'to'));
          else throw new Error('Unsupported file operation');
          return json(res, 200, { ok: true });
        }
      }
    }
    if (segments[0] === 'sessions' && segments[1]) {
      const sessionId = validateId(segments[1]);
      if (!sessionId.startsWith('sess_')) throw new Error('Invalid session ID');
      if (segments.length === 2 && method === 'POST') {
        const payload = await body(req);
        const workspaceId = validateId(textField(payload, 'workspaceId'));
        if (deletingWorkspaces.has(workspaceId)) return json(res, 409, { error: 'Workspace is being removed' });
        const existing = sessionWorkspaces.get(sessionId);
        if (existing && existing !== workspaceId) return json(res, 409, { error: 'Session workspace cannot change' });
        if (!existing && sessionWorkspaces.size >= 128) {
          const disposable = [...sessionWorkspaces.keys()].find(id => !active.has(id));
          if (!disposable) return json(res, 409, { error: 'All session execution slots are busy' });
          // Remove routing before awaiting cleanup, so a concurrent request cannot revive it.
          sessionWorkspaces.delete(disposable);
          await runtime.destroySession(disposable);
        }
        await runtime.createSession({ sessionId, workspacePath: workspacePath(workspaceId) });
        sessionWorkspaces.set(sessionId, workspaceId);
        return json(res, 200, { sessionId });
      }
      if (segments[2] === 'cancel' && segments.length === 3 && method === 'POST') {
        await runtime.cancel(sessionId);
        await operations.get(sessionId);
        return json(res, 200, { ok: true });
      }
      if (segments[2] === 'run' && segments.length === 3 && method === 'POST') {
        const payload = await body(req);
        const prompt = textField(payload, 'prompt');
        if (Object.keys(payload).some(key => !['prompt', 'mcp'].includes(key))) throw new Error('Run request contains unsupported fields');
        const mcp = payload.mcp === undefined ? undefined : parseMcpRunSnapshot(payload.mcp);
        if (!prompt.trim() || prompt.length > 100_000) throw new Error('Prompt must contain 1 to 100000 characters');
        const workspaceId = sessionWorkspaces.get(sessionId);
        if (!workspaceId) return json(res, 404, { error: 'Session is not initialized' });
        if (active.has(sessionId) || deletingWorkspaces.has(workspaceId)) return json(res, 409, { error: 'Session is busy' });
        active.add(sessionId);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
        res.flushHeaders();
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 10_000);
        let completed = false;
        res.on('close', () => { if (!completed) void runtime.cancel(sessionId).catch(error => console.error('Execution cancellation failed:', error instanceof Error ? error.name : 'unknown')); });
        const operation = (async () => {
          try {
            for await (const event of runtime.run({ sessionId, prompt, mcp })) {
              if (res.destroyed) break;
              if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
            }
          } catch (error) {
            await runtime.cancel(sessionId);
            if (!res.destroyed) {
              res.write(`data: ${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Execution failed' })}\n\n`);
              res.write('data: {"type":"status","status":"error"}\n\n');
            }
          } finally {
            completed = true;
            clearInterval(heartbeat);
            active.delete(sessionId);
            operations.delete(sessionId);
            res.end();
          }
        })();
        operations.set(sessionId, operation);
        await operation;
        return;
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    if (res.headersSent) return res.destroy();
    if (res.destroyed) return;
    const code = (error as NodeJS.ErrnoException).code;
    if (!req.complete) res.setHeader('connection', 'close');
    json(res, error instanceof FileTransferError ? error.status : code === 'ENOENT' ? 404 : 400, { error: error instanceof Error ? error.message : 'Request failed' });
  }
});
server.requestTimeout = FILE_TRANSFER_LIMITS.timeoutMs;
server.headersTimeout = 15_000;
server.listen(3080, '0.0.0.0', () => console.log(`Runtime ready on 3080; sandbox=${sandbox.backend}/${sandbox.enforcement}`));
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await fileTransfers.close();
  await Promise.allSettled([...sessionWorkspaces.keys()].map(id => runtime.destroySession(id)));
  await Promise.allSettled(operations.values());
  server.closeAllConnections();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
