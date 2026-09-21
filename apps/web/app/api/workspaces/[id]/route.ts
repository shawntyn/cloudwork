import { db, workspaces, agentSessions } from '@cloud-work/database';
import { eq, and } from 'drizzle-orm';
import { api, currentUser, ownedWorkspace, manager, redis } from '@/server/api';
export const dynamic = 'force-dynamic';
function workspaceId(request: Request) { return new URL(request.url).pathname.split('/')[3]!; }
export const GET = api(async request => {
  const user = await currentUser(request); const workspace = await ownedWorkspace(user.id, workspaceId(request));
  await manager(user.id, `/workspaces/${workspace.id}`, 'POST');
  const runtime = await manager(user.id, '/status');
  return Response.json({ workspace, runtime });
});
export const DELETE = api(async request => {
  const user = await currentUser(request); const workspace = await ownedWorkspace(user.id, workspaceId(request));
  await manager(user.id, `/workspaces/${workspace.id}`, 'DELETE');
  const removed = await db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.workspaceId,workspace.id));
  await db.delete(workspaces).where(and(eq(workspaces.id,workspace.id),eq(workspaces.userId,user.id)));
  if (removed.length) await redis().del(...removed.map(s => `session:${s.id}:events`));
  return Response.json({ ok: true });
});
