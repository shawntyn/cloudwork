import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type Docker from 'dockerode';
import { RuntimeManager } from '../src/lifecycle.js';
import { readConfig, networkNames, runtimeName, runtimeControlAlias, mcpControlAlias } from '../src/config.js';
import { runtimeBinds, runtimeSpec, runtimeSpecLabel } from '../src/runtime-spec.js';
import type { Leases } from '../src/leases.js';

const config = readConfig({
  DATABASE_URL: 'postgres://db', REDIS_URL: 'redis://redis', MANAGER_TOKEN: 'manager', RUNTIME_TOKEN_SECRET: 'derive',
  MCP_GATEWAY_ADMIN_TOKEN: 'gateway-'.repeat(8),
});
const silent = { info() {}, error() {} };
const image = `sha256:${'b'.repeat(64)}`;
const source = `sha256:${'c'.repeat(64)}`;

function fixture() {
  const user = 'alice', networks = networkNames(user), actions: string[] = [];
  let busy = false, runningSessions = false, failHealth = false, failNewHealth = false;
  let runtimeActivity = { activeSessions: 0, activeTransfers: 0, uploadBatches: 0 };
  let lock = Promise.resolve();
  const leases = {
    async withUserLock<T>(_user: string, run: () => Promise<T>) {
      const previous = lock;
      let release!: () => void;
      lock = new Promise(resolve => { release = resolve; });
      await previous;
      try { return await run(); } finally { release(); }
    },
    async isBusy() { return busy; },
    async setBusy() { actions.push('admit'); busy = true; },
    async clearBusy() { busy = false; },
  };
  const manager = new RuntimeManager(config, leases as unknown as Leases, silent);
  manager.imageId = image;
  let runtime: Docker.ContainerInspectInfo | undefined = {
    Id: 'old', Image: 'old-image', State: { Running: true },
    Config: { Labels: { 'cloud-work.managed': 'true', 'cloud-work.user-id': user } },
    HostConfig: { Binds: runtimeBinds(config, user) },
    NetworkSettings: { Networks: Object.fromEntries([networks.control, networks.egress, config.network].map(name => [name, {
      IPAddress: '172.30.0.5', Aliases: [runtimeName(user), ...(name === networks.control ? [runtimeControlAlias(user)] : [])],
    }])) },
  } as unknown as Docker.ContainerInspectInfo;
  const services = new Map([config.managerContainer, config.mcpGatewayContainer].map(name => [name, {
    Id: name, Name: `/${name}`, State: { Running: true }, NetworkSettings: { Networks: {} as Record<string, unknown> },
  }]));
  let creates = 0;
  manager.docker = {
    getContainer(id: string) { return {
      async inspect() { if (services.has(id)) return services.get(id); if (!runtime) throw { statusCode: 404 }; return runtime; },
      async stop() { actions.push('stop'); runtime!.State.Running = false; },
      async remove(options: unknown) { assert.deepEqual(options, { v: false, force: false }); actions.push('remove'); runtime = undefined; },
      async start() { actions.push('start'); runtime!.State.Running = true; },
    }; },
    getNetwork(name: string) { return {
      async inspect() { return { Internal: name === networks.control, Labels: { 'cloud-work.managed': 'true', 'cloud-work.user-id': user } }; },
      async connect(options: { Container: string; EndpointConfig?: Record<string, unknown> }) {
        actions.push(`connect:${options.Container}:${name}`);
        const target = services.get(options.Container) ?? runtime!;
        target.NetworkSettings.Networks[name] = { IPAddress: '172.30.0.5', ...options.EndpointConfig };
      },
      async disconnect(options: { Container: string }) { actions.push('disconnect'); const target = services.get(options.Container) ?? runtime!; delete target.NetworkSettings.Networks[name]; },
      async remove() { actions.push('remove-network'); },
    }; },
    async createContainer(options: Docker.ContainerCreateOptions) {
      actions.push('create'); creates++;
      assert.equal(options.Image, image, 'Creation must use immutable image ID, never a mutable tag');
      assert.deepEqual(options.HostConfig!.Binds, runtimeBinds(config, user));
      runtime = { Id: `new-${creates}`, Image: options.Image, Config: { Labels: options.Labels }, HostConfig: options.HostConfig,
        State: { Running: false }, NetworkSettings: { Networks: options.NetworkingConfig!.EndpointsConfig },
      } as Docker.ContainerInspectInfo;
      return { id: runtime.Id, async inspect() { return runtime; } };
    },
  } as unknown as Docker;
  manager.hasRunningSessions = async () => runningSessions;
  manager.row = async () => ({ status: 'IDLE' }) as Awaited<ReturnType<RuntimeManager['row']>>;
  manager.setStatus = async (_user, status, id, touch = true) => {
    actions.push(`status:${status}:${touch}`);
    return { status, containerId: id } as Awaited<ReturnType<RuntimeManager['setStatus']>>;
  };
  manager['prepareDirectories'] = async () => ({ home: '/unused', workspaces: '/unused' });
  manager.request = async () => {
    if (failHealth && runtime?.Id === 'old') throw new Error('connection lost');
    return Response.json({ ok: true, ...runtimeActivity });
  };
  manager['waitHealthy'] = async () => { if (failNewHealth) throw new Error('sandbox failed'); };
  return {
    manager, actions, user, networks, services, get runtime() { return runtime; },
    current() { runtime!.Image = image; runtime!.Config.Labels![runtimeSpecLabel] = runtimeSpec(config, user); },
    busy(value: boolean) { busy = value; }, running(value: boolean) { runningSessions = value; },
    activity(value: Partial<typeof runtimeActivity>) { runtimeActivity = { activeSessions: 0, activeTransfers: 0, uploadBatches: 0, ...value }; },
    failHealth() { failHealth = true; }, failNewHealth() { failNewHealth = true; },
  };
}

