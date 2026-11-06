import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { agentEvents, agentMessageRequests, agentSessions, db, workspaces } from '@cloud-work/database';
import { Runs } from '../src/runs.js';
import type { RuntimeManager } from '../src/lifecycle.js';

test('a durable request receipt prevents replay after its Redis marker expires', async t => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const prompt = 'Hello';
  const fingerprint = createHash('sha256').update(prompt).digest('hex');
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() { return { async limit() {
    return table === agentSessions ? [{ id: 'session-a', userId: 'alice', workspaceId: 'workspace-a', dshSessionId: 'session-a', status: 'idle', confirmedBlank: false, firstMessageAt: null }] :
      table === workspaces ? [{ id: 'workspace-a', userId: 'alice' }] :
      table === agentMessageRequests ? [{ promptFingerprint: fingerprint, status: 'completed' }] : [];
  } }; } }; } }) as never);
  let acquisitions = 0;
  const manager = { leases: {
    async withLock(_key: string, work: () => Promise<unknown>) { return work(); },
    redis: { async exists() { return 0; }, async get() { return null; } },
    async acquire() { acquisitions++; throw new Error('Duplicate run started'); },
  } } as unknown as RuntimeManager;
  const runs = new Runs(manager, { error() {} });
  assert.deepEqual(await runs.launch('alice', 'session-a', prompt, requestId), { requestStatus: 'completed' });
  assert.equal(acquisitions, 0);
  assert.deepEqual(await runs.messageStatus('alice', 'session-a', requestId), { state: 'accepted', sessionStatus: 'idle', requestStatus: 'completed' });
  await assert.rejects(runs.launch('alice', 'session-a', 'Different prompt', requestId), /Message identifier was already used for different text/);
  assert.equal(acquisitions, 0);
});

test('legacy request fingerprints retain the original prompt whitespace', async t => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const originalPrompt = '  Hello  ';
  const fingerprint = createHash('sha256').update(originalPrompt).digest('hex');
  for (const source of ['journal', 'accepted-marker', 'pending-marker'] as const) {
    await t.test(source, async context => {
      context.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() { return { async limit() {
        return table === agentSessions ? [{ id: 'row-a', userId: 'alice', workspaceId: 'workspace-a', dshSessionId: 'session-a', status: 'idle' }] :
          table === workspaces ? [{ id: 'workspace-a', userId: 'alice' }] :
          table === agentEvents && source === 'journal' ? [{ event: { type: 'user-message', text: originalPrompt, requestId } }] : [];
      } }; } }; } }) as never);
      let acquisitions = 0;
      const manager = { leases: {
        async withLock(_key: string, work: () => Promise<unknown>) { return work(); },
        redis: {
          async exists() { return 0; },
          async get() { return source === 'journal' ? null : `${source === 'accepted-marker' ? 'accepted' : 'pending'}:${fingerprint}`; },
        },
        async acquire() { acquisitions++; throw new Error('Duplicate run started'); },
      } } as unknown as RuntimeManager;
      const runs = new Runs(manager, { error() {} });
      if (source === 'pending-marker') {
        await assert.rejects(runs.launch('alice', 'session-a', originalPrompt, requestId), /Message acceptance is still being confirmed/);
      } else assert.deepEqual(await runs.launch('alice', 'session-a', originalPrompt, requestId), { requestStatus: null });
      await assert.rejects(runs.launch('alice', 'session-a', '  Different  ', requestId), /Message identifier was already used for different text/);
      assert.equal(acquisitions, 0);
    });
  }
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

