/** Recreate only the disposable integration user's runtime and resume its real DSH smoke session. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const sessionId = process.env.SMOKE_SESSION_ID;
const workspace = process.env.SMOKE_WORKSPACE_PATH;
assert.match(sessionId ?? '', /^sess_[a-zA-Z0-9_-]+$/);
assert.match(workspace ?? '', /^\/home\/work\/workspaces\/[a-zA-Z0-9_-]+$/);
const report = JSON.parse(await readFile('artifacts/integration.json', 'utf8'));
const account = JSON.parse(await readFile('.cache/integration-account.json', 'utf8'));
assert.match(account.email, /^cloudwork-A-\d+@example\.test$/);
const base = report.base;
const login = await fetch(base + '/api/auth/sign-in/email', {
  method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
  body: JSON.stringify({ email: account.email, password: account.password }),
});
assert.equal(login.status, 200);
const identity = await login.json();
assert.equal(identity.user.id, report.users[0]);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const name = 'cloud-work-runtime-' + identity.user.id;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 300_000 });
const inspect = () => JSON.parse(docker(['inspect', name]))[0];
const sessionFile = `/home/work/.dsh/sessions/${workspace.replaceAll('/', '-').replace(/^-/, '--')}--/${sessionId}/session.v3.jsonl.zstd`;
const fingerprint = () => docker(['exec', name, 'node', '-e',
  `const fs=require('fs'),crypto=require('crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(sessionFile)})).digest('hex'))`,
]);
const before = inspect().Id;
const persistedHash = fingerprint();
const removed = await fetch(base + '/api/runtime', {
  method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'remove' }),
});
assert.equal(removed.status, 200, await removed.text());
const restored = await fetch(base + '/api/workspaces/' + account.workspaceId, { headers: { cookie } });
assert.equal(restored.status, 200, await restored.text());
const after = inspect().Id;
assert.notEqual(after, before);
assert.equal(fingerprint(), persistedHash, 'DSH log changed or was lost during container recreation');
console.log('PASS New container ID with byte-identical persisted DSH log');
const output = docker(['exec', '-e', `SMOKE_SESSION_ID=${sessionId}`, '-e', `SMOKE_WORKSPACE_PATH=${workspace}`,
  name, 'node', '--import', '/app/node_modules/tsx/dist/loader.mjs', '/app/docker/runtime/src/smoke.ts']);
process.stdout.write(output);
const events = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
assert.ok(events.some(event => event.offlineLocalDependencyInstall === 'passed'));
assert.equal(events.filter(event => event.officialSdkStarted).length, 2);
assert.notEqual(fingerprint(), persistedHash, 'Resumed DSH did not append to the original persistent log');
await writeFile('artifacts/runtime-persistence.json', JSON.stringify({
  differentContainer: true, sessionLogPreserved: true, originalSessionLogExtended: true,
  sessionId, workspace, events,
}, null, 2));
console.log('PASS Original DSH session resumed and appended after container recreation');
