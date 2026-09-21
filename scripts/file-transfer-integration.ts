import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { FILE_TRANSFER_LIMITS as limits } from '../packages/protocol/src/index.ts';

const { unzipSync } = createRequire(new URL('../packages/workspace/package.json', import.meta.url))('fflate') as {
  unzipSync(data: Uint8Array): Record<string, Uint8Array>;
};
const base = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
const results: string[] = [];
const pass = (value: string) => { results.push(value); console.log(`PASS ${value}`); };
const password = `Files-${randomUUID()}`;
async function json(path: string, cookie = '', method = 'GET', data?: unknown, expected = 200) {
  const response = await fetch(base + path, { method, headers: { cookie, origin: base, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
  return { response, value };
}
async function signup(label: string) {
  const email = `file-transfer-${label}-${Date.now()}@example.test`;
  const { response, value } = await json('/api/auth/sign-up/email', '', 'POST', { email, password, name: `File transfer ${label}` });
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  return { email, cookie, id: value.user.id };
}
const owner = await signup('owner');
const other = await signup('other');
const workspace = (await json('/api/workspaces', owner.cookie, 'POST', { name: 'File transfer verification' }, 201)).value.workspace;
const files = `/api/workspaces/${workspace.id}/files`;
await mkdir('.cache', { recursive: true });
await mkdir('artifacts', { recursive: true });
await writeFile('.cache/file-transfer-account.json', JSON.stringify({ email: owner.email, password, workspaceId: workspace.id }), { mode: 0o600 });
const batch = async (entries: { path: string; size: number }[], directories: string[] = []) => (await json(files + '/uploads', owner.cookie, 'POST', { files: entries, directories })).value.id as string;
const cancel = async (id: string) => json(files + `/uploads/${id}`, owner.cookie, 'DELETE');
async function upload(id: string, path: string, source: BodyInit | AsyncIterable<Uint8Array>, conflict = 'error', expected = 200, signal?: AbortSignal) {
  const response = await fetch(`${base}${files}/uploads/${id}?${new URLSearchParams({ path, conflict })}`, {
    method: 'PUT', headers: { cookie: owner.cookie, origin: base, 'content-type': 'application/octet-stream' },
    body: source as BodyInit, duplex: 'half', signal,
  } as RequestInit);
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}
async function download(path: string, mode = '', cookie = owner.cookie, expected = 200) {
  const response = await fetch(`${base}${files}/download?path=${encodeURIComponent(path)}${mode}`, { headers: { cookie } });
  assert.equal(response.status, expected, `${path}: ${response.status}`);
  return response;
}
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
for (const cookie of ['', other.cookie]) {
  const status = cookie ? 404 : 401;
  await json(files + '/uploads', cookie, 'POST', { files: [{ path: 'forbidden', size: 0 }] }, status);
  await download('forbidden', '', cookie, status);
}
const rejectedOrigin = await fetch(base + files + '/uploads', { method: 'POST', headers: { cookie: owner.cookie, origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ path: 'forbidden', size: 0 }] }) });
assert.equal(rejectedOrigin.status, 403);
pass('Authentication, tenant ownership and mutation Origin enforced');

const payload = Buffer.alloc(8 * 1024 * 1024);
for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
const id = await batch([{ path: 'nested/binary.bin', size: payload.length }, { path: 'nested/hello.txt', size: 5 }], ['nested/empty/deeper']);
await upload(id, 'nested/binary.bin', payload);
await upload(id, 'nested/hello.txt', Buffer.from('hello'));
await cancel(id);
const original = await download('nested/binary.bin');
assert.match(original.headers.get('content-disposition') ?? '', /^attachment;/);
assert.equal(original.headers.get('x-content-type-options'), 'nosniff');
assert.equal(digest(new Uint8Array(await original.arrayBuffer())), digest(payload));
const zipResponse = await download('nested', '&archive=1');
const zipBytes = new Uint8Array(await zipResponse.arrayBuffer());
const entries = unzipSync(zipBytes);
assert.equal(digest(entries['nested/binary.bin']!), digest(payload));
assert.equal(Buffer.from(entries['nested/hello.txt']!).toString(), 'hello');
assert.ok(entries['nested/empty/deeper/']);
await writeFile('artifacts/file-transfer-nested.zip', zipBytes);
pass('8 MiB binary integrity and ZIP hierarchy, file bytes and empty directories');

