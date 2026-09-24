import type { AgentEvent } from '@cloud-work/protocol';
import { agentEvents, agentSessions, db } from '@cloud-work/database';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';

export async function publish(redis: Redis, sessionId: string, event: AgentEvent): Promise<void> {
  const key = `session:${sessionId}:events`;
  // PostgreSQL is the durable journal. Redis is a short-lived replay cache;
  // failure between these writes cannot erase a saved conversation event.
  const [saved] = await db.insert(agentEvents).values({ sessionId, event }).returning({ streamMs: agentEvents.streamMs });
  if (!saved) throw new Error('Event journal unavailable');
  try {
    const result = await redis.multi().xadd(key, 'MAXLEN', '~', 10000, `${saved.streamMs}-0`, 'event', JSON.stringify(event)).expire(key, 7 * 24 * 3600).exec();
    if (!result || result.some(([error]) => error)) throw new Error('Redis event cache unavailable');
  } catch {
    // SSE reads PostgreSQL and still delivers this event.
  }
}

export async function backfillLegacySession(redis: Redis, sessionId: string): Promise<void> {
  const [session] = await db.select({ eventsBackfilledAt: agentSessions.eventsBackfilledAt })
    .from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  if (!session || session.eventsBackfilledAt) return;
  let cursor = '-';
  for (;;) {
    const entries = await redis.xrange(`session:${sessionId}:events`, cursor, '+', 'COUNT', 128);
    if (!entries.length) break;
    const values: Array<typeof agentEvents.$inferInsert> = [];
    for (const [id, fields] of entries) {
      const match = /^(\d+)-(\d+)$/.exec(id);
      const ms = match ? Number(match[1]) : NaN, seq = match ? Number(match[2]) : NaN;
      const eventField = fields.indexOf('event'), dataField = fields.indexOf('data');
      const payload = eventField >= 0 ? fields[eventField + 1] : dataField >= 0 ? fields[dataField + 1] : undefined;
      if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(seq) || !payload) continue;
      const event = JSON.parse(payload) as AgentEvent;
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
      values.push({ sessionId, streamMs: ms, streamSeq: seq, event });
    }
    if (values.length) await db.insert(agentEvents).values(values).onConflictDoNothing();
    cursor = `(${entries[entries.length - 1]![0]}`;
    if (entries.length < 128) break;
  }
  await db.update(agentSessions).set({ eventsBackfilledAt: new Date() })
    .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.eventsBackfilledAt)));
}

export function startLegacyEventBackfill(redis: Redis, log: { error: (error: unknown, message?: string) => void }) {
  let running: Promise<void> | undefined, stopping = false;
  const scan = async () => {
    let after = '';
    while (!stopping) {
      const rows = await db.select({ id: agentSessions.id }).from(agentSessions)
        .where(and(isNull(agentSessions.eventsBackfilledAt), gt(agentSessions.id, after)))
        .orderBy(asc(agentSessions.id)).limit(100);
      if (!rows.length) break;
      for (const row of rows) {
        if (stopping) break;
        try { await backfillLegacySession(redis, row.id); }
        catch (error) { log.error(error, `Legacy event backfill deferred for ${row.id}`); }
      }
      after = rows[rows.length - 1]!.id;
    }
  };
  const run = () => { if (!running && !stopping) running = scan().catch(error => log.error(error, 'Legacy event backfill scan failed')).finally(() => { running = undefined; }); };
  run();
  const interval = setInterval(run, 60 * 60 * 1000);
  interval.unref();
  return async () => { stopping = true; clearInterval(interval); await running; };
}

export function parseEvent(value: unknown): AgentEvent {
  if (!value || typeof value !== 'object' || !('type' in value)) throw new Error('Invalid runtime event');
  const e = value as Record<string, unknown>;
  if (e.type === 'text-delta' && typeof e.text === 'string') return { type: 'text-delta', text: e.text };
  if (e.type === 'tool-start' && typeof e.id === 'string' && typeof e.name === 'string') return { type: 'tool-start', id: e.id, name: e.name, input: e.input };
  if (e.type === 'tool-result' && typeof e.id === 'string') return { type: 'tool-result', id: e.id, output: e.output };
  if (e.type === 'error' && typeof e.message === 'string') return { type: 'error', message: e.message, ...(typeof e.code === 'string' ? { code: e.code } : {}) };
  if (e.type === 'status' && ['starting', 'running', 'idle', 'stopped', 'error'].includes(String(e.status))) return { type: 'status', status: e.status as 'starting' | 'running' | 'idle' | 'stopped' | 'error' };
  throw new Error('Unknown runtime event');
}

/** Read arbitrary UTF-8 chunks, including CRLF and multi-line SSE data. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data: string[] = [], dataSize = 0;
  const pushData = (line: string) => {
    dataSize += Buffer.byteLength(line);
    if (dataSize > 8 * 1024 * 1024) throw new Error('Runtime event exceeds size limit');
    data.push(line);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Runtime event exceeds size limit');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '' && data.length) { yield parseEvent(JSON.parse(data.join('\n'))); data = []; dataSize = 0; }
        else if (line.startsWith('data:')) pushData(line.slice(5).replace(/^ /, ''));
      }
      if (done) {
        if (buffer.startsWith('data:')) pushData(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
        if (data.length) yield parseEvent(JSON.parse(data.join('\n')));
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export const terminal = (event: AgentEvent) => event.type === 'status' && ['idle', 'stopped', 'error'].includes(event.status);
