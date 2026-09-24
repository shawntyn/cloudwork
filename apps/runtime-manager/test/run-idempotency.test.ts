import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { agentEvents, agentSessions, db, workspaces } from '@cloud-work/database';
import { Runs } from '../src/runs.js';
import type { RuntimeManager } from '../src/lifecycle.js';

test('a repeated accepted request ID never starts a second run', async t => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const prompt = 'Hello';
  const accepted = `accepted:${createHash('sha256').update(prompt).digest('hex')}`;
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() { return { async limit() {
    return table === agentSessions ? [{ id: 'session-a', userId: 'alice', workspaceId: 'workspace-a', dshSessionId: 'session-a', confirmedBlank: false, firstMessageAt: null }] :
      table === workspaces ? [{ id: 'workspace-a', userId: 'alice' }] : [];
  } }; } }; } }) as never);
  let acquisitions = 0;
  const manager = { leases: {
    async withLock(_key: string, work: () => Promise<unknown>) { return work(); },
    redis: { async exists() { return 0; }, async get() { return accepted; } },
    async acquire() { acquisitions++; throw new Error('Duplicate run started'); },
  } } as unknown as RuntimeManager;
  const runs = new Runs(manager, { error() {} });
  await runs.launch('alice', 'session-a', prompt, requestId);
  assert.equal(acquisitions, 0);
  await assert.rejects(runs.launch('alice', 'session-a', 'Different prompt', requestId), /Message acceptance is still being confirmed/);
  assert.equal(acquisitions, 0);
});

test('a crashed pending request becomes retryable only after the run lease is gone', async t => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const key = `session:session-a:message-request:${requestId}`;
  const stored = new Map([[key, 'pending:original-fingerprint']]);
  let hasLease = true;
  let sessionStatus = 'idle';
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() { return { async limit() {
    return table === agentSessions ? [{ id: 'session-a', userId: 'alice', workspaceId: 'workspace-a', dshSessionId: 'session-a', status: sessionStatus }] :
      table === workspaces ? [{ id: 'workspace-a', userId: 'alice' }] :
      table === agentEvents ? [] : [];
  } }; } }; } }) as never);
  const manager = { leases: {
    async withLock(_key: string, work: () => Promise<unknown>) { return work(); },
    redis: {
      async get(name: string) { return stored.get(name) ?? null; },
      async exists() { return hasLease ? 1 : 0; },
      async eval(_script: string, _count: number, name: string, expected: string) {
        if (stored.get(name) === expected) { stored.delete(name); return 1; }
        return 0;
      },
      async set(name: string, value: string, _expiry: string, _seconds: number, mode: string) {
        if (mode !== 'NX' || stored.has(name)) return null;
        stored.set(name, value);
        return 'OK';
      },
    },
  } } as unknown as RuntimeManager;
  const runs = new Runs(manager, { error() {} });
  assert.deepEqual(await runs.messageStatus('alice', 'session-a', requestId), { state: 'pending', sessionStatus: 'idle' });
  assert.equal(stored.get(key), 'pending:original-fingerprint');
  hasLease = false;
  sessionStatus = 'running';
  assert.deepEqual(await runs.messageStatus('alice', 'session-a', requestId), { state: 'pending', sessionStatus: 'running' });
  sessionStatus = 'error';
  assert.deepEqual(await runs.messageStatus('alice', 'session-a', requestId), { state: 'absent', sessionStatus: 'error' });
  assert.equal(stored.has(key), false);
  assert.equal(await manager.leases.redis.set(key, 'pending:retry-fingerprint', 'EX', 3600, 'NX'), 'OK');
});

test('a durable user message resolves a leftover pending marker as accepted', async t => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const key = `session:session-a:message-request:${requestId}`;
  let value = 'pending:stale';
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() { return { async limit() {
    return table === agentSessions ? [{ id: 'session-a', userId: 'alice', workspaceId: 'workspace-a', dshSessionId: 'session-a', status: 'idle' }] :
      table === workspaces ? [{ id: 'workspace-a', userId: 'alice' }] :
      table === agentEvents ? [{ event: { type: 'user-message', text: 'Hello', requestId } }] : [];
  } }; } }; } }) as never);
  const manager = { leases: {
    async withLock(_key: string, work: () => Promise<unknown>) { return work(); },
    redis: { async get(name: string) { assert.equal(name, key); return value; }, async set(name: string, next: string) { assert.equal(name, key); value = next; return 'OK'; } },
  } } as unknown as RuntimeManager;
  const result = await new Runs(manager, { error() {} }).messageStatus('alice', 'session-a', requestId);
  assert.deepEqual(result, { state: 'accepted', sessionStatus: 'idle' });
  assert.equal(value, `accepted:${createHash('sha256').update('Hello').digest('hex')}`);
});

test('Stop after a failed or completed run does not append a stopped event', async t => {
  let status = 'error';
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() { return { async limit() {
    return table === agentSessions ? [{ id: 'session-a', userId: 'alice', workspaceId: 'workspace-a', dshSessionId: 'session-a', status }] :
      table === workspaces ? [{ id: 'workspace-a', userId: 'alice' }] : [];
  } }; } }; } }) as never);
  let writes = 0;
  t.mock.method(db, 'insert', () => { writes++; throw new Error('An event was appended'); });
  t.mock.method(db, 'update', () => { writes++; throw new Error('The session was changed'); });
  const manager = { leases: { redis: { async exists() { return 0; } } }, async request() { throw new Error('No execution should be cancelled'); } } as unknown as RuntimeManager;
  const runs = new Runs(manager, { error() {} });
  assert.deepEqual(await runs.cancel('alice', 'session-a'), { ok: true });
  status = 'idle';
  assert.deepEqual(await runs.cancel('alice', 'session-a'), { ok: true });
  assert.equal(writes, 0);
});
