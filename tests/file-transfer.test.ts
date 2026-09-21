import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink, rename, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { UploadBatchStore, downloadWorkspace, FileTransferError, type DownloadMetadata } from '../packages/workspace/src/index.ts';
import { FILE_TRANSFER_LIMITS } from '../packages/protocol/src/index.ts';
const { unzipSync } = createRequire(new URL('../packages/workspace/package.json', import.meta.url))('fflate') as {
  unzipSync: (input: Uint8Array) => Record<string, Uint8Array>;
};

async function fixture(fn: (root: string, store: UploadBatchStore, base: string) => Promise<void>, timeoutMs?: number) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cloud-work-transfer-')));
  const root = path.join(base, 'workspace');
  await mkdir(root);
  const store = new UploadBatchStore(timeoutMs);
  try { await fn(root, store, base); }
  finally { await store.close(); await rm(base, { recursive: true, force: true }); }
}
async function download(root: string, relative: string, options: { archive?: boolean; inline?: boolean } = {}) {
  const chunks: Buffer[] = [];
  let info: DownloadMetadata | undefined;
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  await downloadWorkspace(root, relative, options, output, metadata => { info = metadata; });
  return { bytes: Buffer.concat(chunks), info: info! };
}
function status(value: number) { return (error: unknown) => error instanceof FileTransferError && error.status === value; }

test('binary uploads preserve nested and empty directories, byte integrity, and streamed ZIP contents', async () => fixture(async (root, store) => {
  const bytes = randomBytes(180_123);
  const { id } = await store.create(root, { files: [{ path: '报告/data.bin', size: bytes.length }, { path: '报告/zero.txt', size: 0 }], directories: ['报告/空文件夹'] });
  const uploaded = await store.write(root, id, '报告/data.bin', Readable.from([bytes.subarray(0, 13), bytes.subarray(13, 90_000), bytes.subarray(90_000)]));
  assert.deepEqual(uploaded, { path: '报告/data.bin', size: bytes.length });
  await store.write(root, id, '报告/zero.txt', Readable.from([]));
  assert.deepEqual(await readFile(path.join(root, uploaded.path)), bytes);
  const original = await download(root, uploaded.path);
  assert.deepEqual(original.bytes, bytes);
  assert.equal(original.info.contentType, 'application/octet-stream');
  assert.equal(original.info.filename, 'data.bin');
  const archived = await download(root, '报告', { archive: true });
  const entries = unzipSync(archived.bytes);
  assert.deepEqual(Object.keys(entries).sort(), ['报告/', '报告/data.bin', '报告/zero.txt', '报告/空文件夹/'].sort());
  assert.deepEqual(Buffer.from(entries['报告/data.bin']), bytes);
  assert.equal(entries['报告/空文件夹/'].length, 0);
  await store.cancel(root, id);
  assert.deepEqual(await readFile(path.join(root, uploaded.path)), bytes); // Cancel never rolls back published files.
}));

test('conflicts never clobber by default, replace is atomic, and rename returns its actual path', async () => fixture(async (root, store) => {
  await writeFile(path.join(root, 'report.csv'), 'original');
  await writeFile(path.join(root, 'report (1).csv'), 'first');
  const { id } = await store.create(root, { files: [{ path: 'report.csv', size: 3 }] });
  await assert.rejects(store.write(root, id, 'report.csv', Readable.from(['new'])), status(409));
  assert.equal(await readFile(path.join(root, 'report.csv'), 'utf8'), 'original');
  assert.deepEqual(await store.write(root, id, 'report.csv', Readable.from(['new']), 'rename'), { path: 'report (2).csv', size: 3 });
  assert.equal(await readFile(path.join(root, 'report.csv'), 'utf8'), 'original');
  assert.throws(() => store.write(root, id, 'report.csv', Readable.from(['new'])), status(409));
  const replace = await store.create(root, { files: [{ path: 'report.csv', size: 8 }] });
  await assert.rejects(store.write(root, replace.id, 'report.csv', Readable.from(['short']), 'replace'));
  assert.equal(await readFile(path.join(root, 'report.csv'), 'utf8'), 'original');
  await store.write(root, replace.id, 'report.csv', Readable.from(['replaced']), 'replace');
  assert.equal(await readFile(path.join(root, 'report.csv'), 'utf8'), 'replaced');
  assert.equal((await readdir(root)).some(name => name.endsWith('.part')), false);
}));

