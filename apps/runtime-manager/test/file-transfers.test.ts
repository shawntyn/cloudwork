import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { FILE_TRANSFER_LIMITS } from '@cloud-work/protocol';
import { registerFileTransfers } from '../src/file-transfers.js';
import { HttpError } from '../src/config.js';
import { RuntimeManager } from '../src/lifecycle.js';
import type { Leases } from '../src/leases.js';

const base = '/internal/users/alice/workspaces/ws_test/files';
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function fixture(request: (user: string, suffix: string, init: RequestInit) => Promise<Response>, check?: (user: string, workspace: string) => Promise<void>) {
  let active = false, locked = false, checks = 0;
  const released = deferred();
  const app = Fastify({ bodyLimit: 128 });
  registerFileTransfers(app, {
    request,
    async withActivity<T>(user: string, operation: () => Promise<T>) {
      assert.equal(user, 'alice');
      assert.equal(locked, true);
      active = true;
      try { return await operation(); } finally { active = false; }
    },
    leases: { async withLock<T>(key: string, operation: () => Promise<T>) {
      assert.equal(key, 'workspace:ws_test:operation-lock');
      locked = true;
      try { return await operation(); } finally { locked = false; released.resolve(); }
    } },
  }, async (user, workspace) => {
    assert.equal(user, 'alice'); assert.equal(workspace, 'ws_test');
    checks++;
    await check?.(user, workspace);
  });
  return { app, released: released.promise, state: () => ({ active, locked, checks }) };
}

test('upload reaches the runtime incrementally and leases cover the full transfer', { timeout: 10_000 }, async () => {
  const first = deferred(), finishUpload = deferred();
  let seen = '';
  const runtime = createHttpServer(async (request, response) => {
    assert.equal(request.url, '/workspaces/ws_test/files/uploads/batch?path=hello.txt&conflict=error');
    assert.equal(request.headers['content-type'], 'application/octet-stream');
    for await (const chunk of request) { seen += chunk.toString(); first.resolve(); }
    await finishUpload.promise;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ path: 'hello.txt', size: seen.length }));
  });
  const address = await listen(runtime);
  const f = fixture(async (_user, suffix, init) => {
    assert.equal((init as RequestInit & { duplex: string }).duplex, 'half');
    return fetch(address + suffix, init);
  });
  await f.app.listen({ port: 0, host: '127.0.0.1' });
  const clientAddress = `http://127.0.0.1:${(f.app.server.address() as AddressInfo).port}`;
  const result = deferred<{ status: number; body: string }>();
  const client = httpRequest(clientAddress + base + '/uploads/batch?path=hello.txt&conflict=error', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' } }, async response => {
    let body = '';
    for await (const chunk of response) body += chunk;
    result.resolve({ status: response.statusCode!, body });
  });
  client.on('error', result.reject);
  try {
    client.write('first');
    await first.promise;
    assert.equal(seen, 'first');
    assert.deepEqual(f.state(), { active: true, locked: true, checks: 1 });
    client.end('second');
    finishUpload.resolve();
    const response = await result.promise;
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { path: 'hello.txt', size: 11 });
    await f.released;
    assert.deepEqual(f.state(), { active: false, locked: false, checks: 1 });
  } finally { client.destroy(); finishUpload.resolve(); await f.app.close(); await close(runtime); }
});

