import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '@cloud-work/database';
import { McpGateway } from '../src/mcp.js';
import { mcpControlAlias, networkNames, readConfig, runtimeEnvironment } from '../src/config.js';
import { RuntimeManager } from '../src/lifecycle.js';
import { Runs, mcpRunKey } from '../src/runs.js';
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
      let updates = 0;
      context.mock.method(db, 'update', () => ({ set() { return { async where() { updates++; } }; } }) as never);
      const pipeline = { xadd() { actions.push('event'); return pipeline; }, expire() { return pipeline; }, async exec() { return [[null, 1]]; } };
      const manager = {
        config: { ...config, heartbeatMs: scenario === 'renew-failure' ? 5 : 60_000 },
        leases: {
          redis: { async set(key: string, value: string) { stored.set(key, value); }, async del(key: string) { stored.delete(key); }, multi() { return pipeline; } },
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
          async revoke() { actions.push('revoke'); if (scenario === 'revoke-failure') throw new Error('Gateway unavailable'); },
          async renew() { actions.push('renew'); throw new Error('Gateway lease lost'); },
        },
        async ensureRuntime() {}, async touchRuntime() {},
        async request(_user: string, suffix: string, init: RequestInit) {
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
      await runs['execute']({ userId: 'alice', sessionId: 'session-a', token: 'lock-token', controller: new AbortController(), promise: Promise.resolve(), cancelling: false, started: false }, 'workspace-a', 'Hello');
      assert.ok(actions.includes('revoke'));
      if (scenario === 'stream-failure') assert.ok(actions.indexOf('cancel-confirmed') < actions.indexOf('revoke'));
      if (scenario === 'renew-failure') {
        assert.ok(actions.includes('renew'));
        assert.ok(actions.indexOf('cancel-confirmed') < actions.indexOf('revoke'));
      }
      if (scenario === 'terminal') assert.ok(actions.indexOf('event') < actions.indexOf('revoke'));
      if (scenario === 'issue-failure') assert.ok(!actions.includes('run'));
      if (scenario === 'revoke-failure') {
        assert.equal(updates, 0);
        assert.ok(stored.has(mcpRunKey('session-a')));
        assert.ok(!actions.includes('clear-busy'));
      } else {
        assert.equal(stored.size, 0);
        assert.ok(actions.indexOf('revoke') < actions.indexOf('clear-busy'));
      }
      assert.ok([...stored.values()].every(value => value !== grant.token));
    });
  }
});

test('stale-run recovery revokes durable run identifiers only after execution is terminated', async t => {
  const actions: string[] = [];
  t.mock.method(db, 'select', () => ({ from() { return { async where() { return [{ id: 'row-a', userId: 'alice', dshSessionId: 'session-a', workspaceId: 'workspace-a' }]; } }; } }) as never);
  t.mock.method(db, 'update', () => ({ set() { return { async where() { actions.push('database'); } }; } }) as never);
  const pipeline = { xadd() { return pipeline; }, expire() { return pipeline; }, async exec() { return [[null, 1]]; } };
  const manager = {
    leases: {
      redis: { async exists() { return 0; }, async get(key: string) { assert.equal(key, mcpRunKey('session-a')); return 'run-a'; }, async del() { actions.push('delete-pointer'); }, multi() { return pipeline; } },
      async withLock(_key: string, operation: () => Promise<void>) { await operation(); }, async clearBusy() { actions.push('clear-busy'); },
    },
    async request(user: string, suffix: string) { assert.equal(user, 'alice'); assert.equal(suffix, '/sessions/session-a/cancel'); actions.push('cancel-confirmed'); return Response.json({ ok: true }); },
    mcp: { async revoke(user: string, runId: string) { assert.deepEqual([user, runId], ['alice', 'run-a']); actions.push('revoke'); } },
  } as unknown as RuntimeManager;
  await new Runs(manager, silent).recoverStale();
  assert.deepEqual(actions, ['cancel-confirmed', 'revoke', 'delete-pointer', 'database', 'clear-busy']);
});
