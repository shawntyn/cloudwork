import test from 'node:test';
import assert from 'node:assert/strict';
import { networkNames, readConfig, runtimeControlAlias, runtimeEnvironment, runtimeName, runtimeToken, safeId, secureEqual } from '../src/config.js';
import { parseEvent, readEvents, terminal } from '../src/events.js';
import { reaperAction } from '../src/reaper.js';
import { createServer } from '../src/server.js';
import type { RuntimeManager } from '../src/lifecycle.js';
import type { Runs } from '../src/runs.js';
import { runtimeImageDockerfile } from '../src/runtime-image.js';

test('container identity and mount IDs reject traversal and shell fragments', () => {
  for (const invalid of ['../other', '/tmp', 'user:../../tmp', 'user\nnext', '$(id)', '', 'u'.repeat(101)]) assert.throws(() => safeId(invalid));
  assert.equal(runtimeName('User_123-a'), 'cloud-work-runtime-User_123-a');
  assert.notDeepEqual(networkNames('user-a'), networkNames('user-b'));
  assert.deepEqual(networkNames('user-a'), networkNames('user-a'));
  assert.match(runtimeControlAlias('A'.repeat(100)), /^[a-z0-9-]{1,63}$/);
  assert.notEqual(runtimeControlAlias('Alice'), runtimeControlAlias('alice'));
  assert.notEqual(runtimeControlAlias('alice'), runtimeName('alice-control'));
});

test('runtime credentials differ across tenants and never reuse manager authority', () => {
  const secret = 'manager-only-derivation-secret';
  assert.notEqual(runtimeToken('alice', secret), runtimeToken('bob', secret));
  assert.notEqual(runtimeToken('alice', secret), secret);
  assert.equal(runtimeToken('alice', secret), runtimeToken('alice', secret));
  assert.equal(secureEqual('abc', 'abcd'), false);
  assert.equal(secureEqual('abc', 'abd'), false);
  assert.equal(secureEqual('abc', 'abc'), true);
});

test('runtime bootstrap uses only an immutable prepared image and fixed unprivileged configuration', () => {
  const image = `sha256:${'a'.repeat(64)}`;
  const dockerfile = runtimeImageDockerfile(image);
  assert.ok(dockerfile.startsWith(`FROM ${image}\n`));
  assert.ok(dockerfile.includes(`cloud-work.runtime-source-image="${image}"`));
  assert.ok(dockerfile.includes('USER 1000:1000\n'));
  assert.ok(dockerfile.includes('PNPM_HOME=/home/work/.local/share/pnpm'));
  assert.ok(dockerfile.includes('COREPACK_HOME=/opt/corepack COREPACK_DEFAULT_TO_LATEST=0'));
  assert.ok(dockerfile.includes('"/app/node_modules/tsx/dist/loader.mjs", "/app/docker/runtime/src/server.ts"'));
  assert.doesNotMatch(dockerfile, /apt-get|pnpm install|DATABASE_URL|REDIS_URL|MANAGER_TOKEN|RUNTIME_TOKEN_SECRET|DSH_API_KEY|sandbox.*disabled/i);
  for (const invalid of ['node:latest', 'sha256:abc', `${image}\nRUN echo injected`]) assert.throws(() => runtimeImageDockerfile(invalid));
});

test('unsafe or missing configuration fails instead of weakening isolation', () => {
  const base = { DATABASE_URL: 'postgres://db', REDIS_URL: 'redis://redis', MANAGER_TOKEN: 'a', RUNTIME_TOKEN_SECRET: 'b' };
  assert.throws(() => readConfig({ ...base, RUNTIME_CPUS: '0' }));
  assert.throws(() => readConfig({ ...base, USER_DATA_ROOT: '../data' }));
  assert.throws(() => readConfig({ ...base, RUNTIME_TOKEN_SECRET: 'a' }));
  assert.equal(readConfig(base).memoryMb, 4096);
  assert.equal(readConfig(base).provider, 'deepseek-official');
  assert.equal(readConfig(base).model, 'deepseek-v4-flash');
});

