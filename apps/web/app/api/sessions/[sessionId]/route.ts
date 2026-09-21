import { api, currentUser, ownedSession } from '@/server/api';
export const dynamic = 'force-dynamic';
export const GET = api(async request => { const user = await currentUser(request); return Response.json({session: await ownedSession(user.id,new URL(request.url).pathname.split('/')[3]!)}); });
