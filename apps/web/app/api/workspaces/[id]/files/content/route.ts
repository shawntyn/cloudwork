import { api, body, currentUser, manager, ownedWorkspace, validatePath } from '@/server/api';
import { z } from 'zod';
export const dynamic = 'force-dynamic';
async function route(request: Request) {
  const user = await currentUser(request); const url = new URL(request.url);
  const workspace = await ownedWorkspace(user.id, url.pathname.split('/')[3]!);
  const suffix = `/workspaces/${workspace.id}/files/content`;
  if (request.method === 'PUT') {
    const data = z.object({path:z.string().min(1),content:z.string().max(2097152)}).strict().parse(await body(request)); validatePath(data.path);
    return Response.json(await manager(user.id,suffix,'PUT',data));
  }
  const path = url.searchParams.get('path') ?? ''; validatePath(path);
  return Response.json(await manager(user.id,`${suffix}?path=${encodeURIComponent(path)}`));
}
export const GET = api(route); export const PUT = api(route);
