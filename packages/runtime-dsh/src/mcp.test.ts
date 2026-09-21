import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DeepSeekHarness, type RunOptions } from '@deepseek-ai/dsh-sdk-client';
import type { AgentEvent, McpRunSnapshot } from '@cloud-work/protocol';
import { DshRuntime } from './index.ts';
import { parseMcpRunSnapshot, prepareMcpRunOverlay, redactAgentEvent, runRedactor } from './mcp.ts';

const snapshot: McpRunSnapshot = {
  runId: 'run_fixture', revision: 'revision:1',
  connections: [{ id: 'connection_fixture', serverName: 'fixture', url: 'http://mcp-user-fixture:3090/mcp/grant', token: 'scoped-fixture-secret' }],
};

test('adapter redaction covers object keys and JSON-escaped credentials in all event payloads', () => {
  const secret = 'scoped-quote"and\\slash-token';
  const redact = runRedactor([secret]);
  const diagnostic = JSON.stringify({ Authorization: `Bearer ${secret}` });
  assert.deepEqual(redactAgentEvent({ type: 'error', message: diagnostic }, redact), { type: 'error', message: '{"Authorization":"Bearer [redacted]"}' });
  const event: AgentEvent = { type: 'tool-result', id: 'call_fixture', output: { [secret]: [{ message: diagnostic }] } };
  assert.deepEqual(redactAgentEvent(event, redact), { type: 'tool-result', id: 'call_fixture', output: { '[redacted]': [{ message: '{"Authorization":"Bearer [redacted]"}' }] } });
  assert.ok(Object.hasOwn(event.output as object, secret), 'redaction does not mutate the original SDK event');
});

test('MCP boundary accepts only bounded gateway data and clones the snapshot', () => {
  assert.deepEqual(parseMcpRunSnapshot(snapshot), snapshot);
  assert.notEqual(parseMcpRunSnapshot(snapshot).connections, snapshot.connections);
  const connection = snapshot.connections[0]!;
  for (const replacement of [
    { ...snapshot, plugins: [] }, { ...snapshot, connections: Array(17).fill(connection) },
    { ...snapshot, connections: [connection, connection] }, { ...snapshot, revision: '\nunsafe' },
  ]) assert.throws(() => parseMcpRunSnapshot(replacement));
  for (const replacement of [
    { ...connection, transport: 'stdio' }, { ...connection, command: 'node' },
    { ...connection, headers: {} }, { ...connection, token: { __jsExpr: 'process.env' } },
    { ...connection, token: 'line\nbreak' }, { ...connection, token: 'a b' },
    { ...connection, serverName: 'bad/name' }, { ...connection, id: 'x'.repeat(129) },
    ...['file:///etc/passwd', 'http://user:pass@host/mcp', 'http://host/mcp?', 'http://host/mcp#', ' http://host/mcp'].map(url => ({ ...connection, url })),
  ]) assert.throws(() => parseMcpRunSnapshot({ ...snapshot, connections: [replacement] }));
});

test('overlay contains fixed code and inert JSON fields, but no token or shared profile writes', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cloud-work-mcp-overlay-')));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const parsed = parseMcpRunSnapshot({ ...snapshot, connections: [{ ...snapshot.connections[0], url: 'http://host/!!js%20process.exit(99)' }] });
  try {
    const first = await prepareMcpRunOverlay(home, workspace, parsed);
    const second = await prepareMcpRunOverlay(home, workspace, parsed);
    assert.ok(first && second);
    assert.notEqual(first.path, second.path);
    assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(first.path))).mode & 0o777, 0o700);
    const text = await readFile(first.path, 'utf8');
    assert.equal(text.includes(parsed.connections[0]!.token), false);
    const overlay = JSON.parse(text);
    assert.equal(overlay[0].insert[0].name, '@deepseek-ai/dsh-mcp-client');
    assert.equal(overlay[0].insert[0].config.url, parsed.connections[0]!.url);
    assert.deepEqual(overlay[0].insert[0].config.headers.Authorization, { __jsExpr: "'Bearer ' + process.env.CLOUD_WORK_MCP_TOKEN_0" });
    assert.equal(first.env.CLOUD_WORK_MCP_TOKEN_0, parsed.connections[0]!.token);
    assert.deepEqual(await readdir(home), ['.cloud-work', 'workspace']);
    await first.cleanup();
    assert.ok(await stat(second.path));
    await second.cleanup();
    assert.deepEqual(await readdir(join(home, '.cloud-work', 'mcp-runs')), []);
    await assert.rejects(prepareMcpRunOverlay(home, home, parsed), /outside the workspace/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('run grant errors are redacted; overlay survives until actual SDK close', async context => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cloud-work-mcp-lifecycle-')));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const sessionId = 'sess_mcp_redaction';
  const secret = snapshot.connections[0]!.token;
  let closed = false;
  context.mock.method(DeepSeekHarness.prototype, 'run', async (_prompt: unknown, options?: RunOptions) => {
    assert.equal((await readdir(join(home, '.cloud-work', 'mcp-runs'))).length, 1);
    options?.onNotification?.({ method: 'session.event', params: { sessionId, event: {
      type: 'turn/end', data: { reason: { kind: 'error', error: { message: `MCP rejected ${secret}` } } },
    } } });
    throw new Error(`MCP connection config Authorization: Bearer ${secret}`);
  });
  context.mock.method(DeepSeekHarness.prototype, 'close', async () => {
    assert.equal((await readdir(join(home, '.cloud-work', 'mcp-runs'))).length, 1);
    closed = true;
  });
  const runtime = new DshRuntime({ home, apiKey: 'provider-fixture-key' });
  try {
    await runtime.createSession({ sessionId, workspacePath: workspace });
    const events: AgentEvent[] = [];
    for await (const event of runtime.run({ sessionId, prompt: 'Fixture', mcp: snapshot })) {
      if (event.type === 'status' && event.status === 'error') assert.equal(closed, true);
      events.push(event);
    }
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(events.filter(event => event.type === 'error').length, 2);
    assert.deepEqual(await readdir(join(home, '.cloud-work', 'mcp-runs')), []);
  } finally { await runtime.destroySession(sessionId); await rm(home, { recursive: true, force: true }); }
});

