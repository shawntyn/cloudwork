import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

// This regression deliberately redeploys an isolated stack, never the developer's main stack.
// Baseline defaults to the previously built platform images; override with older release images if needed.
const root = process.cwd(), base = 'http://localhost:3031';
const dataRoot = path.join(root, '.cache/runtime-lifecycle-data');
const env: NodeJS.ProcessEnv = {
  ...process.env, USER_DATA_ROOT: dataRoot, BETTER_AUTH_URL: base, WEB_PORT: '3031',
  POSTGRES_PASSWORD: 'lifecycle-db-fixture', REDIS_PASSWORD: 'lifecycle-redis-fixture',
  MANAGER_TOKEN: 'lifecycle-manager-fixture-token', RUNTIME_TOKEN_SECRET: 'lifecycle-runtime-fixture-token',
  BETTER_AUTH_SECRET: 'lifecycle-auth-fixture-secret-at-least-32',
  MCP_GATEWAY_ADMIN_TOKEN: 'lifecycle-gateway-fixture-token-at-least-32', MCP_ENCRYPTION_KEY: '19'.repeat(32),
  MCP_ALLOWED_ORIGINS: '', MCP_ALLOWED_PRIVATE_IPS: '',
  RUNTIME_IMAGE: 'cloud-work-lifecycle-test-runtime:latest', RUNTIME_REAPER_INTERVAL_MS: '1000',
  RUNTIME_IDLE_MINUTES: '30', RUNTIME_CPUS: '1', RUNTIME_MEMORY_MB: '512',
  DSH_API_KEY: '', DSH_PROVIDER: 'deepseek-official', DSH_MODEL: 'deepseek-v4-flash', DSH_BASE_URL: '',
};
const composeArgs = ['compose', '--env-file', '/dev/null', '-p', 'cloud-work-lifecycle-test', '-f', 'docker-compose.yml', '-f', 'docker/compose.lifecycle-test.yml'];
async function docker(args: string[], quiet = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; if (!quiet) process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { errors += chunk; if (!quiet) process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`docker ${args[0]} failed (${code}): ${errors.slice(-2000)}`)));
  });
}
const compose = (...args: string[]) => docker([...composeArgs, ...args]);
const inspect = async (name: string) => JSON.parse(await docker(['inspect', name], true))[0];
const results: string[] = [];
const pass = (name: string) => { results.push(name); console.log(`PASS ${name}`); };
async function ready() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(base + '/api/health')).ok && (await inspect('cloud-work-lifecycle-test-manager')).State.Health.Status === 'healthy') return; }
    catch { /* Compose is bringing the stack online. */ }
    await delay(1000);
  }
  throw new Error('Isolated deployment did not become healthy');
}
async function json(route: string, cookie: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch(base + route, { method, headers: { cookie, origin: base, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180_000) });
  const value = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(value)}`);
  return { value, response };
}

await mkdir(dataRoot, { recursive: true });
await mkdir('artifacts', { recursive: true });
for (const [service, baseline] of [
  ['manager', process.env.LIFECYCLE_BASELINE_MANAGER_IMAGE ?? 'cloud-work-runtime-manager'],
  ['gateway', process.env.LIFECYCLE_BASELINE_GATEWAY_IMAGE ?? 'cloud-work-mcp-gateway'],
  ['web', process.env.LIFECYCLE_BASELINE_WEB_IMAGE ?? 'cloud-work-web'],
]) await docker(['tag', baseline, `cloud-work-lifecycle-test-${service}`]);
await compose('up', '-d', '--no-build');
await ready();
const account = await json('/api/auth/sign-up/email', '', 'POST', {
  email: `lifecycle-${randomUUID()}@example.test`, password: `Lifecycle-${randomUUID()}`, name: 'Lifecycle verification',
});
const cookie = account.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const userId = account.value.user.id as string;
const workspace = (await json('/api/workspaces', cookie, 'POST', { name: 'Automatic deployment recovery' }, 201)).value.workspace;
const route = `/api/workspaces/${workspace.id}`, files = `${route}/files`;
const runtimeName = `cloud-work-runtime-${userId}`;
const control = `cloud-work-control-${createHash('sha256').update(userId).digest('hex').slice(0, 24)}`;
const detail = () => json(route, cookie);
await detail();
const initial = await inspect(runtimeName);
const content = 'Persistent files survive automatic upgrades ✓';
await json(files + '/content', cookie, 'PUT', { path: 'keep.txt', content });
const session = (await json(route + '/sessions', cookie, 'POST', {}, 201)).value.session;
await docker(['exec', runtimeName, 'node', '-e', "require('node:fs').writeFileSync('/home/work/lifecycle-home-proof.txt','HOME preserved')"]);
const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
async function zipUpload(batchId: string, name = 'archive.zip') {
  const response = await fetch(`${base}${files}/uploads/${batchId}?path=${name}`, {
    method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/octet-stream' }, body: zip,
  });
  assert.equal(response.status, 200, await response.text());
}
async function createBatch() {
  return (await json(files + '/uploads', cookie, 'POST', { files: [{ path: 'archive.zip', size: zip.length }] })).value.id as string;
}
async function verifyData() {
  assert.equal((await json(files + '/content?path=keep.txt', cookie)).value.content, content);
  assert.ok((await json(route + '/sessions', cookie)).value.sessions.some((value: { id: string }) => value.id === session.id));
  assert.equal(await docker(['exec', runtimeName, 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/home/work/lifecycle-home-proof.txt','utf8'))"], true), 'HOME preserved');
}
const firstBatch = await createBatch();
await zipUpload(firstBatch); await json(files + '/uploads/' + firstBatch, cookie, 'DELETE');
pass('Older deployment created a workspace, session, ZIP and persistent HOME marker');

await compose('up', '-d', '--build');
await ready();
await detail();
const updated = await inspect(runtimeName);
assert.notEqual(updated.Id, initial.Id);
const manager = await inspect('cloud-work-lifecycle-test-manager');
const updatedImage = await inspect(updated.Image);
assert.equal(updatedImage.Config.Labels['cloud-work.runtime-source-image'], manager.Image);
await verifyData();
const download = await fetch(`${base}${files}/download?path=archive.zip`, { headers: { cookie } });
assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), zip);
pass('Compose --build upgrades existing runtime automatically; workspace/session/ZIP/HOME survive');

await compose('up', '-d', '--build');
await ready(); await detail();
assert.equal((await inspect(runtimeName)).Id, updated.Id);
pass('No-op deployment preserves the healthy container');

await docker(['network', 'disconnect', control, runtimeName]);
await detail();
assert.equal((await inspect(runtimeName)).Id, updated.Id);
await verifyData();
pass('Broken tenant network is reconnected automatically on workspace entry');

// A batch has no active HTTP connection between files. It must still protect the runtime.
// Remove only this test's existing archive before the second upload.
await json(files + '?path=archive.zip', cookie, 'DELETE');
const pendingBatch = await createBatch();
env.DSH_MODEL = 'lifecycle-new-model';
await compose('up', '-d', '--no-deps', 'runtime-manager');
await ready();
await delay(3000); await detail();
assert.equal((await inspect(runtimeName)).Id, updated.Id);
await zipUpload(pendingBatch); await json(files + '/uploads/' + pendingBatch, cookie, 'DELETE');
await detail();
const configured = await inspect(runtimeName);
assert.notEqual(configured.Id, updated.Id);
assert.ok(configured.Config.Env.includes('DSH_MODEL=lifecycle-new-model'));
await verifyData();
pass('Configuration-only redeploy defers replacement until a pending upload batch completes');

await json('/api/runtime', cookie, 'POST', { action: 'stop' });
env.DSH_MODEL = 'lifecycle-next-model';
await compose('up', '-d', '--no-deps', 'runtime-manager');
await ready(); await delay(3000);
const stopped = (await json('/api/runtime', cookie)).value.runtime;
assert.ok(['STOPPED', 'REMOVED'].includes(stopped.status));
await detail();
assert.ok((await inspect(runtimeName)).Config.Env.includes('DSH_MODEL=lifecycle-next-model'));
await verifyData();
pass('Stopped tenants stay stopped during deployment and use latest settings on next entry');
await writeFile('artifacts/runtime-lifecycle-integration.json', JSON.stringify({ results, userId, workspaceId: workspace.id, initialId: initial.Id, updatedId: updated.Id, base }, null, 2));
console.log('Isolated test stack retained on http://localhost:3031; no main-project containers were redeployed.');
