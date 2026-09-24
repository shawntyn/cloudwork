import { db, workspaces } from '@cloud-work/database';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { api, ApiError, body, currentUser, idSchema, ownedWorkspace, manager, rateLimit } from '@/server/api';
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
  await rateLimit(user.id, 'workspace-trash', 30);
  return Response.json(await manager(user.id, `/workspaces/${workspace.id}/trash`, 'POST'));
});
export const PATCH = api(async request => {
  const user = await currentUser(request); const id = idSchema.parse(workspaceId(request));
  const [workspace] = await db.select().from(workspaces).where(and(eq(workspaces.id, id), eq(workspaces.userId, user.id))).limit(1);
  if (!workspace) throw new ApiError(404, 'Workspace not found', 'WORKSPACE_NOT_FOUND');
  if (workspace.deletedAt && (workspace.purgeStartedAt || Date.now() - workspace.deletedAt.getTime() >= 30 * 24 * 60 * 60 * 1000))
    throw new ApiError(410, 'Workspace restore period has expired', 'WORKSPACE_RESTORE_EXPIRED');
  await rateLimit(user.id, 'workspace-restore', 30);
  return Response.json(await manager(user.id, `/workspaces/${id}/restore`, 'POST'));
});
export const POST = api(async request => {
  const user = await currentUser(request); const id = idSchema.parse(workspaceId(request));
  const [workspace] = await db.select().from(workspaces).where(and(eq(workspaces.id, id), eq(workspaces.userId, user.id))).limit(1);
  if (!workspace?.deletedAt) throw new ApiError(404, 'Trashed workspace not found', 'WORKSPACE_NOT_FOUND');
  const { confirmName } = z.object({ confirmName: z.string() }).strict().parse(await body(request));
  if (confirmName !== workspace.name) throw new ApiError(400, 'Type the workspace name to confirm permanent deletion', 'INVALID_REQUEST');
  await rateLimit(user.id, 'workspace-purge', 10);
  return Response.json(await manager(user.id, `/workspaces/${id}`, 'DELETE', { confirmName }));
});