test('download forwards range and attachment headers while activity lasts through the final byte', { timeout: 10_000 }, async () => {
  const continueBody = deferred();
  const runtime = createHttpServer(async (request, response) => {
    assert.equal(request.url, '/workspaces/ws_test/files/download?path=report.bin');
    assert.equal(request.headers.range, 'bytes=0-5');
    response.writeHead(206, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.bin"', 'content-range': 'bytes 0-5/100', 'content-length': '6', 'accept-ranges': 'bytes', etag: '"test"', 'x-private-runtime-value': 'never-forward' });
    response.write('abc');
    await continueBody.promise;
    response.end('def');
  });
  const address = await listen(runtime), f = fixture((_user, suffix, init) => fetch(address + suffix, init));
  const proxy = await f.app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const response = await fetch(proxy + base + '/download?path=report.bin', { headers: { range: 'bytes=0-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-5/100');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="report.bin"');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('etag'), '"test"');
    assert.equal(response.headers.get('x-private-runtime-value'), null);
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'abc');
    assert.deepEqual(f.state(), { active: true, locked: true, checks: 1 });
    continueBody.resolve();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'def');
    assert.equal((await reader.read()).done, true);
    await f.released;
    assert.equal(f.state().active, false);
  } finally { continueBody.resolve(); await f.app.close(); await close(runtime); }
});

test('cancelling a download aborts the runtime fetch and releases both leases', { timeout: 10_000 }, async () => {
  const runtimeClosed = deferred(), aborted = deferred();
  const runtime = createHttpServer((_request, response) => {
    response.on('close', () => runtimeClosed.resolve());
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write('first');
  });
  const address = await listen(runtime), f = fixture((_user, suffix, init) => {
    init.signal!.addEventListener('abort', () => aborted.resolve(), { once: true });
    return fetch(address + suffix, init);
  });
  const proxy = await f.app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const response = await fetch(proxy + base + '/download?path=large.bin');
    const reader = response.body!.getReader();
    await reader.read();
    assert.equal(f.state().active, true);
    await reader.cancel();
    await Promise.all([aborted.promise, runtimeClosed.promise, f.released]);
    assert.deepEqual(f.state(), { active: false, locked: false, checks: 1 });
  } finally { await f.app.close(); await close(runtime); }
});

test('disconnecting an upload aborts the runtime request and releases activity', { timeout: 10_000 }, async () => {
  const first = deferred(), runtimeClosed = deferred(), aborted = deferred();
  const runtime = createHttpServer(request => {
    request.on('data', () => first.resolve());
    request.on('close', () => runtimeClosed.resolve());
  });
  const address = await listen(runtime), f = fixture((_user, suffix, init) => {
    init.signal!.addEventListener('abort', () => aborted.resolve(), { once: true });
    return fetch(address + suffix, init);
  });
  const proxy = await f.app.listen({ port: 0, host: '127.0.0.1' });
  const client = httpRequest(proxy + base + '/uploads/batch?path=large.bin', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' } });
  client.on('error', () => {});
  try {
    client.write('first');
    await first.promise;
    assert.equal(f.state().active, true);
    client.destroy();
    await Promise.all([aborted.promise, runtimeClosed.promise, f.released]);
    assert.deepEqual(f.state(), { active: false, locked: false, checks: 1 });
  } finally { client.destroy(); await f.app.close(); await close(runtime); }
});

test('binary parser is isolated and rejected ownership never contacts the runtime', async () => {
  let calls = 0;
  const f = fixture(async (_user, _suffix, init) => { calls++; return Response.json({ id: 'batch', received: init.body }); });
  f.app.post('/ordinary', request => ({ body: request.body }));
  try {
    const wrongParser = await f.app.inject({ method: 'POST', url: '/ordinary', headers: { 'content-type': 'application/octet-stream' }, payload: 'binary' });
    assert.equal(wrongParser.statusCode, 415);
    const largeJson = await f.app.inject({ method: 'POST', url: base + '/uploads', payload: { files: [], extra: 'x'.repeat(129) } });
    assert.equal(largeJson.statusCode, 413);
    const wrongUploadType = await f.app.inject({ method: 'PUT', url: base + '/uploads/batch', payload: { data: 'binary' } });
    assert.equal(wrongUploadType.statusCode, 415);
    const oversized = await f.app.inject({ method: 'PUT', url: base + '/uploads/batch', headers: { 'content-type': 'application/octet-stream', 'content-length': String(FILE_TRANSFER_LIMITS.maxFileBytes + 1) }, payload: 'x' });
    assert.equal(oversized.statusCode, 413);
    assert.equal(calls, 0);
    const manifest = await f.app.inject({ method: 'POST', url: base + '/uploads', payload: { files: [], directories: ['empty'] } });
    assert.equal(manifest.statusCode, 200);
    assert.deepEqual(JSON.parse(manifest.json().received), { files: [], directories: ['empty'] });
  } finally { await f.app.close(); }
  const forbidden = fixture(async () => { calls++; return Response.json({}); }, async () => { throw new HttpError(404, 'Workspace not found'); });
  try {
    const response = await forbidden.app.inject({ method: 'GET', url: base + '/download?path=secret.txt' });
    assert.equal(response.statusCode, 404);
    assert.equal(calls, 1);
    assert.deepEqual(forbidden.state(), { active: false, locked: false, checks: 1 });
  } finally { await forbidden.app.close(); }
});

test('upstream upload errors remain JSON responses instead of losing the client socket', { timeout: 10_000 }, async () => {
  const runtime = createHttpServer((request, response) => {
    request.once('data', () => {
      response.writeHead(409, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error: 'File already exists' }));
    });
  });
  const address = await listen(runtime), f = fixture((_user, suffix, init) => fetch(address + suffix, init));
  const proxy = await f.app.listen({ port: 0, host: '127.0.0.1' });
  const result = deferred<{ status: number; body: string }>();
  const client = httpRequest(proxy + base + '/uploads/batch?path=existing.txt', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' } }, async response => {
    let body = ''; for await (const chunk of response) body += chunk;
    result.resolve({ status: response.statusCode!, body });
  });
  client.on('error', result.reject);
  try {
    client.write('unfinished request');
    const response = await result.promise;
    assert.equal(response.status, 409);
    assert.equal(JSON.parse(response.body).error, 'File already exists');
    await f.released;
    assert.equal(f.state().active, false);
  } finally { client.destroy(); await f.app.close(); await close(runtime); }
});

