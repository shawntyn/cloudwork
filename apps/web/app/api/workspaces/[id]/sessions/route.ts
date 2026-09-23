import { db, agentSessions } from '@cloud-work/database';
import { and, eq, desc, isNull } from 'drizzle-orm';
import { api, currentUser, manager, ownedWorkspace, rateLimit } from '@/server/api';
import { sessionSummary } from '@/app/api/sessions/summary';
export const dynamic = 'force-dynamic';
const id = (r: Request) => new URL(r.url).pathname.split('/')[3]!;
export const GET = api(async request => {
  const user = await currentUser(request); const workspace = await ownedWorkspace(user.id, id(request));
  const sessions = await db.select().from(agentSessions)
    .where(and(eq(agentSessions.workspaceId, workspace.id), eq(agentSessions.userId, user.id)))
    .orderBy(desc(agentSessions.lastActivityAt), desc(agentSessions.id));
  return Response.json({ sessions: sessions.map(session => sessionSummary(session, workspace.name)) });
});
export const POST = api(async request => {
  const user = await currentUser(request); const workspace = await ownedWorkspace(user.id,id(request)); await rateLimit(user.id,'session-create',30);
  // Old session timestamps cannot prove that no messages exist. Only records
  // explicitly created as blank drafts may be reused.
  const [existing] = await db.select().from(agentSessions).where(and(
    eq(agentSessions.userId, user.id), eq(agentSessions.workspaceId, workspace.id),
    eq(agentSessions.confirmedBlank, true), isNull(agentSessions.firstMessageAt),
    isNull(agentSessions.archivedAt), eq(agentSessions.status, 'idle'),
  )).orderBy(desc(agentSessions.createdAt)).limit(1);
  if (existing) return Response.json({ session: sessionSummary(existing, workspace.name), reused: true });
  const sessionId = `sess_${crypto.randomUUID()}`;
  const [session] = await db.insert(agentSessions).values({ id: sessionId, userId: user.id, workspaceId: workspace.id, dshSessionId: sessionId, confirmedBlank: true }).returning();
  try { await manager(user.id, `/sessions/${sessionId}`, 'POST', { workspaceId: workspace.id }); }
  catch (error) { await db.delete(agentSessions).where(eq(agentSessions.id, sessionId)); throw error; }
  return Response.json({ session: sessionSummary(session!, workspace.name), reused: false }, { status: 201 });
});
