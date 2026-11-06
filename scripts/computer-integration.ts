import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/desktop-gateway/package.json', import.meta.url));
const WebSocket = require('ws') as typeof import('../apps/desktop-gateway/node_modules/@types/ws/index.js');
const base = process.env.TEST_BASE_URL ?? 'http://localhost:3051';
const stamp = Date.now(), password = `Desktop-${crypto.randomUUID()}`;
const results: string[] = [];
const pass = (value: string) => { results.push(value); console.log('PASS ' + value); };
async function req(route: string, cookie = '', method = 'GET', data?: unknown, status = 200) {
  const response = await fetch(base + route, { method, headers: { cookie, origin: base, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(120000) });
  const text = await response.text(); assert.ok(text, `Empty HTTP ${response.status} response for ${route}`); const value = JSON.parse(text); assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(value)}`); return { value, response };
}
async function signup(label: string) {
  const email = `desktop-${label}-${stamp}@example.test`;
  const { value, response } = await req('/api/auth/sign-up/email', '', 'POST', { email, password, name: `Desktop ${label}` });
  const cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; '); assert.ok(cookie);
  return { id: value.user.id as string, email, cookie };
}
async function socket(cookie: string, workspace: string, clientId: string, control: boolean, expected: number) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/desktop/socket?workspace=${workspace}&clientId=${clientId}&control=${control ? '1' : '0'}`, { headers: { cookie, origin: base } });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('VNC handshake timeout')); }, 15000);
    ws.once('unexpected-response', (_request: unknown, response: { statusCode: number; resume(): void }) => { clearTimeout(timer); response.resume(); try { assert.equal(response.statusCode, expected); resolve(); } catch (error) { reject(error); } });
    ws.once('message', (data: Buffer) => { clearTimeout(timer); try { assert.equal(expected, 101); assert.match(data.toString(), /^RFB 003\./); ws.close(); resolve(); } catch (error) { ws.close(); reject(error); } });
    ws.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
  });
}
const readyDeadline = Date.now() + 180000;
while (true) {
  try { const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(3000) }); if (response.ok) break; } catch {}
  if (Date.now() >= readyDeadline) throw new Error('Test stack did not become ready');
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const a = await signup('A'), b = await signup('B');
const workspace = (await req('/api/workspaces', a.cookie, 'POST', { name: 'Computer verification' }, 201)).value.workspace;
const endpoint = `/api/workspaces/${workspace.id}/desktop`;
const clientId = crypto.randomUUID(), otherClient = crypto.randomUUID();
await req(endpoint, '', 'GET', undefined, 401); await req(endpoint, b.cookie, 'GET', undefined, 404);
assert.equal((await req(endpoint, a.cookie)).value.status, 'stopped');
await socket('', workspace.id, clientId, false, 403);
pass('Desktop and VNC require an authenticated workspace owner; reading status does not start desktop');
const session = (await req(`/api/workspaces/${workspace.id}/sessions`, a.cookie, 'POST', {}, 201)).value.session;
await mkdir('.cache', { recursive: true });
await writeFile('.cache/computer-ui-fixture.json', JSON.stringify({ base, workspaceId: workspace.id, sessionId: session.id, user: a, other: b, password, clientId }), { mode: 0o600 });
async function run(prompt: string, timeout = 600000) {
  const requestId = crypto.randomUUID();
  await req(`/api/sessions/${session.id}/messages`, a.cookie, 'POST', { prompt, requestId }, 202);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const receipt = (await req(`/api/sessions/${session.id}/messages?requestId=${requestId}`, a.cookie)).value;
    if (['completed', 'failed', 'stopped', 'cancelled'].includes(receipt.requestStatus)) { assert.equal(receipt.requestStatus, 'completed', JSON.stringify(receipt)); return; }
  }
  await req(`/api/sessions/${session.id}/cancel`, a.cookie, 'POST', {}); throw new Error('Agent run timeout');
}
if (process.env.COMPUTER_SKIP_MODEL_CHECKS !== '1') {
await run('Reply with exactly DESKTOP_NOT_NEEDED. This is an ordinary chat message; do not use any tools.', 180000);
assert.equal((await req(endpoint, a.cookie)).value.status, 'stopped');
pass('An ordinary DSH message completes without allocating a desktop');
} else console.log('SKIP ordinary model check: explicitly disabled');
await req(endpoint, b.cookie, 'POST', { operation: 'start' }, 404);
assert.equal((await req(endpoint, a.cookie, 'POST', { operation: 'start' })).value.status, 'ready');
await socket(a.cookie, workspace.id, clientId, false, 101);
await socket(a.cookie, workspace.id, clientId, true, 403);
pass('Explicit desktop start produces authenticated read-only RFB; unowned input connection is denied');
await req(endpoint, a.cookie, 'POST', { operation: 'take', clientId });
await socket(a.cookie, workspace.id, clientId, true, 101);
await req(endpoint, a.cookie, 'POST', { operation: 'take', clientId: otherClient }, 409);
await socket(a.cookie, workspace.id, otherClient, true, 403);
await req(endpoint, a.cookie, 'POST', { operation: 'release', clientId });
await socket(a.cookie, workspace.id, clientId, true, 403);
pass('Manual ownership is tab-scoped; competing tabs are rejected and release revokes writable VNC');
const html = `<!doctype html><meta charset="utf-8"><title>Computer verification</title><style>body{font:24px sans-serif;padding:80px;background:#edf5ff}input,button{font:24px sans-serif;padding:16px;margin:12px}h1{color:#183a66}</style><h1>Computer verification</h1><p>Type DESKTOP_VERIFIED in the field and press Save proof.</p><input id="proof" aria-label="Proof text"><button onclick="const value=document.getElementById('proof').value;if(value!=='DESKTOP_VERIFIED')return;const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob([value],{type:'text/plain'}));a.download='computer-proof.txt';a.click();document.getElementById('status').textContent='Saved: DESKTOP_VERIFIED'">Save proof</button><h2 id="status">Waiting for input</h2>`;
await req(`/api/workspaces/${workspace.id}/files/content`, a.cookie, 'PUT', { path: 'computer-fixture.html', content: html });
if (process.env.COMPUTER_SKIP_MODEL_CHECKS !== '1') {
await run('Use the internal computer start and status tools to operate the graphical desktop. Goal: open file:///workspace/computer-fixture.html in Chromium, type DESKTOP_VERIFIED into the Proof text field, click Save proof, and verify Saved: DESKTOP_VERIFIED appears. Wait for the computer task to complete using status. Do not use shell, code execution or file tools to perform this GUI task. The requested download is explicitly authorized.');
const view = (await req(endpoint, a.cookie)).value;
assert.equal(view.task?.state, 'completed', JSON.stringify(view));
assert.equal((await req(`/api/workspaces/${workspace.id}/files/content?path=Downloads%2Fcomputer-proof.txt`, a.cookie)).value.content, 'DESKTOP_VERIFIED');
pass('DSH delegation, screenshot transport, GUI input and download produce a verified shared-workspace artifact');
await req(endpoint, a.cookie, 'POST', { operation: 'stop' });
assert.equal((await req(endpoint, a.cookie)).value.status, 'stopped');
await req(endpoint, a.cookie, 'POST', { operation: 'start' });
assert.equal((await req(`/api/workspaces/${workspace.id}/files/content?path=Downloads%2Fcomputer-proof.txt`, a.cookie)).value.content, 'DESKTOP_VERIFIED');
pass('Desktop stop and restart preserve downloaded workspace files');
} else console.log('SKIP visual model task and download checks: explicitly disabled');
await mkdir('.cache', { recursive: true });
await writeFile('.cache/computer-ui-fixture.json', JSON.stringify({ base, workspaceId: workspace.id, sessionId: session.id, user: a, other: b, password, clientId }), { mode: 0o600 });
await writeFile('.cache/computer-verification.json', JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
console.log('Computer integration checks completed. UI fixture saved privately in .cache.');