test('activity cleanup clears the busy lease even when last-active storage fails', async () => {
  let cleared = false;
  const manager = new RuntimeManager({ heartbeatMs: 1000 } as RuntimeManager['config'], {
    setBusy: async () => {}, clearBusy: async () => { cleared = true; },
  } as unknown as Leases, { info() {}, error() {} });
  manager.touchRuntime = async () => { throw new Error('Database unavailable'); };
  await assert.rejects(manager.withActivity('alice', async () => 'done', false), /Database unavailable/);
  assert.equal(cleared, true);
});

test('RuntimeManager request preserves binary content type instead of combining it with the JSON default', { timeout: 10_000 }, async () => {
  const seen: string[] = [];
  const runtime = createHttpServer(async (request, response) => {
    seen.push(request.headers['content-type']!);
    assert.match(request.headers.authorization!, /^Bearer /);
    assert.notEqual(request.headers.authorization, 'Bearer untrusted');
    for await (const _chunk of request) { /* Consume all request bytes. */ }
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  const address = await listen(runtime);
  const manager = new RuntimeManager({ tokenSecret: 'test-derivation-secret' } as RuntimeManager['config'], {} as Leases, { info() {}, error() {} });
  manager.address = async () => address;
  try {
    const binary = await manager.request('alice', '/upload', { method: 'PUT', body: 'bytes', headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer untrusted' } });
    await binary.json();
    const json = await manager.request('alice', '/manifest', { method: 'POST', body: '{}' });
    await json.json();
    const object = await manager.request('alice', '/upload', { method: 'PUT', body: 'bytes', headers: new Headers({ 'content-type': 'application/octet-stream' }) });
    await object.json();
    assert.deepEqual(seen, ['application/octet-stream', 'application/json', 'application/octet-stream']);
  } finally { await close(runtime); }
});
