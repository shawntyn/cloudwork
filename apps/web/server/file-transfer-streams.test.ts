import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { FILE_TRANSFER_LIMITS } from '@cloud-work/protocol';
import { FileProxyError, proxyFileTransfer } from './file-transfer-streams';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function upload(body: ReadableStream<Uint8Array>, extra: RequestInit = {}) {
  const options: RequestInit & { duplex: 'half' } = { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half', ...extra };
  return new Request('http://browser.test/files/uploads/batch?path=file.bin', options);
}
function proxyStatus(status: number) {
  return (error: unknown) => error instanceof FileProxyError && error.status === status;
}

test('Web upload forwards bytes before request completion with manager authority only', { timeout: 10_000 }, async () => {
  const first = deferred();
  let received = '', source!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = createServer(async (request, response) => {
    assert.equal(request.method, 'PUT');
    assert.equal(request.headers.authorization, 'Bearer manager-test-secret');
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['content-type'], 'application/octet-stream');
    for await (const chunk of request) { received += chunk; first.resolve(); }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ path: 'file.bin', size: received.length }));
  });
  const address = await listen(upstream);
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  try {
    const pending = proxyFileTransfer(upload(body, { headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer browser-input', cookie: 'session=private' } }), address + '/upload', 'manager-test-secret');
    source.enqueue(new TextEncoder().encode('first'));
    await first.promise;
    assert.equal(received, 'first');
    source.enqueue(new TextEncoder().encode('second'));
    source.close();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: 'file.bin', size: 11 });
    assert.equal(body.locked, false);
  } finally { await close(upstream); }
});

test('Web downloads stream incrementally and expose only safe response headers', { timeout: 10_000 }, async () => {
  const finishBody = deferred();
  const upstream = createServer(async (request, response) => {
    assert.equal(request.headers.range, 'bytes=0-5');
    assert.equal(request.headers['if-range'], '"file-version"');
    assert.equal(request.headers['if-none-match'], '"previous-version"');
    response.writeHead(206, {
      'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.bin"',
      'content-length': '6', 'content-range': 'bytes 0-5/100', 'accept-ranges': 'bytes', etag: '"file-version"',
      'last-modified': 'Mon, 21 Sep 2026 00:00:00 GMT', 'cache-control': 'public, max-age=3600',
      'set-cookie': 'runtime=secret', 'x-runtime-private': 'secret',
    });
    response.write('abc');
    await finishBody.promise;
    response.end('def');
  });
  const address = await listen(upstream);
  try {
    const request = new Request('http://browser.test/download', { headers: { range: 'bytes=0-5', 'if-range': '"file-version"', 'if-none-match': '"previous-version"' } });
    const response = await proxyFileTransfer(request, address, 'manager-test-secret');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-5/100');
    assert.equal(response.headers.get('content-length'), '6');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="report.bin"');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('etag'), '"file-version"');
    assert.equal(response.headers.get('last-modified'), 'Mon, 21 Sep 2026 00:00:00 GMT');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('x-runtime-private'), null);
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'abc');
    finishBody.resolve();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'def');
    assert.equal((await reader.read()).done, true);
  } finally { finishBody.resolve(); await close(upstream); }
});

test('cancelling a Web response terminates its still-streaming manager request', { timeout: 10_000 }, async () => {
  const disconnected = deferred();
  const upstream = createServer((_request, response) => {
    response.on('close', () => disconnected.resolve());
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write('first');
  });
  const address = await listen(upstream);
  try {
    const response = await proxyFileTransfer(new Request('http://browser.test/download'), address, 'manager-test-secret');
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('User cancelled');
    await disconnected.promise;
  } finally { await close(upstream); }
});

test('browser abort after manager headers interrupts a pending response read', { timeout: 10_000 }, async () => {
  const disconnected = deferred();
  const upstream = createServer((_request, response) => {
    response.on('close', () => disconnected.resolve());
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write('first');
  });
  const address = await listen(upstream), controller = new AbortController();
  try {
    const response = await proxyFileTransfer(new Request('http://browser.test/download', { signal: controller.signal }), address, 'manager-test-secret');
    const reader = response.body!.getReader();
    await reader.read();
    const pending = reader.read();
    controller.abort(new Error('Browser disconnected'));
    await assert.rejects(pending, /Browser disconnected/);
    await disconnected.promise;
  } finally { await close(upstream); }
});

