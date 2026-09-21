import { api, currentUser, ownedSession, manager } from '@/server/api';
export const POST = api(async request => {
  const user = await currentUser(request); const session = await ownedSession(user.id,new URL(request.url).pathname.split('/')[3]!);
  return Response.json(await manager(user.id,`/sessions/${session.id}/cancel`,'POST'));
});
