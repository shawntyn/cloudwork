import test from 'node:test';
import assert from 'node:assert/strict';
import { agentEvents, agentMessageRequests, agentSessions, db, workspaces } from '@cloud-work/database';
import { McpGateway } from '../src/mcp.js';
import { mcpControlAlias, networkNames, readConfig, runtimeEnvironment } from '../src/config.js';
import { RuntimeManager } from '../src/lifecycle.js';
import { Runs, mcpRunKey, sessionLock, workspaceLock } from '../src/runs.js';
import { createServer } from '../src/server.js';
import type { Leases } from '../src/leases.js';

const env = {
  DATABASE_URL: 'postgres://db', REDIS_URL: 'redis://redis', MANAGER_TOKEN: 'manager-only', RUNTIME_TOKEN_SECRET: 'derive-only',
  MCP_GATEWAY_ADMIN_TOKEN: 'gateway-admin-secret-'.repeat(3), MCP_MASTER_KEY: 'master-only-secret',
};
const config = readConfig(env);
const grant = { id: 'connection-a', serverName: 'server_a', path: '/mcp/grant-a', token: 'a'.repeat(48) };
const snapshotResponse = (connections: unknown[] = [grant], runId = 'run-a') => ({ snapshot: { runId, revision: 'revision-a', connections } });
const silent = { info() {}, error() {} };

test('MCP service configuration and per-user DNS aliases keep admin authority out of tenant environments', () => {
  assert.equal(config.mcpGatewayUrl, 'http://mcp-gateway:4100');
  assert.equal(config.mcpGatewayContainer, 'cloud-work-mcp-gateway');
  assert.match(mcpControlAlias('A'.repeat(100)), /^[a-z0-9-]{1,63}$/);
  assert.notEqual(mcpControlAlias('alice'), mcpControlAlias('Alice'));
  for (const secret of [env.MCP_GATEWAY_ADMIN_TOKEN, env.MCP_MASTER_KEY]) assert.ok(!runtimeEnvironment(config, 'alice').join('\n').includes(secret));
  for (const url of ['file:///tmp/secret', 'https://user:password@gateway', 'http://gateway/path', 'http://gateway?x=1', 'http://gateway#x']) assert.throws(() => readConfig({ ...env, MCP_GATEWAY_URL: url }));
  assert.throws(() => readConfig({ ...env, MCP_GATEWAY_ADMIN_TOKEN: 'short' }));
});

test('gateway RPC fetches only the fixed admin origin and snapshots rewrite paths to this tenant DNS alias', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new McpGateway(config, async (input, init) => { calls.push({ url: String(input), init }); return Response.json(snapshotResponse()); });
  const snapshot = await client.snapshot('alice', 'run-a', 'workspace-a', 'session-a');
  assert.equal(calls[0]!.url, 'http://mcp-gateway:4100/internal/users/alice/runs/run-a/mcp');
  assert.equal(calls[0]!.init?.redirect, 'error');
  assert.equal(new Headers(calls[0]!.init?.headers).get('authorization'), `Bearer ${env.MCP_GATEWAY_ADMIN_TOKEN}`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { workspaceId: 'workspace-a', sessionId: 'session-a' });
  assert.deepEqual(snapshot.connections, [{ id: grant.id, serverName: grant.serverName, url: `http://${mcpControlAlias('alice')}:4100/mcp/grant-a`, token: grant.token }]);
  assert.ok(!JSON.stringify(snapshot).includes(env.MCP_GATEWAY_ADMIN_TOKEN));
  for (const suffix of ['https://attacker.example', '//attacker.example', '/mcp/connections/../runs', '/mcp/connections?url=http://attacker.example']) await assert.rejects(client.request('alice', suffix));
  assert.equal(calls.length, 1);
});

