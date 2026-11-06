import { api, body, currentUser, manager, ownedWorkspace, rateLimit } from '../../../../../server/api';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async request => { const user = await currentUser(request), { id } = await context.params; await ownedWorkspace(user.id, id); return Response.json(await manager(user.id, `/workspaces/${id}/desktop`)); })(request);
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async request => { const user = await currentUser(request), { id } = await context.params; await ownedWorkspace(user.id, id); await rateLimit(user.id, 'desktop', 60); return Response.json(await manager(user.id, `/workspaces/${id}/desktop`, 'POST', await body(request, 20000))); })(request);
}
