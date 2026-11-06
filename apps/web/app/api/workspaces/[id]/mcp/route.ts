import { api, body, currentUser, manager, ownedWorkspace, rateLimit } from '@/server/api';
import { publicMcpResponse, workspaceMcpResponseSchema, workspaceMcpSchema } from '@/server/mcp';

export const dynamic = 'force-dynamic';
async function route(request: Request) {
  const user = await currentUser(request);
  const workspace = await ownedWorkspace(user.id, new URL(request.url).pathname.split('/')[3]!);
  await rateLimit(user.id, request.method === 'GET' ? 'mcp-read' : 'mcp-write', request.method === 'GET' ? 120 : 30);
  const data = request.method === 'PUT' ? workspaceMcpSchema.parse(await body(request)) : undefined;
  return Response.json(publicMcpResponse(workspaceMcpResponseSchema, await manager(user.id, `/workspaces/${workspace.id}/mcp`, request.method, data)));
}
export const GET = api(route);
export const PUT = api(route);
