import { api, body, currentUser, ownedSession, manager, rateLimit } from '@/server/api';
import { z } from 'zod';
export const POST = api(async request => {
  const user = await currentUser(request); const session = await ownedSession(user.id,new URL(request.url).pathname.split('/')[3]!); await rateLimit(user.id,'message',30);
  const {prompt} = z.object({prompt:z.string().trim().min(1).max(100000)}).strict().parse(await body(request));
  await manager(user.id,`/sessions/${session.id}/messages`,'POST',{prompt});
  return Response.json({accepted:true},{status:202});
});
