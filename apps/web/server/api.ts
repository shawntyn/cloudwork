import { auth } from '@cloud-work/auth';
import { relativeParts } from '@cloud-work/workspace';
import { db, workspaces, agentSessions } from '@cloud-work/database';
import { and, eq, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { ZodError, z } from 'zod';
export class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
const statusCode: Record<number, string> = { 400: 'INVALID_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE' };
export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
let client: Redis | undefined;
export function redis() { return client ??= new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 2, lazyConnect: true }); }
export async function currentUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new ApiError(401, 'Please sign in to continue');
  return session.user;
}
export function safeOrigin(request: Request, contentType = 'application/json') {
  if (['GET','HEAD','OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  const expected = new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').origin;
  if (origin && origin !== expected) throw new ApiError(403, 'Request origin is not allowed');
  if (request.headers.get('content-type') && request.headers.get('content-type')!.split(';')[0]!.trim().toLowerCase() !== contentType) throw new ApiError(415, `Use ${contentType}`);
}
export function api(fn: (request: Request) => Promise<Response>, options: { contentType?: string } = {}) {
  return async (request: Request) => {
    try { safeOrigin(request, options.contentType); return await fn(request); }
    catch (error) {
      if (error instanceof ApiError) return Response.json({ error: error.message, code: error.code ?? statusCode[error.status] ?? 'REQUEST_FAILED' }, { status: error.status });
      if (error instanceof ZodError || error instanceof SyntaxError) return Response.json({ error: 'Invalid request data', code: 'INVALID_REQUEST' }, { status: 400 });
      console.error('API request failed:', error);
      return Response.json({ error: 'The request could not be completed. Please try again.', code: 'INTERNAL_ERROR' }, { status: 500 });
    }
  };
}
export async function body(request: Request, limit = 3 * 1024 * 1024) {
  if (Number(request.headers.get('content-length')) > limit) throw new ApiError(413, 'Request is too large');
  if (!request.body) throw new ApiError(400, 'JSON body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ApiError(413, 'Request is too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function validatePath(value: string, allowRoot = false) {
  try { return relativeParts(value,allowRoot); }
  catch { throw new ApiError(400, 'Path must be relative and stay inside the workspace', 'INVALID_PATH'); }
}
export async function ownedWorkspace(userId: string, id: string) {
  idSchema.parse(id);
  const [workspace] = await db.select().from(workspaces).where(and(eq(workspaces.id,id), eq(workspaces.userId,userId), isNull(workspaces.deletedAt))).limit(1);
  if (!workspace) throw new ApiError(404, 'Workspace not found', 'WORKSPACE_NOT_FOUND');
  return workspace;
}
export async function ownedSession(userId: string, id: string) {
  idSchema.parse(id);
  const [session] = await db.select().from(agentSessions).where(and(eq(agentSessions.id,id), eq(agentSessions.userId,userId))).limit(1);
  if (!session) throw new ApiError(404, 'Session not found', 'SESSION_NOT_FOUND');
  await ownedWorkspace(userId, session.workspaceId);
  return session;
}
export async function manager(userId: string, suffix: string, method = 'GET', data?: unknown): Promise<any> {
  idSchema.parse(userId);
  const response = await fetch(`${process.env.RUNTIME_MANAGER_URL ?? 'http://localhost:4000'}/internal/users/${userId}${suffix}`, {
    method, headers: { authorization: `Bearer ${process.env.MANAGER_TOKEN}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), cache: 'no-store', signal: AbortSignal.timeout(180000),
  });
  const result = await response.json().catch(() => ({ error: 'Runtime manager returned an invalid response' }));
  if (!response.ok) throw new ApiError(response.status >= 400 && response.status < 500 ? response.status : 503, result.error ?? result.message ?? 'Runtime is unavailable');
  return result;
}
export async function rateLimit(userId: string, kind: string, max = 120) {
  const key = `rate:${kind}:${userId}:${Math.floor(Date.now()/60000)}`;
  const count = await redis().incr(key);
  if (count === 1) await redis().expire(key, 90);
  if (count > max) throw new ApiError(429, 'Too many requests. Please wait a minute.');
}
