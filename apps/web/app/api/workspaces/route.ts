import { db, workspaces } from '@cloud-work/database';
import { workspacePath } from '@cloud-work/workspace';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { api, body, currentUser, manager, rateLimit } from '@/server/api';
export const dynamic = 'force-dynamic';
export const GET = api(async request => {
  const user = await currentUser(request);
  return Response.json({ workspaces: await db.select().from(workspaces).where(eq(workspaces.userId,user.id)).orderBy(desc(workspaces.createdAt)) });
});
export const POST = api(async request => {
  const user = await currentUser(request); await rateLimit(user.id, 'workspace-create', 20);
  const { name } = z.object({ name: z.string().trim().min(1).max(100) }).strict().parse(await body(request));
  const id = `ws_${crypto.randomUUID()}`;
  const [workspace] = await db.insert(workspaces).values({ id, name, userId: user.id, path: workspacePath(id) }).returning();
  // Keep metadata on startup failure so the user can retry entering the workspace.
  try { await manager(user.id, `/workspaces/${id}`, 'POST'); }
  catch (error) { console.error('Workspace provisioning will retry on open:', error); }
  return Response.json({ workspace }, { status: 201 });
});
