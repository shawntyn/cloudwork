import { db, agentSessions, workspaces } from '@cloud-work/database';
import { and, desc, eq, ilike, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { api, ApiError, currentUser, idSchema, ownedWorkspace } from '@/server/api';
import { sessionSummary } from './summary';

export const dynamic = 'force-dynamic';

type Cursor = { pinned: 0 | 1; at: string; id: string };

function parseCursor(raw: string | null): Cursor | null {
  if (raw === null) return null;
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new ApiError(400, 'Invalid session cursor');
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object') throw new Error('Invalid cursor');
    const cursor = value as Record<string, unknown>;
    if ((cursor.pinned !== 0 && cursor.pinned !== 1) || typeof cursor.at !== 'string' || typeof cursor.id !== 'string') throw new Error('Invalid cursor');
    const at = new Date(cursor.at);
    if (!Number.isFinite(at.getTime()) || at.toISOString() !== cursor.at || !idSchema.safeParse(cursor.id).success) throw new Error('Invalid cursor');
    return { pinned: cursor.pinned, at: cursor.at, id: cursor.id };
  } catch {
    throw new ApiError(400, 'Invalid session cursor');
  }
}

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export const GET = api(async request => {
  const user = await currentUser(request);
  const params = new URL(request.url).searchParams;
  const workspaceId = params.get('workspaceId');
  if (workspaceId !== null) await ownedWorkspace(user.id, workspaceId);

  const view = params.get('view') ?? 'active';
  if (view !== 'active' && view !== 'archived') throw new ApiError(400, 'Invalid session view');
  const q = (params.get('q') ?? '').trim();
  if (q.length > 100) throw new ApiError(400, 'Search is too long');
  const limitText = params.get('limit') ?? '50';
  if (!/^\d{1,3}$/.test(limitText)) throw new ApiError(400, 'Invalid session limit');
  const limit = Number(limitText);
  if (limit < 1 || limit > 100) throw new ApiError(400, 'Invalid session limit');
  const cursor = parseCursor(params.get('cursor'));

  const pinSort = sql<number>`case when ${agentSessions.pinnedAt} is null then 0 else 1 end`;
  // PostgreSQL timestamps can contain microseconds while JavaScript Date has
  // millisecond precision. Use one precision for ordering and cursor checks.
  const activitySort = sql<string>`date_trunc('milliseconds', ${agentSessions.lastActivityAt})`;
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const before = cursor ? or(
    lt(pinSort, cursor.pinned),
    and(eq(pinSort, cursor.pinned), or(
      lt(activitySort, cursor.at),
      and(eq(activitySort, cursor.at), lt(agentSessions.id, cursor.id)),
    )),
  ) : undefined;
  const rows = await db.select({ session: agentSessions, workspaceName: workspaces.name })
    .from(agentSessions)
    .innerJoin(workspaces, and(eq(workspaces.id, agentSessions.workspaceId), eq(workspaces.userId, user.id)))
    .where(and(
      eq(agentSessions.userId, user.id),
      workspaceId === null ? undefined : eq(agentSessions.workspaceId, workspaceId),
      view === 'active' ? isNull(agentSessions.archivedAt) : isNotNull(agentSessions.archivedAt),
      q ? or(ilike(agentSessions.title, pattern), ilike(workspaces.name, pattern)) : undefined,
      before,
    ))
    .orderBy(desc(pinSort), desc(activitySort), desc(agentSessions.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1)?.session;
  return Response.json({
    sessions: page.map(row => sessionSummary(row.session, row.workspaceName)),
    nextCursor: rows.length > limit && last ? encodeCursor({ pinned: last.pinnedAt === null ? 0 : 1, at: last.lastActivityAt.toISOString(), id: last.id }) : null,
  });
});
