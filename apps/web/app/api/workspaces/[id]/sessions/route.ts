import { db, agentSessions } from '@cloud-work/database';
import { eq, desc } from 'drizzle-orm';
import { api, currentUser, manager, ownedWorkspace, rateLimit } from '@/server/api';
export const dynamic = 'force-dynamic';
const id = (r: Request) => new URL(r.url).pathname.split('/')[3]!;
export const GET = api(async request => {
  const user = await currentUser(request); const workspace = await ownedWorkspace(user.id, id(request));
  return Response.json({ sessions: await db.select().from(agentSessions).where(eq(agentSessions.workspaceId, workspace.id)).orderBy(desc(agentSessions.createdAt)) });
});
export const POST = api(async request => {
  const user = await currentUser(request); const workspace = await ownedWorkspace(user.id,id(request)); await rateLimit(user.id,'session-create',30);
  const sessionId = `sess_${crypto.randomUUID()}`;
  const [session] = await db.insert(agentSessions).values({ id: sessionId, userId: user.id, workspaceId: workspace.id, dshSessionId: sessionId }).returning();
  try { await manager(user.id, `/sessions/${sessionId}`, 'POST', { workspaceId: workspace.id }); }
  catch (error) { await db.delete(agentSessions).where(eq(agentSessions.id, sessionId)); throw error; }
  return Response.json({ session }, { status: 201 });
});
