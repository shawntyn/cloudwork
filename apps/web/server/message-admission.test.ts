import assert from 'node:assert/strict';
import test from 'node:test';
import { submitMessageWithRateLimit } from './message-admission';

test('an accepted retry skips the new-message limit but is checked by the manager again', async () => {
  const calls: string[] = [];
  await submitMessageWithRateLimit('request-a',
    async () => { calls.push('status'); return { state: 'accepted' }; },
    async () => { calls.push('limit'); },
    async () => { calls.push('submit'); },
  );
  assert.deepEqual(calls, ['status', 'submit']);
});

test('preflight acceptance cannot hide a different-prompt conflict', async () => {
  const conflict = new Error('same identifier, different text');
  await assert.rejects(submitMessageWithRateLimit('request-a',
    async () => ({ state: 'accepted' }),
    async () => { throw new Error('retry was rate limited'); },
    async () => { throw conflict; },
  ), error => error === conflict);
});

test('a new message obeys the limit, including when its receipt is absent', async () => {
  const calls: string[] = [];
  await submitMessageWithRateLimit('request-a',
    async () => { calls.push('status'); return { state: 'absent' }; },
    async () => { calls.push('limit'); },
    async () => { calls.push('submit'); },
  );
  assert.deepEqual(calls, ['status', 'limit', 'submit']);
});

test('a rate-limit race accepts a request that committed after preflight', async () => {
  const calls: string[] = [];
  let checks = 0;
  await submitMessageWithRateLimit('request-a',
    async () => { calls.push('status'); return { state: ++checks === 1 ? 'absent' : 'accepted' }; },
    async () => { calls.push('limit'); throw new Error('rate limited'); },
    async () => { calls.push('submit'); },
  );
  assert.deepEqual(calls, ['status', 'limit', 'status', 'submit']);
});

test('an unaccepted request remains rate limited', async () => {
  const rateLimited = new Error('rate limited');
  let sent = false;
  await assert.rejects(submitMessageWithRateLimit('request-a',
    async () => ({ state: 'absent' }),
    async () => { throw rateLimited; },
    async () => { sent = true; },
  ), error => error === rateLimited);
  assert.equal(sent, false);
});
