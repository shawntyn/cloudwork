import { sameSecret } from '@cloud-work/computer';
import { api, ApiError, body, currentUser, idSchema, manager, ownedWorkspace } from '../../../../server/api';
export const dynamic = 'force-dynamic';
export const POST = api(async request => {
  if (!sameSecret(request.headers.get('x-desktop-gateway-token') ?? '', process.env.DESKTOP_GATEWAY_TOKEN ?? '')) throw new ApiError(403, 'Forbidden');
  const user = await currentUser(request);
  const value = await body(request, 2000) as { workspaceId: string; clientId: string; control: boolean };
  const id = idSchema.parse(value.workspaceId), clientId = idSchema.parse(value.clientId);
  await ownedWorkspace(user.id, id);
  const target = await manager(user.id, `/workspaces/${id}/desktop/viewer`, 'POST', { clientId, control: value.control === true });
  return Response.json({ ...target, userId: user.id }, { headers: { 'cache-control': 'no-store' } });
});
