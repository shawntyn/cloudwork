import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '@cloud-work/database';
import type { Redis } from 'ioredis';
import { publish, startLegacyEventBackfill } from '../src/events.js';

test('an event is durable before the Redis cache is attempted', async t => {
  const order: string[] = [];
  t.mock.method(db, 'insert', () => ({ values() { order.push('database'); return { async returning() { return [{ streamMs: 1800000000000000 }]; } }; } }) as never);
  const cache = { multi() { order.push('redis'); throw new Error('Redis is offline'); } } as unknown as Redis;
  await publish(cache, 'session-a', { type: 'user-message', text: 'hello' });
  assert.deepEqual(order, ['database', 'redis']);
});

test('startup imports an unopened legacy conversation from its expiring Redis stream', async t => {
  let scans = 0;
  const imported: unknown[] = [];
  let finish!: () => void;
  const importedDone = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(db, 'select', (selection: Record<string, unknown>) => {
    if ('eventsBackfilledAt' in selection) return { from() { return { where() { return { async limit() { return [{ eventsBackfilledAt: null }]; } }; } }; } } as never;
    return { from() { return { where() { return { orderBy() { return { async limit() { return scans++ === 0 ? [{ id: 'session-old' }] : []; } }; } }; } }; } } as never;
  });
  t.mock.method(db, 'insert', () => ({ values(value: unknown) { imported.push(value); return { async onConflictDoNothing() {} }; } }) as never);
  t.mock.method(db, 'update', () => ({ set() { return { async where() { finish(); } }; } }) as never);
  const cache = { async xrange(key: string) {
    assert.equal(key, 'session:session-old:events');
    return [['1790000000000-0', ['event', JSON.stringify({ type: 'user-message', text: 'saved prompt' })]]];
  } } as unknown as Redis;
  const errors: unknown[] = [];
  const stop = startLegacyEventBackfill(cache, { error: error => { errors.push(error); } });
  await Promise.race([importedDone, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('Legacy scan timed out')), 1000))]);
  await stop();
  assert.deepEqual(errors, []);
  assert.deepEqual(imported, [[{ sessionId: 'session-old', streamMs: 1790000000000, streamSeq: 0, event: { type: 'user-message', text: 'saved prompt' } }]]);
});