test('compatible gateway settings propagate through an explicit tenant environment allowlist', () => {
  const source = {
    DATABASE_URL: 'postgres://platform-database-secret', REDIS_URL: 'redis://platform-redis-secret',
    MANAGER_TOKEN: 'platform-manager-secret', RUNTIME_TOKEN_SECRET: 'platform-derivation-secret',
    BETTER_AUTH_SECRET: 'platform-auth-secret', DSH_PROVIDER: 'openai-compatible', DSH_MODEL: 'gateway-model',
    DSH_API_KEY: 'gateway-key', DSH_BASE_URL: 'https://gateway.example/v1',
    DSH_CONTEXT_WINDOW: '262144', DSH_MAX_TOKENS: '8192',
  };
  const config = readConfig(source);
  const environment = runtimeEnvironment(config, 'alice');
  const values = Object.fromEntries(environment.map(entry => { const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)]; }));
  assert.deepEqual(Object.keys(values).sort(), ['NODE_ENV', 'HOME', 'PORT', 'RUNTIME_TOKEN', 'DSH_PROVIDER', 'DSH_MODEL', 'DSH_API_KEY', 'DSH_BASE_URL', 'DSH_CONTEXT_WINDOW', 'DSH_MAX_TOKENS'].sort());
  assert.equal(values.DSH_BASE_URL, 'https://gateway.example/v1');
  assert.equal(values.DSH_CONTEXT_WINDOW, '262144');
  assert.equal(values.DSH_MAX_TOKENS, '8192');
  assert.equal(values.DSH_PROVIDER, 'openai-compatible');
  assert.equal(values.DSH_API_KEY, 'gateway-key');
  for (const secret of [source.DATABASE_URL, source.REDIS_URL, source.MANAGER_TOKEN, source.RUNTIME_TOKEN_SECRET, source.BETTER_AUTH_SECRET]) assert.ok(!environment.some(entry => entry.includes(secret)));
  assert.notEqual(values.RUNTIME_TOKEN, runtimeEnvironment(config, 'bob').find(entry => entry.startsWith('RUNTIME_TOKEN='))?.slice('RUNTIME_TOKEN='.length));
});

test('empty gateway settings stay omitted for the unchanged native DeepSeek path', () => {
  const base = { DATABASE_URL: 'postgres://db', REDIS_URL: 'redis://redis', MANAGER_TOKEN: 'a', RUNTIME_TOKEN_SECRET: 'b' };
  const config = readConfig({ ...base, DSH_BASE_URL: '', DSH_CONTEXT_WINDOW: '', DSH_MAX_TOKENS: '' });
  assert.equal(config.baseUrl, undefined);
  assert.equal(config.contextWindow, undefined);
  assert.equal(config.maxTokens, undefined);
  const environment = runtimeEnvironment(config, 'alice');
  assert.equal(environment.length, 7);
  assert.ok(environment.includes('DSH_PROVIDER=deepseek-official'));
  assert.ok(environment.includes('DSH_MODEL=deepseek-v4-flash'));
  assert.ok(!environment.some(entry => /^(DSH_BASE_URL|DSH_CONTEXT_WINDOW|DSH_MAX_TOKENS)=/.test(entry)));
});

test('gateway base URL rejects credentials, non-HTTP schemes, queries and fragments', () => {
  const base = { DATABASE_URL: 'postgres://db', REDIS_URL: 'redis://redis', MANAGER_TOKEN: 'a', RUNTIME_TOKEN_SECRET: 'b' };
  for (const url of ['not-a-url', 'file:///tmp/gateway', 'ftp://gateway.example', 'https://name:secret@gateway.example/v1', 'https://name@gateway.example/v1', 'https://gateway.example/v1?secret=value', 'https://gateway.example/v1?', 'https://gateway.example/v1#fragment', 'https://gateway.example/v1#']) {
    assert.throws(() => readConfig({ ...base, DSH_BASE_URL: url }), /DSH_BASE_URL/);
  }
  assert.equal(readConfig({ ...base, DSH_BASE_URL: 'http://gateway.internal:8000/custom/v1' }).baseUrl, 'http://gateway.internal:8000/custom/v1');
});