test('early manager conflict releases a stalled upload reader without cancelling the browser body', { timeout: 10_000 }, async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>, cancelled = false;
  const upstream = createServer((request, response) => {
    request.once('data', () => {
      response.writeHead(409, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error: 'File already exists' }));
    });
  });
  const address = await listen(upstream);
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel() { cancelled = true; } });
  try {
    const pending = proxyFileTransfer(upload(body), address, 'manager-test-secret');
    source.enqueue(Uint8Array.of(1));
    await assert.rejects(pending, (error: unknown) => proxyStatus(409)(error) && (error as Error).message === 'File already exists');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cancelled, false, 'The body must stay writable to return the error to the browser');
    assert.equal(body.locked, false, 'The stalled upstream upload must release its source reader');
  } finally { source.close(); await close(upstream); }
});

test('upload cancellation releases the source reader even when no next chunk arrives', { timeout: 10_000 }, async () => {
  const first = deferred(), disconnected = deferred(), controller = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = createServer(request => {
    request.on('data', () => first.resolve());
    request.on('close', () => disconnected.resolve());
  });
  const address = await listen(upstream);
  const body = new ReadableStream<Uint8Array>({ start(output) { source = output; } });
  try {
    const pending = proxyFileTransfer(upload(body, { signal: controller.signal }), address, 'manager-test-secret');
    source.enqueue(Uint8Array.of(1));
    await first.promise;
    controller.abort();
    await assert.rejects(pending, proxyStatus(499));
    await disconnected.promise;
    assert.equal(body.locked, false);
  } finally { source.close(); await close(upstream); }
});

test('upload rejects oversized declared lengths and excessive streamed bytes without a length', { timeout: 10_000 }, async () => {
  let received = 0, requests = 0;
  const upstream = createServer(request => {
    requests++;
    request.on('data', chunk => { received += chunk.byteLength; });
  });
  const address = await listen(upstream);
  try {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    await assert.rejects(proxyFileTransfer(upload(body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(FILE_TRANSFER_LIMITS.maxFileBytes + 1) } }), address, 'manager-test-secret'), proxyStatus(413));
    assert.equal(requests, 0);
    const oversized = new ReadableStream<Uint8Array>({ start(controller) {
      // One oversized chunk exercises the streaming counter without transferring
      // 100 MiB across the loopback interface or allocating a second copy.
      controller.enqueue(new Uint8Array(FILE_TRANSFER_LIMITS.maxFileBytes + 1));
      controller.close();
    } });
    await assert.rejects(proxyFileTransfer(upload(oversized), address, 'manager-test-secret'), proxyStatus(413));
    assert.equal(oversized.locked, false);
    assert.equal(received, 0);
  } finally { await close(upstream); }
});

test('public transfer failures bound upstream errors and avoid exposing arbitrary bodies', { timeout: 10_000 }, async () => {
  const upstream = createServer((request, response) => {
    if (request.url === '/structured') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'File not found' }));
    } else if (request.url === '/long') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'secret'.repeat(2000) }));
    } else {
      response.writeHead(500, { 'content-type': 'text/html' });
      response.end('<html>upstream stack trace</html>');
    }
  });
  const address = await listen(upstream);
  try {
    await assert.rejects(proxyFileTransfer(new Request('http://browser.test/download'), address + '/structured', 'token'), (error: unknown) => proxyStatus(404)(error) && (error as Error).message === 'File not found');
    for (const [path, status] of [['/long', 400], ['/html', 503]] as const) {
      await assert.rejects(proxyFileTransfer(new Request('http://browser.test/download'), address + path, 'token'), (error: unknown) => proxyStatus(status)(error) && (error as Error).message === 'File transfer could not be completed');
    }
  } finally { await close(upstream); }
});
