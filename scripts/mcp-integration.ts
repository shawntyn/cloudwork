import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
const fixture = process.env.MCP_TEST_URL ?? 'http://mcp-fixture:4100/mcp';
const token = process.env.MCP_FIXTURE_TOKEN ?? 'local-mcp-fixture-test-token';
const results: string[] = [];
const pass = (name: string) => { results.push(name); console.log(`PASS ${name}`); };
async function request(route: string, cookie = '', method = 'GET', body?: unknown, status = 200) {
  const response = await fetch(base + route, { method, headers: { cookie, origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180_000) });
  const value = await response.json();
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(value)}`);
  assert.ok(!JSON.stringify(value).includes(token), 'Public API exposed upstream credential');
  return { value, response };
}
const credentials = JSON.parse(await readFile('.cache/integration-account-initial.json', 'utf8'));
const login = await request('/api/auth/sign-in/email', '', 'POST', { email: credentials.email, password: credentials.password });
const cookie = login.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const other = await request('/api/auth/sign-up/email', '', 'POST', { email: `mcp-isolation-${Date.now()}@example.test`, password: `Verify-${crypto.randomUUID()}`, name: 'MCP isolation verification' });
const otherCookie = other.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
await request('/api/mcp/connections', '', 'GET', undefined, 401);
const available = (await request('/api/mcp/connections', cookie)).value.connections;
const connection = available.find((item: { name: string; url: string }) => item.name === 'Local MCP verification' && item.url === fixture)
  ?? (await request('/api/mcp/connections', cookie, 'POST', { name: 'Local MCP verification', url: fixture, authType: 'bearer', token }, 201)).value.connection;
assert.equal(connection.hasSecret, true);
await request(`/api/mcp/connections/${connection.id}`, otherCookie, 'GET', undefined, 404);
await request(`/api/mcp/connections/${connection.id}`, otherCookie, 'PATCH', { enabled: false }, 404);
await request('/api/mcp/connections', cookie, 'POST', { name: 'Blocked', url: 'http://127.0.0.1:4100/mcp', authType: 'none' }, 400);
assert.deepEqual((await request('/api/mcp/connections', otherCookie)).value.connections, []);
pass('Authenticated CRUD, secret-free responses, cross-user isolation and destination policy');
const tested = (await request(`/api/mcp/connections/${connection.id}/test`, cookie, 'POST')).value.connection;
assert.equal(tested.lastTestStatus, 'ok', tested.lastTestError);
assert.deepEqual(tested.tools.map((tool: {name:string}) => tool.name).sort(), ['cloudwork_add', 'cloudwork_echo']);
await request(`/api/mcp/connections/${connection.id}`, cookie, 'PATCH', { name: 'Local MCP demo' });
assert.equal((await request(`/api/mcp/connections/${connection.id}/test`, cookie, 'POST')).value.connection.lastTestStatus, 'ok');
pass('Real MCP initialize/tools-list, encrypted credential retained across edits');
const workspace = (await request('/api/workspaces', cookie, 'POST', { name: 'MCP + offline sandbox verification' }, 201)).value.workspace;
const bindings = `/api/workspaces/${workspace.id}/mcp`;
await request(bindings, otherCookie, 'GET', undefined, 404);
await request(bindings, otherCookie, 'PUT', { connectionIds: [connection.id] }, 404);
await request(bindings, cookie, 'PUT', { connectionIds: [connection.id] });
const files = `/api/workspaces/${workspace.id}/files/content`;
await request(files, cookie, 'PUT', { path: 'persistent.txt', content: 'MCP_PERSISTENCE_VERIFIED' });
await request('/api/runtime', cookie, 'POST', { action: 'remove' });
await request(`/api/workspaces/${workspace.id}`, cookie);
assert.equal((await request(files + '?path=persistent.txt', cookie)).value.content, 'MCP_PERSISTENCE_VERIFIED');
assert.deepEqual((await request(bindings, cookie)).value.enabledConnectionIds, [connection.id]);
assert.equal((await request(`/api/mcp/connections/${connection.id}/test`, cookie, 'POST')).value.connection.lastTestStatus, 'ok');
pass('Workspace binding and file persistence through runtime deletion/recreation');
await request(files, cookie, 'PUT', { path: 'verify-offline.py', content: `import errno,json,socket\nimport pandas,numpy,docx,yaml\nblocked=[]\nfor family in (socket.AF_INET,socket.AF_INET6):\n for kind in (socket.SOCK_STREAM,socket.SOCK_DGRAM):\n  try:\n   s=socket.socket(family,kind)\n  except OSError as e:\n   assert e.errno in (errno.EPERM,errno.EACCES)\n   blocked.append(e.errno)\n  else:\n   s.close()\n   raise AssertionError('Network allowed')\nreport={'blockedSockets':blocked,'packages':['pandas','numpy','python-docx','PyYAML']}\nopen('offline-proof.json','w').write(json.dumps(report))\nprint('OFFLINE_VERIFIED')\n` });
const session = (await request(`/api/workspaces/${workspace.id}/sessions`, cookie, 'POST', {}, 201)).value.session;
const events: any[] = [], abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 180_000);
const stream = (async () => {
  const response = await fetch(`${base}/api/sessions/${session.id}/events`, { headers: { cookie }, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let pending = '';
  try { for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true }); let end;
    while ((end = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, end); pending = pending.slice(end + 2);
      for (const line of frame.split('\n')) if (line.startsWith('data: ')) {
        const event = JSON.parse(line.slice(6)); events.push(event);
        if (event.type === 'status' && ['idle', 'error', 'stopped'].includes(event.status)) { abort.abort(); return; }
      }
    }
  } } catch (error) { if (!abort.signal.aborted) throw error; }
})();
await request(`/api/sessions/${session.id}/messages`, cookie, 'POST', { prompt: 'First call the MCP tool cloudwork_add with a=19 and b=23. You must actually call that MCP tool, not calculate with bash. Then run exactly `python verify-offline.py` with bash in this workspace without editing the verification script. Read offline-proof.json. Finally report the MCP result and whether Python sockets were blocked. Do not change any verification code.' }, 202);
await stream; clearTimeout(timer);
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/mcp-integration.json', JSON.stringify({ workspaceId: workspace.id, sessionId: session.id, connectionId: connection.id, results, events }, null, 2));
assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events.filter(event => event.type === 'error')));
assert.ok(events.some(event => event.type === 'tool-start' && event.name.includes('cloudwork_add')), 'Model did not call MCP add tool');
assert.ok(events.some(event => event.type === 'tool-result' && JSON.stringify(event.output).includes('42')), 'Missing MCP tool result 42');
assert.ok(events.some(event => event.type === 'status' && event.status === 'idle'), 'Run did not complete');
assert.ok(!JSON.stringify(events).includes(token));
const proof = JSON.parse((await request(files + '?path=offline-proof.json', cookie)).value.content);
assert.equal(proof.blockedSockets.length, 4);
pass('Real provider + DSH MCP tool execution while Python remains offline with four preinstalled libraries');
await writeFile('artifacts/mcp-integration.json', JSON.stringify({ workspaceId: workspace.id, sessionId: session.id, connectionId: connection.id, results, events, proof }, null, 2));
console.log(`Verified ${results.length} MCP integration checks`);