test('token limits are bounded positive integers and cannot exceed the supplied context window', () => {
  const base = { DATABASE_URL: 'postgres://db', REDIS_URL: 'redis://redis', MANAGER_TOKEN: 'a', RUNTIME_TOKEN_SECRET: 'b' };
  for (const name of ['DSH_CONTEXT_WINDOW', 'DSH_MAX_TOKENS']) {
    for (const value of ['0', '-1', '1.5', 'Infinity', 'NaN', '1e3', '0x10', '2147483648', '9007199254740993']) {
      assert.throws(() => readConfig({ ...base, [name]: value }), new RegExp(name));
    }
    assert.doesNotThrow(() => readConfig({ ...base, [name]: '1' }));
    assert.doesNotThrow(() => readConfig({ ...base, [name]: '2147483647' }));
  }
  assert.throws(() => readConfig({ ...base, DSH_CONTEXT_WINDOW: '8192', DSH_MAX_TOKENS: '8193' }), /must not exceed/);
  assert.doesNotThrow(() => readConfig({ ...base, DSH_CONTEXT_WINDOW: '8192', DSH_MAX_TOKENS: '8192' }));
});

test('SSE parser retains split UTF-8 and normalizes CRLF, comments, multiline data', async () => {
  const text = ': heartbeat\r\nid: ignored\r\ndata: {"type":"text-delta",\r\ndata: "text":"你好"}\r\n\r\ndata: {"type":"status","status":"idle"}\n\n';
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const events = [];
  for await (const event of readEvents(stream)) events.push(event);
  assert.deepEqual(events, [{ type: 'text-delta', text: '你好' }, { type: 'status', status: 'idle' }]);
  assert.equal(terminal(events[1]!), true);
  assert.throws(() => parseEvent({ type: 'unknown', token: 'secret' }));
  assert.throws(() => parseEvent({ type: 'status', status: 'pretend-success' }));
});

test('reaper protects all registered work and measures stopped age separately from idle age', () => {
  const input = { running: true, busy: false, lastActiveAt: 0, stoppedAt: null };
  assert.equal(reaperAction(input, 1_000, 2_000, 10_000), null);
  assert.equal(reaperAction(input, 2_000, 2_000, 10_000), 'stop');
  assert.equal(reaperAction({ ...input, busy: true }, 100_000, 2_000, 10_000), null);
  assert.equal(reaperAction({ ...input, running: false, stoppedAt: 5_000 }, 14_999, 2_000, 10_000), null);
  assert.equal(reaperAction({ ...input, running: false, stoppedAt: 5_000 }, 15_000, 2_000, 10_000), 'remove');
  assert.equal(reaperAction({ ...input, running: false }, 100_000, 2_000, 10_000), null);
});

test('internal control APIs authenticate before accepting operations or lease changes', async () => {
  const manager = { config: { managerToken: 'platform-authority' } } as unknown as RuntimeManager;
  const server = createServer(manager, {} as Runs);
  try {
    for (const url of ['/internal/users/alice/ensure', '/internal/users/alice/leases/keepalive-jobs/job']) {
      const unauthenticated = await server.app.inject({ method: 'POST', url });
      assert.equal(unauthenticated.statusCode, 401);
      const runtimeAuthority = await server.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer runtime-token' } });
      assert.equal(runtimeAuthority.statusCode, 401);
      const initializing = await server.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer platform-authority' } });
      assert.equal(initializing.statusCode, 503);
    }
  } finally { await server.app.close(); }
});