test('concurrent no-clobber publication admits only one writer to a shared destination', async () => fixture(async (root, store) => {
  const left = await store.create(root, { files: [{ path: 'race.bin', size: 3 }] });
  const right = await store.create(root, { files: [{ path: 'race.bin', size: 3 }] });
  const results = await Promise.allSettled([
    store.write(root, left.id, 'race.bin', Readable.from(['one'])),
    store.write(root, right.id, 'race.bin', Readable.from(['two'])),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && status(409)(result.reason)).length, 1);
  assert.ok(['one', 'two'].includes(await readFile(path.join(root, 'race.bin'), 'utf8')));
  assert.deepEqual(await readdir(root), ['race.bin']);
}));

test('manifest accounting bounds declared file sizes, total bytes, directories, aliases and nesting', async () => fixture(async (root, store) => {
  await assert.rejects(store.create(root, { files: [{ path: 'big', size: FILE_TRANSFER_LIMITS.maxFileBytes + 1 }] }), status(413));
  await assert.rejects(store.create(root, { files: Array.from({ length: 11 }, (_, index) => ({ path: `f${index}`, size: FILE_TRANSFER_LIMITS.maxFileBytes })) }), status(413));
  await assert.rejects(store.create(root, { files: [], directories: Array.from({ length: 5001 }, (_, index) => `d${index}`) }), status(413));
  for (const relative of ['../outside', '/absolute', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\nb', 'a/'.repeat(65) + 'b']) {
    await assert.rejects(store.create(root, { files: [{ path: relative, size: 0 }] }));
  }
  await assert.rejects(store.create(root, { files: [{ path: 'a', size: 0 }, { path: 'a', size: 0 }] }));
  await assert.rejects(store.create(root, { files: [{ path: 'a', size: 0 }, { path: 'a/b', size: 0 }] }));
  const { id } = await store.create(root, { files: [{ path: 'bounded', size: 3 }] });
  await assert.rejects(store.write(root, id, 'bounded', Readable.from(['four'])), status(413));
  assert.deepEqual(await readdir(root), []);
  await store.write(root, id, 'bounded', Readable.from(['yes'])); // Failed uploads remain retryable.
}));

test('cancel aborts an in-progress body, cleans staging files, preserves originals and releases the batch', async () => fixture(async (root, store) => {
  await writeFile(path.join(root, 'file'), 'original');
  const { id } = await store.create(root, { files: [{ path: 'file', size: 50 }] });
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const input = new Readable({ read() { this.push(Buffer.from('partial')); start(); this._read = () => {}; } });
  const operation = store.write(root, id, 'file', input, 'replace');
  const rejected = assert.rejects(operation);
  await started;
  await store.cancel(root, id);
  await rejected;
  assert.equal(input.destroyed, true);
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'original');
  assert.deepEqual(await readdir(root), ['file']);
  assert.throws(() => store.write(root, id, 'file', Readable.from([])), status(404));
}));

test('upload batch cannot be used or cancelled from another workspace; active batches and expiry are bounded', async () => fixture(async (root, store, base) => {
  const other = path.join(base, 'other'); await mkdir(other);
  const { id } = await store.create(root, { files: [{ path: 'test', size: 0 }] });
  assert.throws(() => store.write(other, id, 'test', Readable.from([])), status(404));
  await assert.rejects(store.cancel(other, id), status(404));
  for (let index = 1; index < 16; index++) await store.create(root, { files: [{ path: `f${index}`, size: 0 }] });
  await assert.rejects(store.create(root, { files: [{ path: 'excess', size: 0 }] }), status(429));
  await store.cancel(root, id);
  await store.create(root, { files: [{ path: 'released', size: 0 }] });
  const expired = new UploadBatchStore(-1);
  try {
    const batch = await expired.create(root, { files: [{ path: 'expired', size: 0 }] });
    assert.throws(() => expired.write(root, batch.id, 'expired', Readable.from([])), status(410));
  } finally { await expired.close(); }
}));

