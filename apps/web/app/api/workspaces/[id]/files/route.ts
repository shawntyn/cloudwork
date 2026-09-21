import { api, body, currentUser, manager, ownedWorkspace, validatePath } from '@/server/api';
import { z } from 'zod';
export const dynamic = 'force-dynamic';
async function route(request: Request) {
  const user = await currentUser(request); const url = new URL(request.url);
  const workspace = await ownedWorkspace(user.id,url.pathname.split('/')[3]!);
  const path = url.searchParams.get('path') ?? '';
  if (request.method === 'POST') {
    const data = z.discriminatedUnion('operation',[
      z.object({operation:z.literal('mkdir'),path:z.string().min(1)}).strict(),
      z.object({operation:z.literal('rename'),path:z.string().min(1),to:z.string().min(1)}).strict(),
    ]).parse(await body(request));
    // Validation at the runtime repeats these checks with descriptor-pinned paths.
    validatePath(data.path); if (data.operation === 'rename') validatePath(data.to);
    return Response.json(await manager(user.id,`/workspaces/${workspace.id}/files`,'POST',data));
  }
  validatePath(path, request.method === 'GET');
  return Response.json(await manager(user.id, `/workspaces/${workspace.id}/files?path=${encodeURIComponent(path)}`, request.method));
}
export const GET = api(route); export const POST = api(route); export const DELETE = api(route);
