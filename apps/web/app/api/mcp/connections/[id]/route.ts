import { api, body, currentUser, idSchema, manager, rateLimit } from '@/server/api';
import { publicMcpResponse, connectionResponseSchema, updateConnectionSchema } from '@/server/mcp';

export const dynamic = 'force-dynamic';
async function route(request: Request) {
  const user = await currentUser(request);
  const id = idSchema.parse(new URL(request.url).pathname.split('/')[4]);
  await rateLimit(user.id, request.method === 'GET' ? 'mcp-read' : 'mcp-write', request.method === 'GET' ? 120 : 30);
  const data = request.method === 'PATCH' ? updateConnectionSchema.parse(await body(request)) : undefined;
  const result = await manager(user.id, `/mcp/connections/${id}`, request.method, data);
  return Response.json(request.method === 'DELETE' ? { ok: true } : publicMcpResponse(connectionResponseSchema, result));
}
export const GET = api(route);
export const PATCH = api(route);
export const DELETE = api(route);
