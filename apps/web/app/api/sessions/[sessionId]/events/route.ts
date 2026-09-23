import { api, ApiError, currentUser, ownedSession, redis } from '@/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = api(async request => {
  const user = await currentUser(request);
  const sessionId = new URL(request.url).pathname.split('/')[3]!;
  await ownedSession(user.id, sessionId);
  const supplied = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after') ?? '0-0';
  if (!/^\d+-\d+$/.test(supplied)) throw new ApiError(400, 'Invalid event cursor');
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
  const reader = redis().duplicate({ maxRetriesPerRequest: 1 });
  let closed = false;
  let resume: (() => void) | undefined;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  let cursor = supplied;
  const encoder = new TextEncoder();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(maintenance);
    resume?.(); resume = undefined;
    reader.disconnect();
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
        let authCheck = Date.now();
        while (!closed) {
          const result = await reader.xread('COUNT',32,'BLOCK',15000,'STREAMS',`session:${sessionId}:events`,cursor) as [string,[string,string[]][]][] | null;
          if (closed) break;
          for (const [,entries] of result ?? []) for (const [id,fields] of entries) {
            const values = Object.fromEntries(Array.from({length: fields.length/2},(_,i) => [fields[i*2],fields[i*2+1]]));
            const payload = values.event ?? values.data;
            if (payload) await send(`id: ${id}\ndata: ${JSON.stringify(JSON.parse(payload))}\n\n`);
            cursor = id;
          }
          if (!result) await send(': heartbeat\n\n');
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
