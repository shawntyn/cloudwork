import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createFixtureServer, fixtureToken } from '../src/fixture.js';
import { Upstream } from '../src/upstream.js';
import { DestinationPolicy } from '../src/policy.js';

// Test-only DNS injection sends an allowed synthetic hostname to an ephemeral local fixture.
// The production policy's hard loopback prohibition remains unchanged.
class FixturePolicy extends DestinationPolicy {
  override async resolve() { return [{ address: '127.0.0.1', family: 4 }]; }
}

async function listen(t: TestContext, server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port, url: `http://fixture.test:${address.port}/mcp`, origin: `http://fixture.test:${address.port}` };
}

type Rpc = { id?: string | number; method: string; params?: Record<string, unknown> };
async function responder(t: TestContext, handler: (body: Rpc, response: ServerResponse) => Promise<unknown> | unknown) {
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Rpc;
    methods.push(body.method);
    if (body.method === 'initialize') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } }));
      return;
    }
    if (body.id === undefined) { response.writeHead(202).end(); return; }
    try {
      const result = await handler(body, response);
      if (!response.writableEnded && !response.destroyed) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      }
    } catch { response.writeHead(500).end('Fixture failure'); }
  });
  return { ...await listen(t, server), methods };
}

test('official SDK fixture discovers complete schemas and executes authenticated add/echo tools', async t => {
  const fixture = await listen(t, createFixtureServer());
  const upstream = new Upstream(new FixturePolicy(fixture.origin), fixture.url, { Authorization: `Bearer ${fixtureToken}` });
  t.after(() => upstream.close());
  const tools = await upstream.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['cloudwork_add', 'cloudwork_echo']);
  const addition = tools[0]!;
  assert.equal(addition.inputSchema.type, 'object');
  assert.deepEqual(addition.inputSchema.required, ['a', 'b']);
  assert.match(JSON.stringify(addition.inputSchema), /First number to add/);
  assert.match(JSON.stringify(addition.outputSchema), /The sum of a and b/);
  assert.equal(addition.annotations?.readOnlyHint, true);
  const result = await upstream.callTool('cloudwork_add', { a: 20, b: 22 });
  assert.deepEqual(result.structuredContent, { sum: 42 });
  assert.deepEqual(result.content, [{ type: 'text', text: '42' }]);
  const echo = await upstream.callTool('cloudwork_echo', { text: `Bearer ${fixtureToken}` });
  assert.deepEqual(echo.content, [{ type: 'text', text: '[redacted]' }]);
  assert.equal((await fetch(`http://127.0.0.1:${fixture.port}/mcp`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${fixture.port}/mcp`, { headers: { Authorization: `Bearer ${fixtureToken}` } })).status, 405);
});

test('concurrent first calls share one initialization and the fifth operation is rejected', async t => {
  let release!: () => void, allStarted!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { allStarted = resolve; });
  let pending = 0;
  const fixture = await responder(t, async () => { if (++pending === 4) allStarted(); await held; return { content: [{ type: 'text', text: 'ok' }] }; });
  const upstream = new Upstream(new FixturePolicy(fixture.origin), fixture.url, {});
  t.after(async () => { release(); await upstream.close(); });
  const operations = Array.from({ length: 4 }, () => upstream.callTool('example', {}));
  await assert.rejects(upstream.callTool('example', {}), error => error instanceof Error && 'statusCode' in error && error.statusCode === 429);
  await started;
  assert.equal(fixture.methods.filter(method => method === 'initialize').length, 1);
  release();
  assert.equal((await Promise.all(operations)).length, 4);
});

test('failed authentication stays sanitized and never initiates OAuth or reconnects', async t => {
  let requests = 0;
  const fixture = await listen(t, createServer((_request, response) => {
    requests++;
    response.writeHead(401, { 'WWW-Authenticate': 'Bearer resource_metadata="https://attacker.example/metadata"' }).end(`Credential: ${fixtureToken}`);
  }));
  const upstream = new Upstream(new FixturePolicy(fixture.origin), fixture.url, { Authorization: `Bearer ${fixtureToken}` });
  t.after(() => upstream.close());
  for (let i = 0; i < 2; i++) await assert.rejects(upstream.listTools(), error => error instanceof Error && error.message === 'MCP service request failed');
  assert.equal(requests, 1);
});

test('descriptions, complete nested schemas and structured tool content are secret-redacted', async t => {
  const inputSchema = { type: 'object', properties: { value: { type: 'string', description: fixtureToken, enum: ['one', 'two'] } }, required: ['value'], additionalProperties: false };
  const fixture = await responder(t, body => body.method === 'tools/list'
    ? { tools: [{ name: 'example', description: `Bearer ${fixtureToken}`, inputSchema }] }
    : { content: [{ type: 'text', text: `nested ${fixtureToken}` }], structuredContent: { nested: [{ secret: fixtureToken }], [fixtureToken]: fixtureToken } });
  const upstream = new Upstream(new FixturePolicy(fixture.origin), fixture.url, { Authorization: `Bearer ${fixtureToken}` });
  t.after(() => upstream.close());
  const tools = await upstream.listTools();
  assert.equal(tools[0]!.description, '[redacted]');
  assert.deepEqual(tools[0]!.inputSchema, { ...inputSchema, properties: { value: { ...inputSchema.properties.value, description: '[redacted]' } } });
  const result = await upstream.callTool('example', { value: 'one' });
  assert.ok(!JSON.stringify(result).includes(fixtureToken));
  assert.deepEqual(result.structuredContent, { nested: [{ secret: '[redacted]' }], '[redacted]': '[redacted]' });
});

test('untrusted tool listing rejects excessive counts, oversized schemas, invalid names and repeated cursors', async t => {
  const tool = { name: 'example', inputSchema: { type: 'object' } };
  const cases = [
    { tools: Array.from({ length: 129 }, (_, id) => ({ ...tool, name: `tool_${id}` })) },
    { tools: [{ ...tool, name: 'x'.repeat(129) }] },
    { tools: [{ ...tool, inputSchema: { type: 'object', description: 'x'.repeat(65_536) } }] },
    { tools: [{ ...tool, description: 'x'.repeat(4097) }] },
    { tools: [], nextCursor: 'same-cursor' },
  ];
  for (const response of cases) {
    const fixture = await responder(t, () => response);
    const upstream = new Upstream(new FixturePolicy(fixture.origin), fixture.url, {});
    try { await assert.rejects(upstream.listTools(), /MCP service request failed/); }
    finally { await upstream.close(); }
  }
});

test('discovery forwards complete output schemas without compiling or fetching remote references', async t => {
  const outputSchema = { type: 'object', properties: { value: { $ref: 'https://untrusted.invalid/schema' } }, additionalProperties: false };
  const fixture = await responder(t, () => ({ tools: [{ name: 'example', inputSchema: { type: 'object' }, outputSchema }] }));
  const upstream = new Upstream(new FixturePolicy(fixture.origin), fixture.url, {});
  t.after(() => upstream.close());
  assert.deepEqual((await upstream.listTools())[0]!.outputSchema, outputSchema);
  assert.equal(fixture.methods.filter(method => method === 'tools/list').length, 1);
});

test('close aborts in-flight transport work and prevents future operations', async t => {
  let started!: () => void;
  const called = new Promise<void>(resolve => { started = resolve; });
  const fixture = await responder(t, async (_body, response) => {
    started();
    await new Promise<void>(resolve => response.once('close', () => resolve()));
    return { content: [] };
  });
  const upstream = new Upstream(new FixturePolicy(fixture.origin), fixture.url, {});
  const result = upstream.callTool('example', {});
  const rejection = assert.rejects(result, /MCP service request failed/);
  await called;
  await upstream.close();
  await rejection;
  await assert.rejects(upstream.listTools(), /MCP connection is closed/);
  await upstream.close();
});
