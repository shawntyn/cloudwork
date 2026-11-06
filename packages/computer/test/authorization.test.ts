import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { actionSchema, planSchema, signScope, verifyScope, type Scope } from '../src/index.ts';

test('task capabilities bind workspace, parent run and expiry; tampering is rejected', () => {
  const key = randomBytes(32).toString('hex');
  const scope: Scope = { kind: 'task', userId: 'alice', workspaceId: 'ws_a', sessionId: 'sess_a', runId: 'run_a', taskId: 'ct_a', expires: 2000 };
  const token = signScope(scope, key);
  assert.deepEqual(verifyScope(token, key, 1000), scope);
  assert.throws(() => verifyScope(token, key, 2000));
  assert.throws(() => verifyScope(token, randomBytes(32).toString('hex'), 1000));
  const [, signature] = token.split('.');
  assert.throws(() => verifyScope(Buffer.from(JSON.stringify({ ...scope, workspaceId: 'ws_b' })).toString('base64url') + '.' + signature, key, 1000));
  assert.throws(() => verifyScope(token + '.extra', key, 1000));
  assert.throws(() => verifyScope(signScope({ ...scope, kind: 'task', taskId: '../other' }, key), key, 1000));
});
test('desktop operations cannot become arbitrary commands or escape coordinate bounds', () => {
  for (const action of [
    { action: 'command', cmd: 'bash' }, { action: 'click', coordinate: [1280, 0] },
    { action: 'click', coordinate: [-1, 0] }, { action: 'key', key: 'Return; curl evil' },
    { action: 'key', key: '--shell' }, { action: 'type', text: 'a'.repeat(4001) },
    { action: 'wait', milliseconds: 999999 }, { action: 'scroll', direction: 'down', amount: 999 },
    { action: 'type', text: 'ok', cmd: 'bash' },
  ]) assert.equal(actionSchema.safeParse(action).success, false);
  assert.deepEqual(actionSchema.parse({ action: 'type', text: '中文\n$(touch /tmp/never-a-shell)' }), { action: 'type', text: '中文\n$(touch /tmp/never-a-shell)' });
  assert.equal(actionSchema.safeParse({ action: 'key', key: 'ctrl+shift+Tab' }).success, true);
});
test('model completion and confirmation require structured evidence and exact bounded operation', () => {
  assert.equal(planSchema.safeParse({ kind: 'done', result: '' }).success, false);
  assert.equal(planSchema.safeParse({ kind: 'confirmation', reason: 'Send this form', operation: { action: 'click', coordinate: [20, 30] } }).success, true);
  assert.equal(planSchema.safeParse({ kind: 'action', explanation: 'do it', operation: { action: 'bash', command: 'echo injected' } }).success, false);
});
