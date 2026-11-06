/** Real compatible-provider tools/streaming check, executed inside a user runtime. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DshRuntime } from '@cloud-work/runtime-dsh';
import type { AgentEvent } from '@cloud-work/runtime-core';
import { verifySandbox } from './sandbox.ts';

const provider = process.env.GATEWAY_SMOKE_PROVIDER ?? process.env.DSH_PROVIDER;
assert.ok(provider === 'openai-compatible' || provider === 'anthropic-compatible');
const workspace = `/home/work/workspaces/ws_gateway_${randomUUID()}`;
const sessionId = `sess_${randomUUID()}`;
const proof = `GATEWAY_VERIFIED_${randomUUID()}`;
await mkdir(workspace, { mode: 0o700 });
await writeFile(join(workspace, 'input.txt'), proof);
const runtime = new DshRuntime({ provider });
await runtime.createSession({ sessionId, workspacePath: workspace });
const events: AgentEvent[] = [];
const startedAt = performance.now();
let firstTextAtMs: number | undefined;
let lastTextAtMs: number | undefined;
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; void runtime.cancel(sessionId).catch(() => {}); }, 180_000);
try {
  for await (const event of runtime.run({ sessionId, prompt: 'Read input.txt using your tools. Write exactly its contents into output.txt using your tools. Read output.txt to verify it, then briefly confirm success. Do not ask questions.' })) {
    events.push(event);
    if (event.type === 'text-delta') {
      firstTextAtMs ??= performance.now() - startedAt;
      lastTextAtMs = performance.now() - startedAt;
    }
    if (event.type === 'tool-start') console.log(JSON.stringify({ progress: 'tool-start', name: event.name }));
    if (event.type === 'error') console.log(JSON.stringify(event));
  }
  assert.equal(timedOut, false, 'Gateway smoke exceeded 180 seconds');
  assert.ok(!events.some(event => event.type === 'error'), 'Gateway returned an error');
  for (const type of ['text-delta', 'tool-start', 'tool-result']) assert.ok(events.some(event => event.type === type), `Missing ${type}`);
  assert.deepEqual(events.at(-1), { type: 'status', status: 'idle' });
  assert.equal((await readFile(join(workspace, 'output.txt'), 'utf8')).trim(), proof);
  console.log(JSON.stringify({
    provider, model: process.env.DSH_MODEL, sessionId, workspace, sandbox: verifySandbox(),
    realToolFileVerified: true,
    textChunks: events.filter(event => event.type === 'text-delta').length,
    firstTextAtMs, lastTextAtMs, completedAtMs: performance.now() - startedAt,
    tools: events.filter(event => event.type === 'tool-start').map(event => event.name),
    reply: events.filter(event => event.type === 'text-delta').map(event => event.text).join(''),
  }));
} finally {
  clearTimeout(timeout);
  await runtime.destroySession(sessionId);
}
