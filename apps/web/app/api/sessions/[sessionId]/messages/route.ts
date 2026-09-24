import { api, body, currentUser, ownedSession, manager, rateLimit } from '@/server/api';
import { z } from 'zod';
const sessionId = (request: Request) => new URL(request.url).pathname.split('/')[3]!;
export const GET = api(async request => {
  const user = await currentUser(request);
  const session = await ownedSession(user.id, sessionId(request));
  const requestId = z.uuid().parse(new URL(request.url).searchParams.get('requestId'));
  const status = await manager(user.id, `/sessions/${session.id}/messages/${requestId}/status`);
  return Response.json(status);
});
export const POST = api(async request => {
  const user = await currentUser(request); const session = await ownedSession(user.id,sessionId(request)); await rateLimit(user.id,'message',30);
  const {prompt, requestId} = z.object({prompt:z.string().trim().min(1).max(100000),requestId:z.uuid().optional()}).strict().parse(await body(request));
  await manager(user.id,`/sessions/${session.id}/messages`,'POST',{prompt,requestId});
  return Response.json({accepted:true},{status:202});
});
