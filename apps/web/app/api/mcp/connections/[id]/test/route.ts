import { api, currentUser, idSchema, manager, rateLimit } from '@/server/api';
import { publicMcpResponse, connectionResponseSchema } from '@/server/mcp';

export const dynamic = 'force-dynamic';
export const POST = api(async request => {
  const user = await currentUser(request);
  const id = idSchema.parse(new URL(request.url).pathname.split('/')[4]);
  await rateLimit(user.id, 'mcp-test', 15);
  return Response.json(publicMcpResponse(connectionResponseSchema, await manager(user.id, `/mcp/connections/${id}/test`, 'POST')));
});
