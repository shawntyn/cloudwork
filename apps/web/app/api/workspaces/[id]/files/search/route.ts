import { api, currentUser, manager, ownedWorkspace } from '@/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (request: Request) => {
  const user = await currentUser(request);
  const url = new URL(request.url);
  const workspace = await ownedWorkspace(user.id, url.pathname.split('/')[3]!);
  const query = url.searchParams.get('query')?.trim() ?? '';
  if (!query || query.length > 100) return Response.json({ error: 'Search query must contain 1–100 characters' }, { status: 400 });
  return Response.json(await manager(user.id, `/workspaces/${workspace.id}/files/search?query=${encodeURIComponent(query)}`));
});
