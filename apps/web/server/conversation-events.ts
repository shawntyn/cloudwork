import { agentEvents, agentSessions, db } from '@cloud-work/database';
import type { AgentEvent } from '@cloud-work/protocol';
import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import { redis } from './api';

export type EventCursor = { ms: number; seq: number };

export function parseEventCursor(value: string): EventCursor | null {
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) return null;
  const ms = Number(match[1]), seq = Number(match[2]);
  return Number.isSafeInteger(ms) && Number.isSafeInteger(seq) ? { ms, seq } : null;
}

export function eventCursorAfter(cursor: EventCursor) {
  return or(gt(agentEvents.streamMs, cursor.ms), and(eq(agentEvents.streamMs, cursor.ms), gt(agentEvents.streamSeq, cursor.seq)));
}

export async function eventsAfter(sessionId: string, cursor: EventCursor) {
  return db.select().from(agentEvents).where(and(eq(agentEvents.sessionId, sessionId), eventCursorAfter(cursor)))
    .orderBy(asc(agentEvents.streamMs), asc(agentEvents.streamSeq)).limit(64);
}

// Old conversations lived only in Redis. Import the remaining stream once per
// session; the composite key also makes concurrent imports and new writes safe.
export async function backfillLegacyEvents(sessionId: string) {
  const [session] = await db.select({ eventsBackfilledAt: agentSessions.eventsBackfilledAt })
    .from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  if (!session || session.eventsBackfilledAt) return;
  let cursor = '-';
  for (;;) {
    const entries = await redis().xrange(`session:${sessionId}:events`, cursor, '+', 'COUNT', 128);
    if (!entries.length) break;
    const values: Array<typeof agentEvents.$inferInsert> = [];
    for (const [id, fields] of entries) {
      const parsed = parseEventCursor(id);
      const eventField = fields.indexOf('event');
      const dataField = fields.indexOf('data');
      const payload = eventField >= 0 ? fields[eventField + 1] : dataField >= 0 ? fields[dataField + 1] : undefined;
      if (!parsed || !payload) continue;
      const event = JSON.parse(payload) as AgentEvent;
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
      values.push({ sessionId, streamMs: parsed.ms, streamSeq: parsed.seq, event });
    }
    if (values.length) await db.insert(agentEvents).values(values).onConflictDoNothing();
    cursor = `(${entries[entries.length - 1]![0]}`;
    if (entries.length < 128) break;
  }
  await db.update(agentSessions).set({ eventsBackfilledAt: new Date() }).where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.eventsBackfilledAt)));
}
