import { api, ApiError, currentUser, ownedSession, redis } from '@/server/api';
import { backfillLegacyEvents, eventsAfter, parseEventCursor } from '@/server/conversation-events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = api(async request => {
  const user = await currentUser(request);
  const sessionId = new URL(request.url).pathname.split('/')[3]!;
  await ownedSession(user.id, sessionId);
  const supplied = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after') ?? '0-0';
  const parsedCursor = parseEventCursor(supplied);
  if (!parsedCursor) throw new ApiError(400, 'Invalid event cursor');
  const key = `sse:${user.id}:connections`;
  const token = crypto.randomUUID();
  // Atomic, expiring connection slots, independent from runtime busy state.
  const accepted = await redis().eval(`
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
    if redis.call('ZCARD', KEYS[1]) >= 10 then return 0 end
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
    redis.call('EXPIRE', KEYS[1], 90)
    return 1`, 1, key, Date.now(), Date.now() + 60000, token);
  if (!accepted) throw new ApiError(429, 'Too many open event streams');
  let closed = false;
  let resume: (() => void) | undefined;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  let cursor = parsedCursor;
  const encoder = new TextEncoder();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(maintenance);
    resume?.(); resume = undefined;
    void redis().zrem(key,token).catch(() => {});
  };
  request.signal.addEventListener('abort',cleanup,{once:true});
  if (request.signal.aborted) cleanup();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = async (text: string) => {
        while (!closed && (controller.desiredSize ?? 0) <= 0) await new Promise<void>(resolve => { resume = resolve; });
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      let maintaining = false;
      maintenance = setInterval(() => {
        if (closed || maintaining) return;
        maintaining = true;
        void (async () => {
          await currentUser(request);
          await ownedSession(user.id,sessionId);
          await redis().zadd(key,Date.now()+60000,token);
          await redis().expire(key,90);
        })().catch(() => {
          cleanup();
          try { controller.close(); } catch { /* Already cancelled. */ }
        }).finally(() => { maintaining = false; });
      },20000);
      maintenance.unref();
      void (async () => {
      try {
        await send('retry: 2000\n\n');
        await backfillLegacyEvents(sessionId);
        let authCheck = Date.now();
        let heartbeat = Date.now();
        while (!closed) {
          const result = await eventsAfter(sessionId, cursor);
          if (closed) break;
          for (const entry of result) {
            const id = `${entry.streamMs}-${entry.streamSeq}`;
            await send(`id: ${id}\ndata: ${JSON.stringify(entry.event)}\n\n`);
            cursor = { ms: entry.streamMs, seq: entry.streamSeq };
          }
          if (!result.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (Date.now() - heartbeat > 15000) { await send(': heartbeat\n\n'); heartbeat = Date.now(); }
          }
          await redis().zadd(key,Date.now()+60000,token);
          await redis().expire(key,90);
          if (Date.now()-authCheck > 60000) {
            await currentUser(request); await ownedSession(user.id,sessionId); authCheck = Date.now();
          }
        }
      } catch (error) {
        if (!closed) {
          console.error('Event stream disconnected:', error);
          await send(`data: ${JSON.stringify({type:'error',code:'stream_interrupted',message:'Connection interrupted. Reconnecting…'})}\n\n`);
        }
      } finally {
        cleanup();
        request.signal.removeEventListener('abort',cleanup);
        try { controller.close(); } catch { /* The browser already cancelled. */ }
      }
      })();
    },
    pull() { resume?.(); resume = undefined; },
    cancel() { cleanup(); },
  });
  return new Response(stream, {headers: {'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'}});
});