test('snapshot validation rejects other runs, arbitrary destinations, encoded paths and duplicate servers', async () => {
  for (const path of ['https://attacker.example/mcp/a', '//attacker.example', '/mcp/../admin', '/mcp/%2e%2e', '/mcp/a?key=secret', '/mcp/a#fragment']) {
    const client = new McpGateway(config, async () => Response.json(snapshotResponse([{ ...grant, path }])));
    await assert.rejects(client.snapshot('alice', 'run-a', 'workspace-a', 'session-a'), /Invalid MCP run connection/);
  }
  const duplicate = new McpGateway(config, async () => Response.json(snapshotResponse([grant, grant])));
  await assert.rejects(duplicate.snapshot('alice', 'run-a', 'workspace-a', 'session-a'));
  const otherRun = new McpGateway(config, async () => Response.json(snapshotResponse([], 'run-b')));
  await assert.rejects(otherRun.snapshot('alice', 'run-a', 'workspace-a', 'session-a'));
});

test('gateway errors and oversized responses cannot echo credential-bearing upstream content', async () => {
  const client = new McpGateway(config, async () => new Response('upstream-secret-token', { status: 502 }));
  await assert.rejects(client.request('alice', '/mcp/connections'), error => error instanceof Error && error.message === 'MCP gateway request failed (HTTP 502)');
  const oversized = new McpGateway(config, async () => new Response('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(oversized.request('alice', '/mcp/connections'), /too large/);
});

test('MCP management routes require manager authority and keep user scope in the route', async () => {
  const calls: unknown[][] = [], activities: unknown[] = [];
  const manager = {
    config,
    mcp: { async request(...args: unknown[]) { calls.push(args); return { ok: true }; } },
    async withActivity(user: string, operation: () => Promise<unknown>, ensureRuntime: boolean) { activities.push([user, ensureRuntime]); return operation(); },
  } as unknown as RuntimeManager;
  const server = createServer(manager, {} as Runs);
  server.setReady();
  try {
    const url = '/internal/users/alice/mcp/connections/connection-a/test';
    assert.equal((await server.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${grant.token}` } })).statusCode, 401);
    const headers = { authorization: `Bearer ${config.managerToken}` };
    assert.equal((await server.app.inject({ method: 'POST', url, headers })).statusCode, 200);
    assert.deepEqual(activities, [['alice', false]]);
    assert.deepEqual(calls[0], ['alice', '/mcp/connections/connection-a/test', 'POST', undefined, 90_000]);
    assert.equal((await server.app.inject({ method: 'POST', url: '/internal/users/alice/mcp/connections', headers, payload: { userId: 'bob', name: 'Example' } })).statusCode, 200);
    assert.equal(calls[1]![0], 'alice');
    assert.equal(calls[1]![1], '/mcp/connections');
  } finally { await server.app.close(); }
});

test('message admission requires a request ID and returns its durable status', async () => {
  const calls: unknown[][] = [];
  const manager = { config } as RuntimeManager;
  const runs = { async launch(...args: unknown[]) { calls.push(args); return { requestStatus: 'queued' }; } } as Runs;
  const server = createServer(manager, runs);
  server.setReady();
  try {
    const url = '/internal/users/alice/sessions/session-a/messages';
    const headers = { authorization: `Bearer ${config.managerToken}`, 'content-type': 'application/json' };
    assert.equal((await server.app.inject({ method: 'POST', url, headers, payload: { prompt: 'Hello' } })).statusCode, 400);
    assert.equal((await server.app.inject({ method: 'POST', url, headers, payload: { prompt: 'Hello', requestId: 'bad' } })).statusCode, 400);
    assert.deepEqual(calls, []);
    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    const response = await server.app.inject({ method: 'POST', url, headers, payload: JSON.stringify({ prompt: 'Hello', requestId }) });
    assert.equal(response.statusCode, 202, response.body);
    assert.deepEqual(response.json(), { accepted: true, requestStatus: 'queued' });
    assert.deepEqual(calls, [['alice', 'session-a', 'Hello', requestId]]);
  } finally { await server.app.close(); }
});

test('workspace MCP bindings cannot bypass manager ownership checks', async t => {
  t.mock.method(db, 'select', () => ({ from() { return { where() { return { async limit() { return []; } }; } }; } }) as never);
  let forwarded = false;
  const manager = {
    config,
    leases: { async withLock(_key: string, operation: () => Promise<unknown>) { return operation(); } },
    mcp: { async request() { forwarded = true; } },
  } as unknown as RuntimeManager;
  const server = createServer(manager, {} as Runs);
  server.setReady();
  try {
    const response = await server.app.inject({ method: 'PUT', url: '/internal/users/alice/workspaces/bobs-workspace/mcp', headers: { authorization: `Bearer ${config.managerToken}` }, payload: { connectionIds: ['connection-a'] } });
    assert.equal(response.statusCode, 404);
    assert.equal(forwarded, false);
  } finally { await server.app.close(); }
});

test('gateway connects only to the owned user control network and cleanup disconnects it', async () => {
  const networks = networkNames('alice'), connected: Array<{ name: string; value: unknown }> = [], disconnected: string[] = [], removed: string[] = [];
  const info = (name: string, id: string) => ({ Id: id, Name: `/${name}`, State: { Running: true }, NetworkSettings: { Networks: {} } });
  const containers: Record<string, unknown> = {
    [config.managerContainer]: info(config.managerContainer, 'manager-id'), [config.mcpGatewayContainer]: info(config.mcpGatewayContainer, 'gateway-id'),
    'manager-id': info(config.managerContainer, 'manager-id'), 'gateway-id': info(config.mcpGatewayContainer, 'gateway-id'),
  };
  const manager = new RuntimeManager(config, { async isBusy() { return false; } } as unknown as Leases, silent);
  manager.docker = {
    getContainer(id: string) { return { async inspect() { return containers[id]; }, async remove() {} }; },
    getNetwork(name: string) { return {
      async inspect() { return { Internal: name === networks.control, Labels: { 'cloud-work.managed': 'true', 'cloud-work.user-id': 'alice' }, Containers: name === networks.control ? { 'manager-id': {}, 'gateway-id': {} } : {} }; },
      async connect(value: unknown) { connected.push({ name, value }); },
      async disconnect(value: { Container: string }) { disconnected.push(value.Container); },
      async remove() { removed.push(name); },
    }; },
  } as unknown as RuntimeManager['docker'];
  await manager['ensureNetworks']('alice');
  assert.deepEqual(connected, [
    { name: networks.control, value: { Container: config.managerContainer } },
    { name: networks.control, value: { Container: 'gateway-id', EndpointConfig: { Aliases: [mcpControlAlias('alice')] } } },
  ]);
  manager.hasRunningSessions = async () => false;
  manager.inspect = async () => ({ Id: 'runtime-id', State: { Running: false } }) as Awaited<ReturnType<RuntimeManager['inspect']>>;
  manager.setStatus = async () => ({}) as Awaited<ReturnType<RuntimeManager['setStatus']>>;
  await manager.removeUnlocked('alice');
  assert.deepEqual(disconnected, ['manager-id', 'gateway-id']);
  assert.deepEqual(removed, [networks.control, networks.egress]);
});

test('run cleanup revokes MCP grants after terminal or confirmed cancellation and retains failed cleanup for recovery', async t => {
  for (const scenario of ['terminal', 'stream-failure', 'issue-failure', 'revoke-failure', 'renew-failure'] as const) {
    await t.test(scenario, async context => {
      const actions: string[] = [], stored = new Map<string, string>();
      let receiptStatus = 'queued', grantRevoked = false, gatewayAvailable = scenario !== 'revoke-failure';
      const update = (table: unknown) => ({ set(values: { status?: string; mcpRevokedAt?: Date }) { return { where() {
        if (table === agentMessageRequests) {
          if (values.status === 'running') {
            assert.equal(receiptStatus, 'queued');
            actions.push('claim-receipt');
          } else if (values.status) actions.push('finish-receipt');
          else if (values.mcpRevokedAt) { actions.push('mark-grant-revoked'); grantRevoked = true; }
          receiptStatus = values.status ?? receiptStatus;
          return { async returning() { return [{ requestId: 'request-a' }]; } };
        }
        assert.equal(table, agentSessions);
        actions.push('finish-session');
        return Promise.resolve();
      } }; } });
      context.mock.method(db, 'update', update as never);
      context.mock.method(db, 'transaction', async (work: (tx: unknown) => Promise<unknown>) => work({ update, insert(table: unknown) {
        assert.equal(table, agentEvents);
        return { values() { actions.push('database-event'); return Promise.resolve(); } };
      } }) as never);
      context.mock.method(db, 'insert', ((table: unknown) => {
        assert.equal(table, agentEvents);
        return { values() { actions.push('database-event'); return { async returning() { return [{ streamMs: 1800000000000000 }]; } }; } };
      }) as never);
      context.mock.method(db, 'select', () => ({ from(table: unknown) {
        if (table === workspaces) return { where() { return { async limit() {
          actions.push('workspace-checked');
          return [{ id: 'workspace-a', userId: 'alice' }];
        } }; } };
        assert.equal(table, agentMessageRequests);
        return { innerJoin() { return { where() { return { orderBy() { return { async limit() {
          return grantRevoked ? [] : [{ sessionRowId: 'row-a', requestId: 'request-a', runId: 'run-a', userId: 'alice', sessionId: 'session-a' }];
        } }; } }; } }; } };
      } }) as never);
      const pipeline = { xadd() { actions.push('event'); return pipeline; }, expire() { return pipeline; }, async exec() { return [[null, 1]]; } };
      const manager = {
        config: { ...config, heartbeatMs: scenario === 'renew-failure' ? 5 : 60_000 },
        leases: {
          redis: {
            async set(key: string, value: string) { stored.set(key, value); },
            async get(key: string) { return key === sessionLock('session-a') ? 'lock-token' : stored.get(key) ?? null; },
            async eval(_script: string, _keys: number, key: string, expected: string) { if (stored.get(key) === expected) stored.delete(key); },
            multi() { return pipeline; },
          },
          async withLock(_key: string, work: () => Promise<unknown>) { return work(); },
          async clearBusy() { actions.push('clear-busy'); }, async release() { actions.push('release'); },
          async renew() {}, async setBusy() {},
        },
        mcp: {
          async snapshot(_user: string, runId: string) {
            actions.push('issue');
            assert.equal(stored.get(mcpRunKey('session-a')), runId);
            if (scenario === 'issue-failure') throw new Error('Issue response lost');
            return { runId, revision: 'revision-a', connections: [{ ...grant, url: 'http://gateway/mcp/grant-a' }] };
          },
          async revoke() { actions.push('revoke'); if (!gatewayAvailable) throw new Error('Gateway unavailable'); },
          async renew() { actions.push('renew'); throw new Error('Gateway lease lost'); },
        },
        async ensureRuntime() {}, async touchRuntime() {},
        async request(_user: string, suffix: string, init: RequestInit) {
          if (suffix === '/workspaces/workspace-a') actions.push('prepare-workspace');
          if (suffix === '/sessions/session-a') actions.push('prepare-session');
          if (suffix.endsWith('/run')) {
            actions.push('run');
            const body = JSON.parse(String(init.body));
            assert.equal(body.mcp.connections[0].token, grant.token);
            assert.equal(body.prompt, 'Hello');
            if (scenario === 'renew-failure') {
              await new Promise<void>((_resolve, reject) => {
                const watchdog = setTimeout(() => reject(new Error('Missing grant renewal')), 2000);
                init.signal!.addEventListener('abort', () => { clearTimeout(watchdog); reject(init.signal!.reason); }, { once: true });
              });
            }
            return new Response(scenario === 'stream-failure' ? '' : 'data: {"type":"status","status":"idle"}\n\n');
          }
          if (suffix.endsWith('/cancel')) actions.push('cancel-confirmed');
          return Response.json({ ok: true });
        },
      } as unknown as RuntimeManager;
      const runs = new Runs(manager, silent);
      await runs['execute']({ userId: 'alice', sessionId: 'session-a', sessionRowId: 'row-a', requestId: 'request-a', runId: 'run-a', token: 'lock-token', controller: new AbortController(), promise: Promise.resolve(), cancelling: false, started: false }, 'workspace-a', 'Hello');
      assert.ok(actions.includes('revoke'));
      assert.ok(actions.indexOf('workspace-checked') < actions.indexOf('prepare-workspace'));
      assert.ok(actions.indexOf('prepare-workspace') < actions.indexOf('prepare-session'));
      if (actions.includes('run')) assert.ok(actions.indexOf('claim-receipt') < actions.indexOf('run'));
      if (scenario === 'stream-failure') assert.ok(actions.indexOf('cancel-confirmed') < actions.indexOf('revoke'));
      if (scenario === 'renew-failure') {
        assert.ok(actions.includes('renew'));
        assert.ok(actions.indexOf('cancel-confirmed') < actions.indexOf('revoke'));
      }
      if (scenario === 'terminal') {
        assert.ok(actions.indexOf('finish-receipt') < actions.indexOf('database-event'));
        assert.ok(actions.indexOf('database-event') < actions.indexOf('finish-session'));
        assert.ok(actions.indexOf('finish-session') < actions.indexOf('revoke'));
      }
      if (scenario === 'issue-failure') assert.ok(!actions.includes('run'));
      if (scenario === 'revoke-failure') {
        assert.equal(receiptStatus, 'completed');
        assert.equal(grantRevoked, false);
        assert.ok(stored.has(mcpRunKey('session-a')));
        assert.ok(actions.includes('clear-busy'));
        gatewayAvailable = true;
        await runs['retryPendingGrantCleanup']();
        assert.equal(grantRevoked, true);
        assert.equal(stored.size, 0);
        assert.ok(actions.lastIndexOf('revoke') < actions.indexOf('mark-grant-revoked'));
      } else {
        assert.equal(receiptStatus, scenario === 'terminal' ? 'completed' : 'failed');
        assert.equal(stored.size, 0);
        if (scenario !== 'issue-failure') assert.equal(grantRevoked, true);
        assert.ok(actions.indexOf('revoke') < actions.indexOf('clear-busy'));
      }
      assert.ok([...stored.values()].every(value => value !== grant.token));
    });
  }
});

test('a removed workspace is checked under its lock before Runtime preparation', async t => {
  let workspaceChecks = 0, runtimeRequests = 0, receiptStatus = 'queued';
  const actions: string[] = [], events: unknown[] = [];
  t.mock.method(db, 'select', () => ({ from(table: unknown) {
    assert.equal(table, workspaces);
    return { where() { return { async limit() { workspaceChecks++; actions.push('workspace-checked'); return []; } }; } };
  } }) as never);
  t.mock.method(db, 'transaction', async (work: (tx: unknown) => Promise<unknown>) => work({
    update(table: unknown) { return { set(values: { status: string }) { return { where() {
      if (table === agentMessageRequests) return { async returning() { receiptStatus = values.status; return [{ requestId: 'request-a' }]; } };
      assert.equal(table, agentSessions);
      return Promise.resolve();
    } }; } }; },
    insert(table: unknown) { assert.equal(table, agentEvents); return { async values(rows: Array<{ event: unknown }>) { events.push(...rows.map(row => row.event)); } }; },
  }) as never);
  const manager = {
    config,
    leases: {
      redis: { async get(key: string) { assert.equal(key, sessionLock('session-a')); return 'lock-token'; } },
      async withLock(key: string, work: () => Promise<unknown>) { assert.equal(key, workspaceLock('workspace-a')); actions.push('workspace-lock'); return work(); },
      async clearBusy() {}, async release() {},
    },
    async ensureRuntime() {}, async touchRuntime() {},
    async request() { runtimeRequests++; throw new Error('Deleted workspace reached Runtime'); },
  } as unknown as RuntimeManager;
  const runs = new Runs(manager, silent);
  await runs['execute']({
    userId: 'alice', sessionId: 'session-a', sessionRowId: 'row-a', requestId: 'request-a', runId: 'run-a', token: 'lock-token',
    controller: new AbortController(), promise: Promise.resolve(), cancelling: false, started: false,
  }, 'workspace-a', 'Hello');
  assert.deepEqual(actions, ['workspace-lock', 'workspace-checked']);
  assert.equal(workspaceChecks, 1);
  assert.equal(runtimeRequests, 0);
  assert.equal(receiptStatus, 'failed');
  assert.deepEqual(events.at(-1), { type: 'status', status: 'error' });
});

test('stale-run recovery revokes durable run identifiers only after execution is terminated', async t => {
  const actions: string[] = [];
  const session = { id: 'row-a', userId: 'alice', dshSessionId: 'session-a', workspaceId: 'workspace-a', status: 'running' };
  let requestLookup = 0;
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() {
    const rows = table === agentSessions ? [session] :
      table === agentMessageRequests && ++requestLookup === 2 ? [{ requestId: 'request-a', runId: 'run-a', status: 'running' }] : [];
    return { then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve(rows).then(resolve, reject); }, async limit() { return rows; } };
  } }; } }) as never);
  t.mock.method(db, 'transaction', async (work: (tx: unknown) => Promise<unknown>) => work({
    update(table: unknown) { return { set(values: { status?: string }) { return { where() {
      actions.push(table === agentMessageRequests ? `receipt-${values.status}` : 'session-error');
      return { async returning() { return table === agentMessageRequests ? [{ requestId: 'request-a' }] : [{ id: 'row-a' }]; } };
    } }; } }; },
    insert(table: unknown) { assert.equal(table, agentEvents); return { async values() { actions.push('database-event'); } }; },
  }) as never);
  t.mock.method(db, 'update', (table: unknown) => ({ set(values: { mcpRevokedAt?: Date }) { return { async where() {
    assert.equal(table, agentMessageRequests);
    assert.ok(values.mcpRevokedAt);
    actions.push('mark-grant-revoked');
  } }; } }) as never);
  const manager = {
    leases: {
      redis: {
        async exists() { return 0; },
        async get(key: string) { assert.equal(key, mcpRunKey('session-a')); return 'run-a'; },
        async eval() { actions.push('delete-pointer'); },
      },
      async withLock(_key: string, operation: () => Promise<void>) { await operation(); }, async clearBusy() { actions.push('clear-busy'); },
    },
    async request(user: string, suffix: string) { assert.equal(user, 'alice'); assert.equal(suffix, '/sessions/session-a/cancel'); actions.push('cancel-confirmed'); return Response.json({ ok: true }); },
    mcp: { async revoke(user: string, runId: string) { assert.deepEqual([user, runId], ['alice', 'run-a']); actions.push('revoke'); } },
  } as unknown as RuntimeManager;
  const runs = new Runs(manager, silent);
  const startable = runs as unknown as { startAcceptedExecution: (...args: unknown[]) => void };
  t.mock.method(startable, 'startAcceptedExecution', () => { actions.push('replayed-run'); });
  t.mock.method(runs as unknown as { retryPendingGrantCleanup: () => Promise<void> }, 'retryPendingGrantCleanup', async () => {});
  await runs.recoverStale();
  assert.deepEqual(actions, ['cancel-confirmed', 'receipt-failed', 'session-error', 'database-event', 'clear-busy', 'revoke', 'delete-pointer', 'mark-grant-revoked']);
});

test('stale-run recovery does not overwrite a request that lost its CAS', async t => {
  const actions: string[] = [];
  const session = { id: 'row-a', userId: 'alice', dshSessionId: 'session-a', workspaceId: 'workspace-a', status: 'running' };
  let requestLookup = 0;
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() {
    const rows = table === agentSessions ? [session] :
      table === agentMessageRequests && ++requestLookup === 2 ? [{ requestId: 'request-a', runId: 'old-run', status: 'running' }] : [];
    return { then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve(rows).then(resolve, reject); }, async limit() { return rows; } };
  } }; } }) as never);
  t.mock.method(db, 'transaction', async (work: (tx: unknown) => Promise<unknown>) => work({
    update(table: unknown) {
      assert.equal(table, agentMessageRequests, 'Session status must remain untouched after the request CAS fails');
      return { set() { return { where() { actions.push('receipt-cas-failed'); return { async returning() { return []; } }; } }; } };
    },
    insert() { throw new Error('A newer run must not receive an interrupted event'); },
  }) as never);
  t.mock.method(db, 'update', () => ({ set() { return { async where() { actions.push('old-grant-mark-attempted'); } }; } }) as never);
  const manager = {
    leases: {
      redis: { async exists() { return 0; }, async eval() { actions.push('old-pointer-cleared'); } },
      async withLock(_key: string, operation: () => Promise<unknown>) { return operation(); },
      async clearBusy() { throw new Error('A newer run must retain its activity'); },
    },
    async request(_user: string, suffix: string) { assert.equal(suffix, '/sessions/session-a/cancel'); actions.push('cancel-confirmed'); return Response.json({ ok: true }); },
    mcp: { async revoke(_user: string, runId: string) { assert.equal(runId, 'old-run'); actions.push('old-grant-revoked'); } },
  } as unknown as RuntimeManager;
  const runs = new Runs(manager, silent);
  t.mock.method(runs as unknown as { retryPendingGrantCleanup: () => Promise<void> }, 'retryPendingGrantCleanup', async () => {});
  await runs.recoverStale();
  assert.deepEqual(actions, ['cancel-confirmed', 'receipt-cas-failed', 'old-grant-revoked', 'old-pointer-cleared', 'old-grant-mark-attempted']);
});

test('one unrecoverable tenant retains running metadata without blocking recovery of another tenant', async t => {
  const recovered: string[] = [], deferred: string[] = [];
  const sessions = ['alice', 'bob'].map(user => ({ id: user, userId: user, dshSessionId: user, workspaceId: user, status: 'running' }));
  let currentSession = 0;
  t.mock.method(db, 'select', () => ({ from(table: unknown) { return { where() {
    const rows = table === agentSessions ? sessions : [];
    return { then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve(rows).then(resolve, reject); },
      async limit() { return table === agentSessions ? [sessions[currentSession++]] : rows; } };
  } }; } }) as never);
  t.mock.method(db, 'transaction', async (work: (tx: unknown) => Promise<unknown>) => work({
    update() { return { set() { return { where() { return { async returning() { return [{ id: 'bob' }]; } }; } }; } }; },
    insert() { return { async values() {} }; },
  }) as never);
  const manager = {
    leases: {
      redis: { async exists() { return 0; }, async get() { return null; } },
      async withLock(_key: string, operation: () => Promise<void>) { await operation(); },
      async withUserLock(_key: string, operation: () => Promise<void>) { await operation(); },
      async clearBusy(user: string) { recovered.push(user); },
    },
    async request(user: string) { if (user === 'alice') throw new Error('offline'); return Response.json({ ok: true }); },
    async stopUnlocked() { throw new Error('Docker unavailable'); },
  } as unknown as RuntimeManager;
  const runs = new Runs(manager, { error(_error, message) { if (message?.includes('deferred')) deferred.push(message); } });
  t.mock.method(runs as unknown as { retryPendingGrantCleanup: () => Promise<void> }, 'retryPendingGrantCleanup', async () => {});
  await runs.recoverStale();
  assert.deepEqual(recovered, ['bob']);
  assert.equal(deferred.length, 1);
});
