import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sql } from '../packages/database/src/index.ts';
const require = createRequire(new URL('../apps/runtime-manager/package.json',import.meta.url));
const { Queue, QueueEvents } = require('bullmq');
const { Redis } = require('ioredis');
const userId = process.env.VERIFY_USER_ID!;
const [user] = await sql`SELECT email FROM users WHERE id=${userId}`;
assert.ok(user?.email?.startsWith('cloudwork-') && user.email.endsWith('@example.test'),'Only disposable integration accounts may be used');
const redis = new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:null});
const queue = new Queue('cloud-work-runtime-reaper',{connection:redis});
const events = new QueueEvents('cloud-work-runtime-reaper',{connection:redis});
await events.waitUntilReady();
const key = `runtime:${userId}:keepalive-jobs`;
const foreground = `runtime:${userId}:foreground-commands`;
async function sweep() {
 const job=await queue.add('verification-sweep',{}, {removeOnComplete:true});
 await job.waitUntilFinished(events,60000);
 return (await sql`SELECT status FROM runtime_instances WHERE user_id=${userId}`)[0].status;
}
try {
 await sql`UPDATE runtime_instances SET last_active_at=NOW()-INTERVAL '31 minutes' WHERE user_id=${userId}`;
 await redis.zadd(key,Date.now()+120000,'verification');
 assert.ok(['RUNNING','IDLE'].includes(await sweep()));
 console.log('PASS Registered keepalive prevents idle stop');
 await redis.zrem(key,'verification');
 await redis.zadd(foreground,Date.now()+120000,'verification');
 assert.ok(['RUNNING','IDLE'].includes(await sweep()));
 console.log('PASS Foreground command prevents idle stop');
 await redis.zrem(foreground,'verification');
 assert.equal(await sweep(),'STOPPED');
 console.log('PASS Real BullMQ worker stops idle Docker runtime');
 await sql`UPDATE runtime_instances SET stopped_at=NOW()-INTERVAL '25 hours' WHERE user_id=${userId}`;
 await redis.zadd(key,Date.now()+120000,'verification');
 assert.equal(await sweep(),'STOPPED');
 await redis.zrem(key,'verification');
 assert.equal(await sweep(),'REMOVED');
 console.log('PASS Real BullMQ worker removes expired stopped runtime');
} finally {
 await redis.zrem(key,'verification');await redis.zrem(foreground,'verification');
 await queue.close();await events.close();await redis.quit();await sql.end();
}
