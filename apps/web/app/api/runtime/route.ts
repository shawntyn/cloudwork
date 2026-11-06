import { api, body, currentUser, manager, rateLimit } from '@/server/api';
import { z } from 'zod';
export const dynamic = 'force-dynamic';
export const GET = api(async request => { const user = await currentUser(request); return Response.json({ runtime: await manager(user.id,'/status') }); });
export const POST = api(async request => {
  const user = await currentUser(request); await rateLimit(user.id,'runtime-action',30);
  const { action } = z.object({action:z.enum(['start','stop','remove'])}).strict().parse(await body(request));
  return Response.json({ runtime: await manager(user.id,action === 'start' ? '/ensure' : `/${action}`,'POST') });
});
