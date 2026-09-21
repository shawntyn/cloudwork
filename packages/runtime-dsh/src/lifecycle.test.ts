import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeepSeekHarness, type RunOptions } from '@deepseek-ai/dsh-sdk-client';
import { DshRuntime } from './index.ts';

async function temporaryWorkspace() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cloud-work-adapter-')));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  return { home, workspace };
}

test('missing provider configuration returns an actionable terminal error', async () => {
  const { home, workspace } = await temporaryWorkspace();
  const runtime = new DshRuntime({ home, apiKey: '' });
  try {
    await runtime.createSession({ sessionId: 'sess_missing_key', workspacePath: workspace });
    const events = [];
    for await (const event of runtime.run({ sessionId: 'sess_missing_key', prompt: 'Hello' })) events.push(event);
    assert.ok(events.some(event => event.type === 'error' && event.message.includes('DSH_API_KEY')));
    assert.deepEqual(events.at(-1), { type: 'status', status: 'error' });
  } finally { await runtime.destroySession('sess_missing_key'); await rm(home, { recursive: true, force: true }); }
});

test('real SDK process can be stopped during startup and then releases its session', { timeout: 30_000 }, async () => {
  const { home, workspace } = await temporaryWorkspace();
  const runtime = new DshRuntime({ home, apiKey: 'unused-startup-cancellation-key' });
  try {
    await runtime.createSession({ sessionId: 'sess_cancel_startup', workspacePath: workspace });
    const stream = runtime.run({ sessionId: 'sess_cancel_startup', prompt: 'Never reaches a provider: cancelled during subprocess startup.' })[Symbol.asyncIterator]();
    assert.deepEqual((await stream.next()).value, { type: 'status', status: 'starting' });
    await assert.rejects(async () => {
      for await (const event of runtime.run({ sessionId: 'sess_cancel_startup', prompt: 'Overlapping prompt' })) void event;
    }, /active run/);
    await runtime.cancel('sess_cancel_startup');
    const remaining = [];
    for (;;) { const result = await stream.next(); if (result.done) break; remaining.push(result.value); }
    assert.deepEqual(remaining.at(-1), { type: 'status', status: 'stopped' });
    await runtime.destroySession('sess_cancel_startup');
    await runtime.createSession({ sessionId: 'sess_cancel_startup', workspacePath: workspace });
  } finally { await runtime.destroySession('sess_cancel_startup'); await rm(home, { recursive: true, force: true }); }
});

test('provider notification and thrown failures redact credentials before leaving the adapter', async context => {
  const { home, workspace } = await temporaryWorkspace();
  const apiKey = 'private-gateway-test-key';
  const sessionId = 'sess_redact_provider_error';
  let closed = false;
  context.mock.method(DeepSeekHarness.prototype, 'run', async (_prompt: unknown, options?: RunOptions) => {
    options?.onNotification?.({ method: 'session.event', params: { sessionId, event: {
      type: 'turn/end', data: { reason: { kind: 'error', error: { message: `Rejected credential ${apiKey}` } } },
    } } });
    throw new Error(`Gateway repeated ${apiKey}`);
  });
  context.mock.method(DeepSeekHarness.prototype, 'close', async () => { closed = true; });
  const runtime = new DshRuntime({ home, apiKey, provider: 'openai-compatible', model: 'custom-model', baseUrl: 'https://gateway.example' });
  try {
    await runtime.createSession({ sessionId, workspacePath: workspace });
    const events = [];
    for await (const event of runtime.run({ sessionId, prompt: 'Hello' })) {
      if (event.type === 'status' && event.status === 'error') assert.equal(closed, true);
      events.push(event);
    }
    assert.deepEqual(events.filter(event => event.type === 'error').map(event => event.message), ['Rejected credential [redacted]', 'Gateway repeated [redacted]']);
    assert.equal(JSON.stringify(events).includes(apiKey), false);
    assert.deepEqual(events.at(-1), { type: 'status', status: 'error' });
  } finally { await runtime.destroySession(sessionId); await rm(home, { recursive: true, force: true }); }
});
