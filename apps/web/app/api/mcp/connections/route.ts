import { api, body, currentUser, manager, rateLimit } from '@/server/api';
import { publicMcpResponse, connectionResponseSchema, connectionsResponseSchema, createConnectionSchema } from '@/server/mcp';

export const dynamic = 'force-dynamic';
export const GET = api(async request => {
  const user = await currentUser(request);
  await rateLimit(user.id, 'mcp-read');
  return Response.json(publicMcpResponse(connectionsResponseSchema, await manager(user.id, '/mcp/connections')));
});
export const POST = api(async request => {
  const user = await currentUser(request);
  await rateLimit(user.id, 'mcp-write', 30);
  const data = createConnectionSchema.parse(await body(request));
  return Response.json(publicMcpResponse(connectionResponseSchema, await manager(user.id, '/mcp/connections', 'POST', data)), { status: 201 });
});
