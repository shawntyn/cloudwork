import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, realpath, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileTransferError } from '../packages/workspace/src/index.ts';
import { WorkspaceFileTransfers } from '../docker/runtime/src/file-transfer.ts';

async function fixture(fn: (url: string, root: string, transfers: WorkspaceFileTransfers) => Promise<void>, timeoutMs?: number) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cloud-work-http-transfer-')));
  const root = path.join(base, 'workspace'); await mkdir(root);
  const transfers = new WorkspaceFileTransfers(timeoutMs);
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://runtime');
      const handled = await transfers.handle(req, res, root, url.pathname.split('/').filter(Boolean), url);
      if (!handled) { res.writeHead(404); res.end(); }
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      if (!req.complete) res.setHeader('connection', 'close');
      res.writeHead(error instanceof FileTransferError ? error.status : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await fn(`http://127.0.0.1:${address.port}/workspaces/ws_test/files`, root, transfers); }
  finally { await transfers.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(base, { recursive: true, force: true }); }
}
async function create(url: string, files: { path: string; size: number }[], directories: string[] = []) {
  const response = await fetch(`${url}/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files, directories }) });
  assert.equal(response.status, 200); return await response.json() as { id: string };
}

test('Runtime HTTP upload/download streams binary and sends safe original attachment headers', async () => fixture(async url => {
  const name = '文件.dat'; const bytes = Buffer.from([0, 1, 2, 255, 254, 13, 10]);
  const { id } = await create(url, [{ path: name, size: bytes.length }], ['empty']);
  const upload = await fetch(`${url}/uploads/${id}?path=${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  assert.equal(upload.status, 200); assert.deepEqual(await upload.json(), { path: name, size: bytes.length });
  const download = await fetch(`${url}/download?path=${encodeURIComponent(name)}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('content-length'), String(bytes.length));
  assert.equal(download.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const archive = await fetch(`${url}/download?path=&archive=1`);
  assert.equal(archive.status, 200); assert.equal(archive.headers.get('content-type'), 'application/zip');
  assert.equal(archive.headers.get('content-length'), null);
  assert.equal(archive.headers.get('transfer-encoding'), 'chunked');
  assert.ok((await archive.arrayBuffer()).byteLength > bytes.length);
  const cancelled = await fetch(`${url}/uploads/${id}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200); assert.deepEqual(await cancelled.json(), { ok: true });
}));

test('Runtime HTTP enforces MIME type, declared bytes, conflicts and manifest membership', async () => fixture(async (url, root) => {
  const { id } = await create(url, [{ path: 'file', size: 3 }]);
  const target = `${url}/uploads/${id}?path=file`;
  assert.equal((await fetch(target, { method: 'PUT', body: 'abc' })).status, 415);
  assert.equal((await fetch(target, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'long' })).status, 413);
  assert.deepEqual(await readdir(root), []);
  assert.equal((await fetch(target, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'ab' })).status, 400);
  assert.equal((await fetch(target, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'abc' })).status, 200);
  const second = await create(url, [{ path: 'file', size: 3 }]);
  assert.equal((await fetch(`${url}/uploads/${second.id}?path=file`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'new' })).status, 409);
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'abc');
  assert.equal((await fetch(`${url}/uploads/${second.id}?path=unlisted`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'new' })).status, 400);
}));

test('client disconnect cancels an unfinished Runtime upload and removes temporary bytes', async () => fixture(async (url, root, transfers) => {
  const { id } = await create(url, [{ path: 'unfinished', size: 10_000_000 }]);
  const req = request(`${url}/uploads/${id}?path=unfinished`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' } });
  req.on('error', () => {});
  req.write(Buffer.alloc(100_000, 9));
  for (let count = 0; count < 100 && !(await readdir(root)).some(name => name.endsWith('.part')); count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok((await readdir(root)).some(name => name.endsWith('.part')));
  req.destroy();
  await transfers.cancelWorkspace(root);
  assert.deepEqual(await readdir(root), []);
}));

test('workspace cancellation closes a manifest request that has not finished sending', async () => fixture(async (url, root, transfers) => {
  const req = request(`${url}/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {}); req.write('{"files":');
  await new Promise(resolve => setTimeout(resolve, 20));
  await transfers.cancelWorkspace(root);
  req.destroy();
  assert.deepEqual(await readdir(root), []);
}));


test('8 MiB early upload errors drain the body before returning stable 409, 404, 415 and 413 JSON', async () => fixture(async (url, root) => {
  await writeFile(path.join(root, 'existing'), 'keep original');
  const size = 8 * 1024 * 1024;
  const batch = await create(url, [{ path: 'existing', size }, { path: 'short', size: 1 }]);
  const cases = [
    { target: `${url}/uploads/${batch.id}?path=existing`, type: 'application/octet-stream', status: 409 },
    { target: `${url}/uploads/upload_missing?path=existing`, type: 'application/octet-stream', status: 404 },
    { target: `${url}/uploads/${batch.id}?path=existing`, type: 'text/plain', status: 415 },
    { target: `${url}/uploads/${batch.id}?path=short`, type: 'application/octet-stream', status: 413 },
  ];
  for (const example of cases) {
    let generated = 0;
    const stream = Readable.from((async function* () {
      while (generated < size) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, size - generated), 42);
        generated += chunk.length; yield chunk;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    })());
    const response = await fetch(example.target, {
      method: 'PUT', headers: { 'content-type': example.type, 'content-length': String(size) },
      body: stream as unknown as BodyInit, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    assert.equal(response.status, example.status);
    assert.equal(generated, size);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(await readFile(path.join(root, 'existing'), 'utf8'), 'keep original');
  assert.deepEqual(await readdir(root), ['existing']);
}));

test('a rejected upload with a stalled body remains protected by the absolute transfer deadline', async () => fixture(async (url, root) => {
  await writeFile(path.join(root, 'existing'), 'original');
  const batch = await create(url, [{ path: 'existing', size: 100_000 }]);
  let responded = false;
  const req = request(`${url}/uploads/${batch.id}?path=existing`, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': '100000' },
  }, response => { responded = true; response.resume(); });
  req.on('error', () => {});
  const closed = new Promise<void>(resolve => req.once('close', resolve));
  req.write(Buffer.alloc(100));
  await Promise.race([
    closed,
    new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Rejected upload drain did not time out')), 2000); timer.unref(); }),
  ]);
  assert.equal(responded, false);
  assert.equal(await readFile(path.join(root, 'existing'), 'utf8'), 'original');
}, 100));
