import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DshRuntime } from './index.ts';
import type { AgentEvent } from '@cloud-work/protocol';

test('real SDK forwards live provider chunks before completion without duplicating the final message', { timeout: 30_000 }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cloud-work-live-stream-')));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  let release: () => void = () => {};
  const continueResponse = new Promise<void>(resolve => { release = resolve; });
  let responseFinished = false;
  let requests = 0;
  let registeredTools: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: { function?: { name?: string } }[] };
    registeredTools = (body.tools ?? []).flatMap(tool => tool.function?.name ? [tool.function.name] : []);
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    requests++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (delta: object, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-local-stream-contract', object: 'chat.completion.chunk', created: 1, model: 'local-stream-contract', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    send({ role: 'assistant', content: 'FIRST_FRAGMENT ' });
    // A working bridge releases the second token while this HTTP response is still open.
    const timeout = setTimeout(release, 3000);
    await continueResponse;
    clearTimeout(timeout);
    send({ content: 'SECOND_FRAGMENT' });
    send({}, 'stop');
    responseFinished = true;
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const runtime = new DshRuntime({ home, provider: 'openai-compatible', model: 'local-stream-contract', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-test-fixture' });
  const sessionId = 'sess_live_stream_contract';
  const events: AgentEvent[] = [];
  let firstArrivedBeforeCompletion = false;
  try {
    await runtime.createSession({ sessionId, workspacePath: workspace });
    for await (const event of runtime.run({ sessionId, prompt: 'Respond with the fixture text.' })) {
      if (event.type === 'text-delta' && event.text === 'FIRST_FRAGMENT ') {
        firstArrivedBeforeCompletion = !responseFinished;
        release();
      }
      events.push(event);
    }
    assert.equal(firstArrivedBeforeCompletion, true, 'first text must arrive while the provider response remains open');
    assert.deepEqual(events.filter(event => event.type === 'text-delta').map(event => event.text), ['FIRST_FRAGMENT ', 'SECOND_FRAGMENT']);
    assert.deepEqual(events.at(-1), { type: 'status', status: 'idle' });
    assert.equal(requests, 1);
    assert.ok(registeredTools.includes('bash'));
    for (const name of ['web_search', 'web_fetch', 'write', 'edit', 'workflow', 'run_code', 'ralph']) {
      assert.equal(registeredTools.includes(name), false, `offline deployment must exclude ${name} from the real model tool catalog`);
    }
  } finally {
    release();
    await runtime.destroySession(sessionId);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