test('cancellation keeps the run overlay until SDK exit completes', async context => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cloud-work-mcp-cancel-')));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  let ready: () => void = () => {};
  const started = new Promise<void>(resolve => { ready = resolve; });
  let finish: () => void = () => {};
  const running = new Promise<void>(resolve => { finish = resolve; });
  let closing: () => void = () => {};
  const closeStarted = new Promise<void>(resolve => { closing = resolve; });
  let exit: () => void = () => {};
  const exited = new Promise<void>(resolve => { exit = resolve; });
  context.mock.method(DeepSeekHarness.prototype, 'run', async () => { ready(); await running; });
  context.mock.method(DeepSeekHarness.prototype, 'close', async () => { closing(); await exited; finish(); });
  const runtime = new DshRuntime({ home, apiKey: 'provider-fixture-key' });
  const sessionId = 'sess_mcp_cancel';
  try {
    await runtime.createSession({ sessionId, workspacePath: workspace });
    const iterator = runtime.run({ sessionId, prompt: 'Fixture', mcp: snapshot })[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, { type: 'status', status: 'starting' });
    await started;
    const cancellation = runtime.cancel(sessionId);
    await closeStarted;
    assert.equal((await readdir(join(home, '.cloud-work', 'mcp-runs'))).length, 1);
    exit();
    await cancellation;
    const events = [];
    for (;;) { const result = await iterator.next(); if (result.done) break; events.push(result.value); }
    assert.deepEqual(events.at(-1), { type: 'status', status: 'stopped' });
    assert.deepEqual(await readdir(join(home, '.cloud-work', 'mcp-runs')), []);
  } finally { exit(); finish(); await runtime.destroySession(sessionId); await rm(home, { recursive: true, force: true }); }
});

test('failed SDK teardown retains its overlay and redacts the thrown error until exit is proved', async context => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cloud-work-mcp-close-failed-')));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  let attempts = 0;
  context.mock.method(DeepSeekHarness.prototype, 'run', async () => {});
  context.mock.method(DeepSeekHarness.prototype, 'close', async () => {
    if (++attempts === 1) throw new Error(`Teardown failed for ${snapshot.connections[0]!.token}`);
  });
  const runtime = new DshRuntime({ home, apiKey: 'provider-fixture-key' });
  const sessionId = 'sess_mcp_close_failed';
  try {
    await runtime.createSession({ sessionId, workspacePath: workspace });
    const events: AgentEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of runtime.run({ sessionId, prompt: 'Fixture', mcp: snapshot })) events.push(event);
    }, /Teardown failed for \[redacted\]/);
    assert.equal(JSON.stringify(events).includes(snapshot.connections[0]!.token), false);
    assert.equal(events.some(event => event.type === 'status' && ['idle', 'stopped', 'error'].includes(event.status)), false);
    assert.equal((await readdir(join(home, '.cloud-work', 'mcp-runs'))).length, 1);
    await assert.rejects(runtime.cancel(sessionId), /Teardown failed for \[redacted\]/);
    assert.deepEqual(await readdir(join(home, '.cloud-work', 'mcp-runs')), []);
  } finally { await runtime.destroySession(sessionId).catch(() => {}); await rm(home, { recursive: true, force: true }); }
});