test('same tag is refreshed on deployment change, reused on no-op, and failed builds do not select the old image', async () => {
  let built = 0, fail = false;
  let current = { Id: 'old', Config: { Labels: { 'cloud-work.runtime-source-image': 'old-source' } } };
  const manager = new RuntimeManager(config, {} as Leases, silent);
  manager.docker = {
    getImage() { return { async inspect() { return current; } }; },
    async buildImage(archive: Readable, options: { t: string }) {
      assert.equal(options.t, config.image);
      for await (const _chunk of archive) { /* Drain tar context as Docker does. */ }
      built++;
      if (fail) throw new Error('build failed');
      current = { Id: image, Config: { Labels: { 'cloud-work.runtime-source-image': source } } };
      return Readable.from([]);
    },
    modem: { followProgress(_stream: unknown, complete: (error: unknown) => void) { complete(null); } },
  } as unknown as Docker;
  await manager.prepareImage(source);
  assert.equal(built, 1); assert.equal(manager.imageId, image);
  await manager.prepareImage(source);
  assert.equal(built, 1);
  fail = true;
  const next = `sha256:${'d'.repeat(64)}`;
  await assert.rejects(manager.prepareImage(next), /build failed/);
});

test('idle legacy runtime is replaced on workspace entry and the next entry reuses it', async () => {
  const f = fixture();
  await f.manager.ensureRuntime(f.user);
  assert.equal(f.runtime!.Image, image);
  assert.equal(f.runtime!.Config.Labels![runtimeSpecLabel], runtimeSpec(config, f.user));
  assert.deepEqual(f.actions.filter(a => ['stop', 'remove', 'create', 'start'].includes(a)), ['stop', 'remove', 'create', 'start']);
  await f.manager.ensureRuntime(f.user);
  assert.equal(f.actions.filter(a => a === 'create').length, 1);
});

test('agents, external leases, transfers and between-file upload batches each postpone an update', async t => {
  for (const kind of ['lease', 'session', 'runtime-session', 'transfer', 'batch']) await t.test(kind, async () => {
    const f = fixture();
    if (kind === 'lease') f.busy(true);
    if (kind === 'session') f.running(true);
    if (kind === 'runtime-session') f.activity({ activeSessions: 1 });
    if (kind === 'transfer') f.activity({ activeTransfers: 1 });
    if (kind === 'batch') f.activity({ uploadBatches: 1 });
    await f.manager.ensureRuntime(f.user);
    assert.equal(f.runtime!.Id, 'old'); assert.ok(!f.actions.includes('remove'));
    f.busy(false); f.running(false); f.activity({});
    await f.manager.leases.withUserLock(f.user, () => f.manager.reconcileRuntimeUnlocked(f.user));
    assert.equal(f.runtime!.Image, image);
    assert.ok(f.actions.includes('status:RUNNING:false'), 'Background checks must not refresh user activity');
  });
});

test('stopped old runtime is retired without waking the user and next entry uses latest', async () => {
  const f = fixture(); f.runtime!.State.Running = false;
  await f.manager.reconcileRuntimeUnlocked(f.user);
  assert.equal(f.runtime, undefined); assert.ok(!f.actions.includes('create'));
  await f.manager.ensureRuntime(f.user);
  assert.equal(f.runtime!.Image, image);
});