test('recovery resumes a queued durable request once its old run lease is gone', async t => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const session = { id: 'row-a', userId: 'alice', workspaceId: 'workspace-a', dshSessionId: 'session-a', status: 'running' };
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() {
    const rows = table === agentSessions ? [session] : table === agentMessageRequests ? [{ requestId, prompt: 'Hello', status: 'queued' }] : [];
    return { then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve(rows).then(resolve, reject); }, async limit() { return rows; } };
  } }; } }) as never);
  t.mock.method(db, 'insert', () => { throw new Error('Recovery must not duplicate the user message'); });
  let acquisitions = 0;
  const manager = {
    leases: {
      redis: { async exists() { return 0; }, async get() { return null; } },
      async withLock(_key: string, work: () => Promise<unknown>) { return work(); },
      async acquire() { acquisitions++; return 'new-lease'; },
      async renew() {},
      async release() { throw new Error('Recovered request should keep its lease while running'); },
    },
    async admitActivity() {},
    async request() { throw new Error('Dispatch is intercepted below'); },
  } as unknown as RuntimeManager;
  const runs = new Runs(manager, { error(error) { throw error; } });
  const dispatched: unknown[][] = [];
  const startable = runs as unknown as { startAcceptedExecution: (...args: unknown[]) => void };
  t.mock.method(startable, 'startAcceptedExecution', (...args: unknown[]) => { dispatched.push(args); });
  t.mock.method(runs as unknown as { retryPendingGrantCleanup: () => Promise<void> }, 'retryPendingGrantCleanup', async () => {});
  await runs.recoverStale();
  assert.equal(acquisitions, 1);
  assert.deepEqual(dispatched, [[{
    userId: 'alice', sessionId: 'session-a', sessionRowId: 'row-a', requestId, token: 'new-lease',
  }, 'workspace-a', 'Hello']]);
});

test('Stop completes an abandoned queued request so recovery cannot dispatch it', async t => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  let sessionStatus = 'running', requestStatus = 'queued', acquisitions = 0, dispatched = 0, clearedBusy = 0;
  const events: unknown[] = [];
  const session = () => ({ id: 'row-a', userId: 'alice', workspaceId: 'workspace-a', dshSessionId: 'session-a', status: sessionStatus });
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() {
    const rows = table === agentSessions ? [session()] : table === workspaces ? [{ id: 'workspace-a', userId: 'alice' }] :
      table === agentMessageRequests && requestStatus === 'queued' ? [{ requestId, status: requestStatus }] : [];
    return {
      then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve(table === agentSessions && sessionStatus !== 'running' ? [] : rows).then(resolve, reject);
      },
      async limit() { return rows; },
    };
  } }; } }) as never);
  t.mock.method(db, 'transaction', async (work: (tx: unknown) => Promise<unknown>) => work({
    update(table: unknown) { return { set(values: { status: string }) { return { where() {
      if (table === agentMessageRequests) return { async returning() {
        assert.equal(requestStatus, 'queued');
        requestStatus = values.status;
        return [{ requestId }];
      } };
      assert.equal(table, agentSessions);
      sessionStatus = values.status;
      return Promise.resolve();
    } }; } }; },
    insert(table: unknown) { assert.equal(table, agentEvents); return { async values(value: { event: unknown }) { events.push(value.event); } }; },
  }) as never);
  const manager = {
    leases: {
      redis: { async exists() { return 0; }, async get() { return null; } },
      async withLock(_key: string, work: () => Promise<unknown>) { return work(); },
      async acquire() { acquisitions++; throw new Error('Stopped request was restarted'); },
      async clearBusy() { clearedBusy++; },
    },
    async request() { throw new Error('Stopped request reached Runtime'); },
  } as unknown as RuntimeManager;
  const runs = new Runs(manager, { error(error) { throw error; } });
  const startable = runs as unknown as { startAcceptedExecution: (...args: unknown[]) => void };
  t.mock.method(startable, 'startAcceptedExecution', () => { dispatched++; });
  t.mock.method(runs as unknown as { retryPendingGrantCleanup: () => Promise<void> }, 'retryPendingGrantCleanup', async () => {});
  assert.deepEqual(await runs.cancel('alice', 'session-a'), { ok: true });
  assert.equal(sessionStatus, 'idle');
  assert.equal(requestStatus, 'completed');
  assert.deepEqual(events, [{ type: 'status', status: 'stopped' }]);
  assert.equal(clearedBusy, 1);
  await runs.recoverStale();
  assert.equal(acquisitions, 0);
  assert.equal(dispatched, 0);
});

