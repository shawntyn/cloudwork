import { api, body, currentUser, manager, ownedWorkspace, validatePath } from '@/server/api';
import { z } from 'zod';
import { FILE_TRANSFER_LIMITS } from '@cloud-work/protocol';
export const dynamic = 'force-dynamic';
async function route(request: Request) {
  const user = await currentUser(request); const url = new URL(request.url);
  const workspace = await ownedWorkspace(user.id, url.pathname.split('/')[3]!);
  const suffix = `/workspaces/${workspace.id}/files/content`;
  if (request.method === 'PUT') {
    const data = z.object({path:z.string().min(1),content:z.string().max(FILE_TRANSFER_LIMITS.maxTextBytes).refine(value => Buffer.byteLength(value, 'utf8') <= FILE_TRANSFER_LIMITS.maxTextBytes),expectedVersion:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().parse(await body(request, 64 * 1024 * 1024)); validatePath(data.path);
    return Response.json(await manager(user.id,suffix,'PUT',data));
  }
  const path = url.searchParams.get('path') ?? ''; validatePath(path);
  return Response.json(await manager(user.id,`${suffix}?path=${encodeURIComponent(path)}`));
}
export const GET = api(route); export const PUT = api(route);