const collision = await batch([{ path: 'nested/hello.txt', size: 3 }]);
await upload(collision, 'nested/hello.txt', Buffer.from('new'), 'error', 409);
assert.equal(await (await download('nested/hello.txt')).text(), 'hello');
const renamed = await upload(collision, 'nested/hello.txt', Buffer.from('new'), 'rename');
assert.equal(renamed.path, 'nested/hello (1).txt');
await cancel(collision);
const replacement = await batch([{ path: 'nested/hello.txt', size: 3 }]);
await upload(replacement, 'nested/hello.txt', Buffer.from('new'), 'replace');
await cancel(replacement);
assert.equal(await (await download('nested/hello.txt')).text(), 'new');
pass('Default collision preserves originals; keep-both and explicit replacement work');

const largeCollision = await batch([{ path: 'nested/binary.bin', size: payload.length }]);
await upload(largeCollision, 'nested/binary.bin', payload, 'error', 409);
await cancel(largeCollision);
assert.equal(digest(new Uint8Array(await (await download('nested/binary.bin')).arrayBuffer())), digest(payload));
pass('8 MiB early conflict remains an HTTP 409 through all three services');

const controller = new AbortController();
const partial = await batch([{ path: 'cancelled.bin', size: payload.length }]);
async function* slowInput() {
  for (let index = 0; index < 128; index++) {
    if (controller.signal.aborted) return;
    yield payload.subarray(0, 65536);
    await delay(15);
    if (index === 8) controller.abort();
  }
}
await assert.rejects(upload(partial, 'cancelled.bin', slowInput(), 'error', 200, controller.signal));
await cancel(partial);
const listing = (await json(files, owner.cookie)).value.entries as { name: string }[];
assert.ok(!listing.some(entry => entry.name === 'cancelled.bin' || entry.name.includes('.cloud-work-upload-')));
pass('Client cancellation removes partial upload and leaves completed files intact');

const invalidSize = await batch([{ path: 'wrong-size', size: 5 }]);
await upload(invalidSize, 'wrong-size', Buffer.from('sixsix'), 'error', 413);
await cancel(invalidSize);
await json(files + '/uploads', owner.cookie, 'POST', { files: [{ path: '../escape', size: 0 }] }, 400);
await json(files + '/uploads', owner.cookie, 'POST', { files: [{ path: 'oversize', size: limits.maxFileBytes + 1 }] }, 400);
await json(files + '/uploads', owner.cookie, 'POST', { files: Array.from({ length: 11 }, (_, index) => ({ path: `huge-${index}`, size: limits.maxFileBytes })) }, 413);
pass('Declared sizes, traversal and per-file/batch limits enforced');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
const imageId = await batch([{ path: 'pixel.png', size: png.length }, { path: 'unsafe.svg', size: 11 }, { path: 'fake.png', size: 6 }]);
await upload(imageId, 'pixel.png', png);
await upload(imageId, 'unsafe.svg', Buffer.from('<svg></svg>'));
await upload(imageId, 'fake.png', Buffer.from('<html>'));
await cancel(imageId);
const image = await download('pixel.png', '&inline=1');
assert.equal(image.headers.get('content-type'), 'image/png');
assert.match(image.headers.get('content-disposition') ?? '', /^inline;/);
assert.equal(digest(new Uint8Array(await image.arrayBuffer())), digest(png));
await download('unsafe.svg', '&inline=1', owner.cookie, 415);
await download('fake.png', '&inline=1', owner.cookie, 415);
pass('Raster preview validates signatures; SVG and misleading extensions stay download-only');

const text = 'x'.repeat(3 * 1024 * 1024);
await json(files + '/content', owner.cookie, 'PUT', { path: 'large-text.txt', content: text });
assert.equal((await json(files + '/content?path=large-text.txt', owner.cookie)).value.content, text);
pass('Text editing accepts files above the previous 2 MiB limit');

// Generate and hash at most one chunk at a time to exercise the real 100 MiB boundary.
const chunk = Buffer.alloc(1024 * 1024, 97);
const hash = createHash('sha256');
const largeId = await batch([{ path: 'limit-100mib.bin', size: limits.maxFileBytes }]);
async function* maximumInput() {
  for (let index = 0; index < 100; index++) { hash.update(chunk); yield chunk; }
}
await upload(largeId, 'limit-100mib.bin', maximumInput());
await cancel(largeId);
const largeResponse = await download('limit-100mib.bin');
const actualHash = createHash('sha256');
let bytes = 0, chunks = 0;
for await (const value of largeResponse.body!) { bytes += value.length; chunks++; actualHash.update(value); }
assert.equal(bytes, limits.maxFileBytes);
assert.ok(chunks > 1);
assert.equal(actualHash.digest('hex'), hash.digest('hex'));
pass('100 MiB streamed upload and download complete with matching SHA-256');

await writeFile('artifacts/file-transfer-integration.json', JSON.stringify({ at: new Date().toISOString(), base, results, workspaceId: workspace.id }, null, 2));
console.log(`Verified ${results.length} file-transfer checks. Disposable accounts/files are retained; report: artifacts/file-transfer-integration.json`);
