import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, McpRunSnapshot } from '@cloud-work/protocol';
import { DshRuntime } from './index.ts';

test('real SDK routes same-name MCP tools by alias, isolates concurrent snapshots and removes overlays', { timeout: 60_000 }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cloud-work-mcp-contract-')));
  const workspaceA = join(home, 'workspace-a');
  const workspaceB = join(home, 'workspace-b');
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  const catalogs = new Map<string, string[]>();
  const authorizations: Array<{ path: string; value: string | undefined }> = [];
  const toolCalls: Array<{ path: string; name: string }> = [];
  const warmAliases = ['sales_prod', 'sales_test'];
  let concurrentRequests = 0;
  let releaseResponses: () => void = () => {};
  const responsesReleased = new Promise<void>(resolve => { releaseResponses = resolve; });
  let bothReady: () => void = () => {};
  const bothRequestsReady = new Promise<void>(resolve => { bothReady = resolve; });
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (request.url?.startsWith('/mcp/')) {
        const name = request.url.split('/').at(-1)!;
        authorizations.push({ path: request.url, value: request.headers.authorization });
        if (request.method !== 'POST') { response.writeHead(405).end(); return; }
        if (body.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
        let result: unknown;
        if (body.method === 'initialize') result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-mcp-fixture', version: '1.0.0' } };
        else if (body.method === 'tools/list') result = { tools: [{ name: 'execute_sql', description: `Local MCP fixture for ${name}`, inputSchema: { type: 'object', properties: {} } }] };
        else if (body.method === 'tools/call') {
          toolCalls.push({ path: request.url, name: body.params.name });
          result = { content: [{ type: 'text', text: `Fixture echoes scoped-${name}-token for redaction verification` }] };
        } else { response.writeHead(400).end(); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      let userIndex = -1;
      let marker: string | undefined;
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]!.role !== 'user') continue;
        marker = JSON.stringify(messages[index]!.content).match(/MCP_(WARM|BETA|GAMMA|NONE)/)?.[0];
        if (marker) { userIndex = index; break; }
      }
      assert.ok(marker, 'fixture prompt marker must reach the actual provider');
      catalogs.set(marker, (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name));
      if (marker === 'MCP_BETA' || marker === 'MCP_GAMMA') {
        concurrentRequests++;
        if (concurrentRequests === 2) bothReady();
        await responsesReleased;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-local-mcp-contract', object: 'chat.completion.chunk', created: 1, model: 'local-mcp-contract', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const toolReplies = messages.slice(userIndex + 1).filter(message => message.role === 'tool').length;
      if (marker === 'MCP_WARM' && toolReplies < warmAliases.length) {
        send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_local_mcp_${toolReplies}`, type: 'function', function: { name: `mcp__${warmAliases[toolReplies]}__execute_sql`, arguments: '{}' } }] });
        send({}, 'tool_calls');
      } else { send({ role: 'assistant', content: `${marker}_DONE` }); send({}, 'stop'); }
      response.end('data: [DONE]\n\n');
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const runtime = new DshRuntime({ home, apiKey: 'local-provider-fixture-key', provider: 'openai-compatible', model: 'local-mcp-contract', baseUrl });
  const snapshot = (...aliases: string[]): McpRunSnapshot => ({ runId: `run_${aliases.join('_')}`, revision: `revision_${aliases.join('_')}`, connections: aliases.map(name => ({ id: `id_${name}`, serverName: name, url: `${baseUrl}/mcp/${name}`, token: `scoped-${name}-token` })) });
  const collect = async (sessionId: string, prompt: string, mcp?: McpRunSnapshot) => {
    const events: AgentEvent[] = [];
    for await (const event of runtime.run({ sessionId, prompt, mcp })) events.push(event);
    assert.deepEqual(events.filter(event => event.type === 'error'), [], JSON.stringify(events));
    assert.deepEqual(events.at(-1), { type: 'status', status: 'idle' });
    return events;
  };
  try {
    await runtime.createSession({ sessionId: 'sess_mcp_a', workspacePath: workspaceA });
    await runtime.createSession({ sessionId: 'sess_mcp_b', workspacePath: workspaceB });
    const warm = await collect('sess_mcp_a', 'MCP_WARM', snapshot(...warmAliases));
    assert.deepEqual(toolCalls, warmAliases.map(name => ({ path: `/mcp/${name}`, name: 'execute_sql' })));
    assert.deepEqual(warm.filter(event => event.type === 'tool-start').map(event => event.name), warmAliases.map(name => `mcp__${name}__execute_sql`));
    assert.equal(warm.filter(event => event.type === 'tool-result' && JSON.stringify(event.output).includes('[redacted]')).length, 2);
    for (const name of warmAliases) assert.equal(JSON.stringify(warm).includes(`scoped-${name}-token`), false);
    assert.deepEqual(await readdir(join(home, '.cloud-work', 'mcp-runs')), []);
    const concurrent = Promise.all([
      collect('sess_mcp_a', 'MCP_BETA', snapshot('sales_stage')),
      collect('sess_mcp_b', 'MCP_GAMMA', snapshot('finance_test')),
    ]);
    await Promise.race([bothRequestsReady, concurrent.then(() => { throw new Error('Concurrent runs finished before both provider requests'); })]);
    const directories = await readdir(join(home, '.cloud-work', 'mcp-runs'));
    assert.equal(directories.length, 2);
    const overlays = await Promise.all(directories.map(directory => readFile(join(home, '.cloud-work', 'mcp-runs', directory, 'mcp.patch.yml'), 'utf8')));
    for (const overlay of overlays) assert.equal(/scoped-(sales_prod|sales_test|sales_stage|finance_test)-token/.test(overlay), false);
    releaseResponses();
    await concurrent;
    await collect('sess_mcp_a', 'MCP_NONE');
    for (const [marker, aliases] of [['MCP_WARM', warmAliases], ['MCP_BETA', ['sales_stage']], ['MCP_GAMMA', ['finance_test']]] as const) {
      assert.deepEqual(catalogs.get(marker)!.filter(tool => tool.startsWith('mcp__')).sort(), aliases.map(name => `mcp__${name}__execute_sql`).sort());
      for (const name of aliases) assert.ok(authorizations.some(auth => auth.path === `/mcp/${name}` && auth.value === `Bearer scoped-${name}-token`));
    }
    assert.deepEqual(catalogs.get('MCP_NONE')!.filter(tool => tool.startsWith('mcp__')), []);
    assert.deepEqual(await readdir(join(home, '.cloud-work', 'mcp-runs')), []);
  } finally {
    releaseResponses();
    await Promise.allSettled([runtime.destroySession('sess_mcp_a'), runtime.destroySession('sess_mcp_b')]);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