test('symlink roots, parents, leaves and archive entries cannot escape the workspace', async () => fixture(async (root, store, base) => {
  const outside = path.join(base, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'secret'), 'private');
  await symlink(outside, path.join(root, 'escape'));
  await symlink(path.join(outside, 'secret'), path.join(root, 'secret-link'));
  await assert.rejects(store.create(root, { files: [{ path: 'escape/secret', size: 3 }] }));
  const { id } = await store.create(root, { files: [{ path: 'secret-link', size: 3 }] });
  await assert.rejects(store.write(root, id, 'secret-link', Readable.from(['new']), 'replace'));
  await assert.rejects(download(root, 'escape/secret'));
  await assert.rejects(download(root, 'secret-link'));
  let emitted = false;
  await assert.rejects(downloadWorkspace(root, '', { archive: true }, new Writable({ write(_chunk, _encoding, callback) { emitted = true; callback(); } }), () => { emitted = true; }));
  assert.equal(emitted, false); // Refuse the entire archive before returning successful headers.
  await symlink(root, path.join(base, 'root-link'));
  await assert.rejects(store.create(path.join(base, 'root-link'), { files: [{ path: 'file', size: 0 }] }));
  assert.equal(await readFile(path.join(outside, 'secret'), 'utf8'), 'private');
}));

test('Linux pinned parent descriptors resist a concurrent symlink swap during upload', { skip: process.platform !== 'linux' }, async () => fixture(async (root, store, base) => {
  await mkdir(path.join(root, 'nested')); const outside = path.join(base, 'outside'); await mkdir(outside);
  const { id } = await store.create(root, { files: [{ path: 'nested/file', size: 6 }] });
  const input = Readable.from((async function* () {
    yield Buffer.from('abc');
    await rename(path.join(root, 'nested'), path.join(root, 'moved'));
    await symlink(outside, path.join(root, 'nested'));
    yield Buffer.from('def');
  })());
  await store.write(root, id, 'nested/file', input);
  assert.equal(await readFile(path.join(root, 'moved/file'), 'utf8'), 'abcdef');
  assert.deepEqual(await readdir(outside), []);
}));

test('inline preview uses image bytes, rejects active documents, and bounds preview sizes', async () => fixture(async root => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAZkAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(root, 'picture.bin'), png);
  const preview = await download(root, 'picture.bin', { inline: true });
  assert.equal(preview.info.contentType, 'image/png'); assert.equal(preview.info.inline, true); assert.deepEqual(preview.bytes, png);
  for (const [name, text] of [['fake.png', '<html><script>alert(1)</script>'], ['vector.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'], ['doc.pdf', '%PDF-1.7']]) {
    await writeFile(path.join(root, name), text);
    await assert.rejects(download(root, name, { inline: true }), status(415));
    assert.equal((await download(root, name)).bytes.toString(), text);
  }
  const large = await open(path.join(root, 'large.png'), 'w');
  try { await large.write(png); await large.truncate(FILE_TRANSFER_LIMITS.maxImagePreviewBytes + 1); } finally { await large.close(); }
  await assert.rejects(download(root, 'large.png', { inline: true }), status(413));
}));

test('original downloads exceed upload limits without buffering; archive preflight rejects excess total bytes', async () => fixture(async root => {
  const handle = await open(path.join(root, 'large.bin'), 'w');
  try { await handle.truncate(FILE_TRANSFER_LIMITS.maxBatchBytes + 1); } finally { await handle.close(); }
  let metadata: DownloadMetadata | undefined;
  const controller = new AbortController(); let streamed = 0;
  const output = new Writable({ write(chunk, _encoding, callback) { streamed += chunk.length; controller.abort(); callback(); } });
  await assert.rejects(downloadWorkspace(root, 'large.bin', {}, output, info => { metadata = info; }, controller.signal));
  assert.equal(metadata?.size, FILE_TRANSFER_LIMITS.maxBatchBytes + 1);
  assert.ok(streamed > 0 && streamed <= 64 * 1024);
  await assert.rejects(download(root, '', { archive: true }), status(413));
}));

test('download cancellation releases a backpressured writer promptly', async () => fixture(async root => {
  await writeFile(path.join(root, 'file.bin'), randomBytes(200_000));
  const controller = new AbortController();
  let writing!: () => void; const started = new Promise<void>(resolve => { writing = resolve; });
  const output = new Writable({ write() { writing(); } }); // Never calls callback: simulates a stalled client.
  const result = downloadWorkspace(root, 'file.bin', {}, output, () => {}, controller.signal);
  const rejected = assert.rejects(result, status(499));
  await started; controller.abort(); await rejected;
  output.destroy();
}));