test('Stop persists an active pre-run request before acknowledging and crash recovery cannot replay it', async t => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  let sessionStatus = 'running', requestStatus = 'queued', acquisitions = 0;
  const events: unknown[] = [];
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() {
    const rows = table === agentSessions ? [{ id: 'row-a', userId: 'alice', workspaceId: 'workspace-a', dshSessionId: 'session-a', status: sessionStatus }] :
      table === workspaces ? [{ id: 'workspace-a', userId: 'alice' }] :
      table === agentMessageRequests && requestStatus === 'queued' ? [{ requestId, prompt: 'Hello', status: requestStatus }] : [];
    return { then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
      return Promise.resolve(table === agentSessions && sessionStatus !== 'running' ? [] : rows).then(resolve, reject);
    }, async limit() { return rows; } };
  } }; } }) as never);
  t.mock.method(db, 'transaction', async (work: (tx: unknown) => Promise<unknown>) => work({
    update(table: unknown) { return { set(values: { status: string }) { return { where() {
      if (table === agentMessageRequests) return { async returning() {
        assert.equal(requestStatus, 'queued');
        requestStatus = values.status;
        return [{ requestId }];
      } };
      assert.equal(table, agentSessions);
      sessionStatus = values.status;
      return Promise.resolve();
    } }; } }; },
    insert(table: unknown) { assert.equal(table, agentEvents); return { async values(value: { event: unknown }) { events.push(value.event); } }; },
  }) as never);
  const manager = {
    leases: {
      redis: { async exists() { return 0; }, async get() { return null; } },
      async withLock(_key: string, work: () => Promise<unknown>) { return work(); },
      async acquire() { acquisitions++; throw new Error('Stopped request was restarted'); },
    },
    async request() { throw new Error('Pre-run Stop must not call Runtime'); },
  } as unknown as RuntimeManager;
  const runs = new Runs(manager, { error(error) { throw error; } });
  const controller = new AbortController();
  runs['active'].set('session-a', {
    userId: 'alice', sessionId: 'session-a', sessionRowId: 'row-a', requestId, runId: 'run-a', token: 'lock-token',
    controller, promise: Promise.resolve(), cancelling: false, started: false,
  });
  assert.deepEqual(await runs.cancel('alice', 'session-a'), { ok: true });
  assert.equal(controller.signal.aborted, true);
  assert.equal(sessionStatus, 'idle');
  assert.equal(requestStatus, 'completed');
  assert.deepEqual(events, [{ type: 'status', status: 'stopped' }]);
  const afterCrash = new Runs(manager, { error(error) { throw error; } });
  const startable = afterCrash as unknown as { startAcceptedExecution: (...args: unknown[]) => void };
  t.mock.method(startable, 'startAcceptedExecution', () => { throw new Error('Stopped message was dispatched'); });
  t.mock.method(afterCrash as unknown as { retryPendingGrantCleanup: () => Promise<void> }, 'retryPendingGrantCleanup', async () => {});
  await afterCrash.recoverStale();
  assert.equal(acquisitions, 0);
});

test('Stop terminates Runtime when the claim wins before the active flag is set', async t => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  let sessionStatus = 'running', requestStatus = 'running';
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() { return { async limit() {
    return table === agentSessions ? [{ id: 'row-a', userId: 'alice', workspaceId: 'workspace-a', dshSessionId: 'session-a', status: sessionStatus }] :
      table === workspaces ? [{ id: 'workspace-a', userId: 'alice' }] : [];
  } }; } }; } }) as never);
  let attemptedQueuedStop = 0, runtimeCancels = 0, journalWrites = 0;
  t.mock.method(db, 'transaction', async (work: (tx: unknown) => Promise<unknown>) => work({
    update(table: unknown) {
      return { set(values: { status: string }) { return { where() { return { async returning() {
        if (table === agentMessageRequests) {
          attemptedQueuedStop++;
          if (attemptedQueuedStop === 1) return [];
          assert.equal(requestStatus, 'running');
          requestStatus = values.status;
          return [{ requestId }];
        }
        assert.equal(table, agentSessions);
        sessionStatus = values.status;
        return [{ id: 'row-a' }];
      } }; } }; } };
    },
    insert(table: unknown) { assert.equal(table, agentEvents); return { async values(value: { event: unknown }) {
      assert.deepEqual(value.event, { type: 'status', status: 'stopped' });
      journalWrites++;
    } }; },
  }) as never);
  const manager = {
    leases: { async withLock(_key: string, work: () => Promise<unknown>) { return work(); } },
    async request(_user: string, suffix: string) {
      assert.equal(suffix, '/sessions/session-a/cancel');
      runtimeCancels++;
      return Response.json({ ok: true });
    },
  } as unknown as RuntimeManager;
  const runs = new Runs(manager, { error(error) { throw error; } });
  const controller = new AbortController();
  runs['active'].set('session-a', {
    userId: 'alice', sessionId: 'session-a', sessionRowId: 'row-a', requestId, runId: 'run-a', token: 'lock-token',
    controller, promise: Promise.resolve(), cancelling: false, started: false,
  });
  assert.deepEqual(await runs.cancel('alice', 'session-a'), { ok: true });
  assert.equal(attemptedQueuedStop, 2);
  assert.equal(runtimeCancels, 1);
  assert.equal(journalWrites, 1);
  assert.equal(requestStatus, 'completed');
  assert.equal(sessionStatus, 'idle');
  assert.equal(controller.signal.aborted, true);
});

