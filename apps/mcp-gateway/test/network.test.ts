import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import { createNetwork, DestinationPolicy } from '../src/policy.js';

class LocalFixturePolicy extends DestinationPolicy {
  lookups = 0;
  refuse = false;
  override async resolve() {
    this.lookups++;
    if (this.refuse) throw new Error('DNS answer is no longer allowed');
    return [{ address: '127.0.0.1', family: 4 }];
  }
}

async function listen(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  const sockets = { opened: 0, closed: 0 };
  server.on('connection', socket => { sockets.opened++; socket.once('close', () => { sockets.closed++; }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, sockets, origin: `http://fixture.invalid:${address.port}`, url: `http://fixture.invalid:${address.port}/mcp` };
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function settled(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Expected request socket cleanup within two seconds');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('completed responses release their per-request agent before network.close', async t => {
  const fixture = await listen(t, (_request, response) => response.end('complete'));
  const policy = new LocalFixturePolicy(fixture.origin), network = createNetwork(policy, fixture.url, new AbortController().signal);
  t.after(() => network.close());
  for (let i = 1; i <= 3; i++) {
    assert.equal(await (await network.fetch(fixture.url)).text(), 'complete');
    await settled(() => fixture.sockets.closed === i);
  }
  assert.deepEqual(fixture.sockets, { opened: 3, closed: 3 });
});

test('redirects are never followed and credentials do not reach the redirect destination', async t => {
  let destinationHits = 0, authorization: string | undefined;
  const destination = await listen(t, (_request, response) => { destinationHits++; response.end('must not be reached'); });
  const source = await listen(t, (request, response) => { authorization = request.headers.authorization; response.writeHead(302, { Location: destination.url }).end(); });
  const network = createNetwork(new LocalFixturePolicy(`${source.origin},${destination.origin}`), source.url, new AbortController().signal);
  t.after(() => network.close());
  await assert.rejects(network.fetch(source.url, { headers: { Authorization: 'Bearer fixture-secret' } }), /redirects are not allowed/);
  await settled(() => source.sockets.closed === 1);
  assert.equal(authorization, 'Bearer fixture-secret');
  assert.equal(destinationHits, 0);
});

test('declared and streamed responses over two MiB abort their request sockets', async t => {
  for (const declared of [true, false]) {
    let sent = 0, responseClosed = false;
    const fixture = await listen(t, (_request, response) => {
      if (declared) response.setHeader('Content-Length', 3 * 1024 * 1024);
      response.write(Buffer.alloc(1024));
      const interval = setInterval(() => { sent += 64 * 1024; response.write(Buffer.alloc(64 * 1024)); }, 1);
      response.once('close', () => { responseClosed = true; clearInterval(interval); });
    });
    const network = createNetwork(new LocalFixturePolicy(fixture.origin), fixture.url, new AbortController().signal);
    t.after(() => network.close());
    if (declared) await assert.rejects(network.fetch(fixture.url), /too large/);
    else {
      const response = await network.fetch(fixture.url);
      await assert.rejects(response.arrayBuffer(), /too large/);
    }
    await settled(() => responseClosed && fixture.sockets.closed === 1);
    assert.ok(sent < 4 * 1024 * 1024, 'Oversized streaming response should be aborted instead of drained');
  }
});

test('response cancellation releases the agent while an upstream stream is still active', async t => {
  let ended = false;
  const fixture = await listen(t, (_request, response) => {
    response.write('first chunk');
    response.once('close', () => { ended = true; });
  });
  const network = createNetwork(new LocalFixturePolicy(fixture.origin), fixture.url, new AbortController().signal);
  t.after(() => network.close());
  const response = await network.fetch(fixture.url);
  assert.equal(ended, false);
  await response.body!.cancel('consumer stopped');
  await settled(() => ended && fixture.sockets.closed === 1);
});

test('validated DNS answers are pinned to the socket and rechecked on the next fetch', async t => {
  let requests = 0, host: string | undefined;
  const fixture = await listen(t, (request, response) => { requests++; host = request.headers.host; response.end('pinned'); });
  const policy = new LocalFixturePolicy(fixture.origin), network = createNetwork(policy, fixture.url, new AbortController().signal);
  t.after(() => network.close());
  // fixture.invalid cannot resolve through ordinary DNS: success proves the validated lookup is used.
  assert.equal(await (await network.fetch(fixture.url)).text(), 'pinned');
  assert.equal(host, new URL(fixture.url).host);
  assert.equal(policy.lookups, 1);
  policy.refuse = true;
  await assert.rejects(network.fetch(fixture.url), /DNS answer is no longer allowed/);
  assert.equal(policy.lookups, 2);
  assert.equal(requests, 1);
});

test('Request inputs preserve method, credentials, body and cancellation alongside SDK URL/init calls', async t => {
  let notify!: () => void;
  const received = new Promise<void>(resolve => { notify = resolve; });
  const fixture = await listen(t, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = { method: request.method, auth: request.headers.authorization, body: Buffer.concat(chunks).toString() };
    if (request.headers['x-hold']) { notify(); response.write('pending'); }
    else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); }
  });
  const network = createNetwork(new LocalFixturePolicy(fixture.origin), fixture.url, new AbortController().signal);
  t.after(() => network.close());
  const init = { method: 'POST', headers: { Authorization: 'Bearer fixture-secret' }, body: 'request-payload' };
  for (const response of [await network.fetch(new Request(fixture.url, init)), await network.fetch(new URL(fixture.url), init)]) {
    assert.deepEqual(await response.json(), { method: 'POST', auth: 'Bearer fixture-secret', body: 'request-payload' });
  }
  const cancellation = new AbortController();
  const response = await network.fetch(new Request(fixture.url, { ...init, headers: { ...init.headers, 'x-hold': '1' }, signal: cancellation.signal }));
  await received;
  cancellation.abort(new Error('request cancelled'));
  await assert.rejects(response.text());
  await settled(() => fixture.sockets.closed === fixture.sockets.opened);
});

test('network.close aborts pending DNS and prevents late resolver completion from opening a connection', async t => {
  let finish!: (value: Array<{ address: string; family: number }>) => void;
  const resolution = new Promise<Array<{ address: string; family: number }>>(resolve => { finish = resolve; });
  let hits = 0;
  const fixture = await listen(t, (_request, response) => { hits++; response.end(); });
  class SlowPolicy extends LocalFixturePolicy { override async resolve() { return resolution; } }
  const network = createNetwork(new SlowPolicy(fixture.origin), fixture.url, new AbortController().signal);
  const pending = network.fetch(fixture.url);
  const rejected = assert.rejects(pending, /MCP network closed/);
  await network.close();
  await rejected;
  finish([{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(network.fetch(fixture.url), /MCP network closed/);
  assert.equal(hits, 0);
  assert.equal(fixture.sockets.opened, 0);
});
