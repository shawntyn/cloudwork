import { db, workspaces } from '@cloud-work/database';
import { workspacePath } from '@cloud-work/workspace';
import { and, eq, desc, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { api, ApiError, body, currentUser, manager, rateLimit } from '@/server/api';
export const dynamic = 'force-dynamic';
export const GET = api(async request => {
  const user = await currentUser(request);
  const view = new URL(request.url).searchParams.get('view') ?? 'active';
  if (view !== 'active' && view !== 'trash') throw new ApiError(400, 'Invalid workspace view');
  return Response.json({ workspaces: await db.select().from(workspaces)
    .where(and(eq(workspaces.userId,user.id), view === 'trash' ? isNotNull(workspaces.deletedAt) : isNull(workspaces.deletedAt)))
    .orderBy(view === 'trash' ? desc(workspaces.deletedAt) : desc(workspaces.createdAt)) });
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