test('Stop durably closes a running request without an active manager or Redis lease', async t => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  let sessionStatus = 'running', requestStatus = 'running', requestLookups = 0;
  let runtimeCancels = 0, clearedBusy = 0, acquisitions = 0, dispatched = 0;
  const events: unknown[] = [];
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() {
    const rows = table === agentSessions ? [{ id: 'row-a', userId: 'alice', workspaceId: 'workspace-a', dshSessionId: 'session-a', status: sessionStatus }] :
      table === workspaces ? [{ id: 'workspace-a', userId: 'alice' }] :
      table === agentMessageRequests && ++requestLookups === 2 ? [{ requestId, runId: 'run-a' }] : [];
    return { then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
      return Promise.resolve(table === agentSessions && sessionStatus !== 'running' ? [] : rows).then(resolve, reject);
    }, async limit() { return rows; } };
  } }; } }) as never);
  t.mock.method(db, 'transaction', async (work: (tx: unknown) => Promise<unknown>) => work({
    update(table: unknown) { return { set(values: { status: string }) { return { where() { return { async returning() {
      if (table === agentMessageRequests) {
        assert.equal(requestStatus, 'running');
        requestStatus = values.status;
        return [{ requestId }];
      }
      assert.equal(table, agentSessions);
      sessionStatus = values.status;
      return [{ id: 'row-a' }];
    } }; } }; } }; },
    insert(table: unknown) { assert.equal(table, agentEvents); return { async values(value: { event: unknown }) { events.push(value.event); } }; },
  }) as never);
  const manager = {
    leases: {
      redis: { async exists() { return 0; } },
      async withLock(_key: string, work: () => Promise<unknown>) { return work(); },
      async acquire() { acquisitions++; throw new Error('Stopped request was restarted'); },
      async clearBusy() { clearedBusy++; },
    },
    async request(_user: string, suffix: string) {
      assert.equal(suffix, '/sessions/session-a/cancel');
      runtimeCancels++;
      return Response.json({ ok: true });
    },
  } as unknown as RuntimeManager;
  const runs = new Runs(manager, { error(error) { throw error; } });
  assert.deepEqual(await runs.cancel('alice', 'session-a'), { ok: true });
  assert.equal(runtimeCancels, 1);
  assert.equal(requestStatus, 'completed');
  assert.equal(sessionStatus, 'idle');
  assert.deepEqual(events, [{ type: 'status', status: 'stopped' }]);
  assert.equal(clearedBusy, 1);
  const afterCrash = new Runs(manager, { error(error) { throw error; } });
  const startable = afterCrash as unknown as { startAcceptedExecution: (...args: unknown[]) => void };
  t.mock.method(startable, 'startAcceptedExecution', () => { dispatched++; });
  t.mock.method(afterCrash as unknown as { retryPendingGrantCleanup: () => Promise<void> }, 'retryPendingGrantCleanup', async () => {});
  await afterCrash.recoverStale();
  assert.equal(acquisitions, 0);
  assert.equal(dispatched, 0);
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
  const manager = { leases: {
    redis: { async exists() { return 0; } },
    async withLock(_key: string, work: () => Promise<unknown>) { return work(); },
  }, async request() { throw new Error('No execution should be cancelled'); } } as unknown as RuntimeManager;
  const runs = new Runs(manager, { error() {} });
  assert.deepEqual(await runs.cancel('alice', 'session-a'), { ok: true });
  status = 'idle';
  assert.deepEqual(await runs.cancel('alice', 'session-a'), { ok: true });
  assert.equal(writes, 0);
});
