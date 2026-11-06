import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import OfflineSandboxProvider from './network-sandbox.mjs';
import { verifyNetworkSandbox } from './network-policy.mjs';

test('Linux official sandbox denies network and exec descendants while preserving file confinement', { skip: process.platform !== 'linux', timeout: 25_000 }, async () => {
  assert.deepEqual(verifyNetworkSandbox(), { network: 'denied', mechanism: 'seccomp' });
  const require = createRequire(import.meta.url);
  const sandboxRequire = createRequire(require.resolve('@deepseek-ai/dsh-sandbox-local'));
  const { Context } = await import(sandboxRequire.resolve('@deepseek-ai/cordis'));
  const home = process.env.HOME;
  assert.ok(home && home !== '/tmp', 'use a writable isolated HOME outside /tmp for the filesystem proof');
  const root = await mkdtemp(join(home, '.network-sandbox-test-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const parent = createServer();
  parent.listen(0, '127.0.0.1');
  await once(parent, 'listening');
  const address = parent.address();
  assert.ok(address && typeof address !== 'string');
  const provider = new OfflineSandboxProvider(new Context(), { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 });
  try {
    const script = `import socket,subprocess,errno,pathlib,json
checks=[]
for family in [socket.AF_INET,socket.AF_INET6,socket.AF_UNIX]:
 for kind in [socket.SOCK_STREAM,socket.SOCK_DGRAM]:
  try: socket.socket(family,kind); raise AssertionError('network allowed')
  except OSError as e: assert e.errno==errno.EPERM; checks.append(str((family,kind)))
try: socket.getaddrinfo('cloud-work-offline.invalid',443); raise AssertionError('DNS allowed')
except socket.gaierror: checks.append('DNS denied')
child=subprocess.run(['node','-e','require("net").connect(${address.port},"127.0.0.1").on("error",e=>process.exit(e.code==="EPERM"?0:1))'],capture_output=True,text=True)
assert child.returncode==0,child.stderr
checks.append('exec child loopback denied')
pathlib.Path(${JSON.stringify(join(workspace, 'inside.txt'))}).write_text('allowed')
try: pathlib.Path(${JSON.stringify(join(root, 'outside.txt'))}).write_text('escape'); raise AssertionError('outside write allowed')
except PermissionError: checks.append('filesystem boundary preserved')
print(json.dumps(checks))`;
    const confined = provider.confine(['python3', '-c', script], { mode: 'workspace-write', workspaceRoot: workspace });
    const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), {
      cwd: workspace, encoding: 'utf8', timeout: 15_000,
      env: { PATH: '/opt/workspace-python/bin:/usr/local/bin:/usr/bin:/bin', HOME: home },
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const checks = JSON.parse(result.stdout) as string[];
    assert.equal(checks.length, 9);
    assert.ok(checks.includes('exec child loopback denied'));
    assert.ok(checks.includes('filesystem boundary preserved'));
    assert.equal(await readFile(join(workspace, 'inside.txt'), 'utf8'), 'allowed');
    assert.equal(parent.listening, true, 'online parent retains network capability');
  } finally {
    await new Promise<void>((resolve, reject) => parent.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
