import { db, agentSessions } from '@cloud-work/database';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { api, ApiError, body, currentUser, ownedSession } from '@/server/api';
import { sessionSummary } from '../summary';

export const dynamic = 'force-dynamic';
const id = (request: Request) => new URL(request.url).pathname.split('/')[3]!;

export const GET = api(async request => {
  const user = await currentUser(request);
  return Response.json({ session: sessionSummary(await ownedSession(user.id, id(request))) });
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0);

export const PATCH = api(async request => {
  const user = await currentUser(request);
  const session = await ownedSession(user.id, id(request));
  const patch = patchSchema.parse(await body(request));
  const now = new Date();
  const [updated] = await db.update(agentSessions).set({
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.pinned === undefined ? {} : { pinnedAt: patch.pinned ? now : null }),
    ...(patch.archived === undefined ? {} : { archivedAt: patch.archived ? now : null }),
    updatedAt: now,
  }).where(and(eq(agentSessions.id, session.id), eq(agentSessions.userId, user.id))).returning();
  if (!updated) throw new ApiError(404, 'Session not found');
  return Response.json({ session: sessionSummary(updated) });
});