test('a provider setting change replaces a current-image container without exposing secrets', async () => {
  const f = fixture(); f.current();
  f.runtime!.Config.Labels![runtimeSpecLabel] = runtimeSpec({ ...config, apiKey: 'previous-key' }, f.user);
  await f.manager.ensureRuntime(f.user);
  assert.ok(f.actions.includes('remove'));
  assert.match(runtimeSpec({ ...config, apiKey: 'sensitive-key' }, f.user), /^[a-f0-9]{64}$/);
  assert.notEqual(runtimeSpec({ ...config, maxTokens: 100 }, f.user), runtimeSpec(config, f.user));
});

test('manager/gateway recreation and missing runtime DNS alias are repaired without container replacement', async () => {
  const f = fixture(); f.current();
  f.runtime!.NetworkSettings.Networks[f.networks.control]!.Aliases = [];
  await f.manager.ensureRuntime(f.user);
  assert.ok(f.actions.includes(`connect:${config.managerContainer}:${f.networks.control}`));
  const gateway = f.services.get(config.mcpGatewayContainer)!;
  assert.deepEqual((gateway.NetworkSettings.Networks[f.networks.control] as { Aliases: string[] }).Aliases, [mcpControlAlias(f.user)]);
  assert.ok(f.runtime!.NetworkSettings.Networks[f.networks.control]!.Aliases!.includes(runtimeControlAlias(f.user)));
  assert.ok(!f.actions.includes('remove'));
});

test('unhealthy idle runtime is repaired once, while persistent failures back off and busy work is preserved', async () => {
  const f = fixture(); f.current(); f.failHealth();
  await f.manager.ensureRuntime(f.user);
  assert.ok(f.actions.includes('remove'));
  const failed = fixture(); failed.failNewHealth();
  await assert.rejects(failed.manager.ensureRuntime(failed.user), /sandbox failed/);
  failed.manager.request = async () => { throw new Error('offline'); };
  await assert.rejects(failed.manager.ensureRuntime(failed.user), /cooling down/);
  assert.equal(failed.actions.filter(a => a === 'remove').length, 1);
  const busy = fixture(); busy.busy(true); busy.failHealth();
  await assert.rejects(busy.manager.ensureRuntime(busy.user), /active work is protected/);
  assert.ok(!busy.actions.includes('remove'));
});

test('a transient stale socket after reconnect does not cause a healthy runtime to be replaced', async () => {
  const f = fixture(); f.current();
  let probes = 0;
  f.manager.request = async () => {
    if (++probes === 1) throw new Error('stale connection');
    return Response.json({ ok: true });
  };
  await f.manager.ensureRuntime(f.user);
  assert.equal(probes, 2); assert.equal(f.runtime!.Id, 'old');
  assert.ok(!f.actions.includes('remove'));
});

test('ownership, changed data roots and unknown busy state fail without deleting anything', async t => {
  for (const kind of ['owner', 'data-root', 'redis']) await t.test(kind, async () => {
    const f = fixture();
    if (kind === 'owner') f.runtime!.Config.Labels!['cloud-work.user-id'] = 'bob';
    if (kind === 'data-root') f.runtime!.HostConfig.Binds = ['/old/home:/home/work:rw'];
    if (kind === 'redis') f.manager.leases.isBusy = async () => { throw new Error('Redis unavailable'); };
    await assert.rejects(f.manager.ensureRuntime(f.user));
    assert.ok(!f.actions.includes('stop')); assert.ok(!f.actions.includes('remove'));
  });
});

test('a failed replacement that exits is retried after cooldown, but intentionally stopped containers stay stopped', async () => {
  const f = fixture(); f.failNewHealth();
  await assert.rejects(f.manager.ensureRuntime(f.user), /sandbox failed/);
  f.runtime!.State.Running = false;
  f.manager.row = async () => ({ status: 'ERROR' }) as Awaited<ReturnType<RuntimeManager['row']>>;
  await f.manager.reconcileRuntimeUnlocked(f.user);
  assert.equal(f.actions.filter(a => a === 'create').length, 1);
  f.manager['repairAfter'].set(f.user, 0);
  f.manager['waitHealthy'] = async () => {};
  await f.manager.reconcileRuntimeUnlocked(f.user);
  assert.equal(f.actions.filter(a => a === 'create').length, 2);
});

test('activity admission shares the replacement lock so a concurrent sweep cannot recycle admitted work', async () => {
  const f = fixture();
  await Promise.all([
    f.manager.admitActivity(f.user, 'active-agent-tasks', 'session-a'),
    f.manager.leases.withUserLock(f.user, () => f.manager.reconcileRuntimeUnlocked(f.user)),
  ]);
  assert.equal(f.actions.filter(a => a === 'remove').length, 1);
  assert.ok(f.actions.indexOf('admit') > f.actions.indexOf('start'));
});
