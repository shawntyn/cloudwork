import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FILE_TRANSFER_LIMITS } from '@cloud-work/protocol';
import { HttpError, safeId } from './config.js';
import type { RuntimeManager } from './lifecycle.js';
import { workspaceLock } from './runs.js';

type TransferParams = { userId: string; workspaceId: string; batchId?: string };
type TransferQuery = { path?: string; conflict?: string; archive?: string; inline?: string };
type TransferRequest = FastifyRequest<{ Params: TransferParams; Querystring: TransferQuery }>;
type TransferManager = Pick<RuntimeManager, 'request' | 'withActivity'> & {
  leases: Pick<RuntimeManager['leases'], 'withLock'>;
};
const responseHeaders = ['content-type', 'content-disposition', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'x-content-type-options'] as const;

/** Keep lifecycle leases and the workspace lock until bytes finish, not just fetch headers. */
async function transfer(
  manager: TransferManager, checkWorkspace: (user: string, workspace: string) => Promise<void>,
  request: TransferRequest, reply: FastifyReply, suffix: string,
) {
  const user = safeId(request.params.userId), workspace = safeId(request.params.workspaceId);
  const controller = new AbortController();
  const disconnect = () => { if (!reply.raw.writableFinished) controller.abort(new Error('File transfer disconnected')); };
  const timeout = setTimeout(() => controller.abort(new HttpError(504, 'File transfer timed out')), FILE_TRANSFER_LIMITS.timeoutMs);
  timeout.unref();
  request.raw.once('aborted', disconnect);
  reply.raw.once('close', disconnect);
  let uploadError: HttpError | undefined;
  try {
    if (request.raw.aborted || reply.raw.destroyed) disconnect();
    const query = new URLSearchParams();
    for (const key of ['path', 'conflict', 'archive', 'inline'] as const) {
      const value = request.query[key];
      if (value !== undefined) {
        if (typeof value !== 'string') throw new HttpError(400, `${key} must be a string`);
        query.set(key, value);
      }
    }
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    for (const key of ['range', 'if-range', 'if-none-match', 'if-modified-since'] as const) {
      const value = request.headers[key];
      if (typeof value === 'string') headers[key] = value;
    }
    const init: RequestInit & { duplex?: 'half' } = { method: request.method, signal: controller.signal, headers };
    if (request.method === 'PUT') {
      const declared = request.headers['content-length'];
      if (declared !== undefined) {
        if (!/^\d+$/.test(declared) || Number(declared) > FILE_TRANSFER_LIMITS.maxFileBytes) throw new HttpError(413, 'File exceeds the upload size limit');
        headers['content-length'] = declared;
      }
      if (!(request.body instanceof Readable)) throw new HttpError(415, 'Upload requires application/octet-stream');
      headers['content-type'] = 'application/octet-stream';
      const source = request.body;
      // Do not destroy the client socket when an upstream rejects an upload early: it
      // must remain writable long enough to return the conflict/validation response.
      async function* chunks() {
        let size = 0;
        for await (const chunk of source.iterator({ destroyOnReturn: false })) {
          controller.signal.throwIfAborted();
          size += Buffer.byteLength(chunk);
          if (size > FILE_TRANSFER_LIMITS.maxFileBytes) {
            uploadError = new HttpError(413, 'File exceeds the upload size limit');
            throw uploadError;
          }
          yield chunk;
        }
      }
      init.body = chunks() as unknown as BodyInit;
      init.duplex = 'half';
    } else if (request.method === 'POST') {
      if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new HttpError(400, 'JSON object required');
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(request.body);
    }
    await manager.leases.withLock(workspaceLock(workspace), async () => {
      controller.signal.throwIfAborted();
      await checkWorkspace(user, workspace);
      controller.signal.throwIfAborted();
      await manager.withActivity(user, async () => {
        controller.signal.throwIfAborted();
        const response = await manager.request(user, `/workspaces/${workspace}/files${suffix}?${query}`, init, FILE_TRANSFER_LIMITS.timeoutMs);
        controller.signal.throwIfAborted();
        for (const key of responseHeaders) {
          const value = response.headers.get(key);
          if (value !== null) reply.raw.setHeader(key, value);
        }
        if (!request.raw.complete) reply.raw.setHeader('connection', 'close');
        reply.raw.statusCode = response.status;
        reply.hijack();
        if (response.body) {
          await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), reply.raw, { signal: controller.signal });
        } else {
          const complete = finished(reply.raw);
          reply.raw.end();
          await complete;
        }
      });
    });
  } catch (error) {
    if (reply.raw.headersSent || reply.sent || reply.raw.destroyed) {
      if (!reply.raw.writableFinished) reply.raw.destroy(error instanceof Error ? error : undefined);
      return;
    }
    if (!request.raw.complete) reply.header('connection', 'close');
    throw uploadError ?? (controller.signal.aborted ? controller.signal.reason : error);
  } finally {
    clearTimeout(timeout);
    request.raw.off('aborted', disconnect);
    reply.raw.off('close', disconnect);
    // Cancels unfinished upstream input/readers, including an early error response.
    controller.abort();
  }
}

export function registerFileTransfers(app: FastifyInstance, manager: TransferManager, checkWorkspace: (user: string, workspace: string) => Promise<void>) {
  const base = '/internal/users/:userId/workspaces/:workspaceId/files';
  app.post<{ Params: TransferParams; Querystring: TransferQuery }>(`${base}/uploads`, (request, reply) => transfer(manager, checkWorkspace, request, reply, '/uploads'));
  app.delete<{ Params: TransferParams; Querystring: TransferQuery }>(`${base}/uploads/:batchId`, (request, reply) => transfer(manager, checkWorkspace, request, reply, `/uploads/${safeId(request.params.batchId)}`));
  app.get<{ Params: TransferParams; Querystring: TransferQuery }>(`${base}/download`, (request, reply) => transfer(manager, checkWorkspace, request, reply, '/download'));
  void app.register(async scope => {
    // Encapsulation prevents binary streams being accepted by ordinary JSON routes.
    scope.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    scope.put<{ Params: TransferParams; Querystring: TransferQuery }>(`${base}/uploads/:batchId`, (request, reply) => transfer(manager, checkWorkspace, request, reply, `/uploads/${safeId(request.params.batchId)}`));
  });
}
