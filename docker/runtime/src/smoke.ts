/** Real runtime smoke with an intentionally invalid provider key: never claims LLM success. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { launcherPath, grantArgs } from '@deepseek-ai/node-addon-system/landlock-run';
import { DshRuntime } from '@cloud-work/runtime-dsh';
import { validateId, workspacePath } from '@cloud-work/workspace';
import { verifySandbox } from './sandbox.ts';
import { NETWORK_LAUNCHER } from '../../../packages/runtime-dsh/src/network-policy.mjs';

const suppliedSession = process.env.SMOKE_SESSION_ID;
const suppliedWorkspace = process.env.SMOKE_WORKSPACE_PATH;
assert.equal(suppliedSession !== undefined, suppliedWorkspace !== undefined, 'Set SMOKE_SESSION_ID and SMOKE_WORKSPACE_PATH together when resuming a smoke session');
const sessionId = validateId(suppliedSession ?? `sess_${randomUUID()}`);
assert.ok(sessionId.startsWith('sess_'), 'SMOKE_SESSION_ID must start with sess_');
const workspace = suppliedWorkspace ?? workspacePath(`ws_smoke_${randomUUID()}`);
assert.equal(workspace, workspacePath(validateId(basename(workspace))), 'SMOKE_WORKSPACE_PATH must be exactly /home/work/workspaces/<safe workspace ID>');
await mkdir('/home/work/workspaces', { recursive: true, mode: 0o700 });
await mkdir(workspace, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
assert.equal(await realpath(workspace), workspace, 'Smoke workspace must not contain symlinks');
assert.ok((await stat(workspace)).isDirectory(), 'Smoke workspace must be a directory');
// Keep smoke artifacts separate from any existing project or package.json.
const artifactRoot = join(workspace, `.cloud-work-smoke-${randomUUID()}`);
await mkdir(artifactRoot, { mode: 0o700 });
const sandbox = verifySandbox();
console.log(JSON.stringify({ workspace, sessionId, existingSessionRequested: suppliedSession !== undefined }));

function confined(command: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number; cwd?: string } = {}) {
  const offline = [NETWORK_LAUNCHER, '--', ...command];
  const args = sandbox.backend === 'bwrap'
    ? ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', '--bind', workspace, workspace, '--', ...offline]
    : [...grantArgs({ readOnly: ['/'], readWrite: ['/dev/null', '/tmp', workspace] }), '--', ...offline];
  return spawnSync(sandbox.backend === 'bwrap' ? 'bwrap' : launcherPath(), args, {
    cwd: options.cwd ?? workspace, timeout: options.timeout ?? 10_000, encoding: 'utf8',
    ...(options.env ? { env: options.env } : {}),
  });
}

const inside = join(artifactRoot, 'inside.txt');
const outside = `/home/work/outside-smoke-${randomUUID()}.txt`;
const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(inside)},'sandbox-ok');try{fs.writeFileSync(${JSON.stringify(outside)},'escape');process.exit(7)}catch(e){if(!['EACCES','EROFS','EPERM'].includes(e.code))throw e}`;
const checked = confined([process.execPath, '-e', script]);
assert.equal(checked.status, 0, `Sandbox execution failed: ${checked.stderr}`);
assert.equal(await readFile(inside, 'utf8'), 'sandbox-ok');
console.log(JSON.stringify({ sandbox, insideWrite: 'allowed', outsideWrite: 'denied' }));

await mkdir(join(artifactRoot, 'fixture'), { mode: 0o700 });
await writeFile(join(artifactRoot, 'package.json'), JSON.stringify({ name: 'cloud-work-tooling-smoke', private: true, dependencies: { 'local-tool-fixture': 'file:./fixture' } }));
await writeFile(join(artifactRoot, 'fixture', 'package.json'), JSON.stringify({ name: 'local-tool-fixture', version: '1.0.0', main: 'index.js' }));
await writeFile(join(artifactRoot, 'fixture', 'index.js'), 'module.exports = "installed";\n');
const tooling = confined(['sh', '-c', 'pnpm --version && pnpm install --offline --ignore-scripts && node -e \'if(require("local-tool-fixture")!=="installed")process.exit(1)\''], {
  cwd: artifactRoot,
  timeout: 30_000,
  env: {
    PATH: `${join(workspace, '.local', 'share', 'pnpm')}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
    HOME: '/home/work', USER: 'work', LOGNAME: 'work', LANG: 'C.UTF-8', TMPDIR: '/tmp', CI: 'true',
    COREPACK_HOME: process.env.COREPACK_HOME ?? '/opt/corepack', COREPACK_DEFAULT_TO_LATEST: '0',
    PNPM_HOME: join(workspace, '.local', 'share', 'pnpm'),
    XDG_CACHE_HOME: join(workspace, '.cache'), XDG_DATA_HOME: join(workspace, '.local', 'share'),
    npm_config_cache: join(workspace, '.npm'),
  },
});
assert.equal(tooling.status, 0, `Sandboxed offline pnpm install failed: ${tooling.stderr}\n${tooling.stdout}`);
console.log(JSON.stringify({ pnpmVersion: tooling.stdout.trim().split('\n')[0], offlineLocalDependencyInstall: 'passed', sandbox: sandbox.backend, artifactRoot }));

// This negative credential probe deliberately remains independent of the configured gateway.
const runtime = new DshRuntime({ apiKey: 'cloud-work-invalid-smoke-key', provider: 'deepseek-official', model: 'deepseek-v4-flash', baseUrl: '' });
await runtime.createSession({ sessionId, workspacePath: workspace });
for (let turn = 1; turn <= 2; turn++) {
  const events = [];
  const timeout = setTimeout(() => { void runtime.cancel(sessionId).catch(() => {}); }, 120_000);
  try {
    for await (const event of runtime.run({ sessionId, prompt: 'Reply with exactly runtime-smoke-ok.' })) events.push(event);
  } finally { clearTimeout(timeout); }
  const error = events.find(event => event.type === 'error');
  assert.ok(events.some(event => event.type === 'status' && event.status === 'running'), `DSH did not initialize and accept the session: ${JSON.stringify(events)}`);
  assert.ok(error?.type === 'error' && /auth|credential|api.key|401|402|403|invalid/i.test(error.message), `Expected a genuine provider credential rejection: ${JSON.stringify(events)}`);
  assert.ok(events.some(event => event.type === 'status' && event.status === 'error'));
  console.log(JSON.stringify({ turn, sessionId, workspace, officialSdkStarted: true, persistedSessionResumed: turn === 2, providerResult: 'expected credential rejection', error }));
}
await runtime.destroySession(sessionId);
