import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { Zip, ZipPassThrough } from 'fflate';
import { FILE_TRANSFER_LIMITS } from '@cloud-work/protocol';
import { relativeParts, withWorkspaceDirectory, withWorkspaceParent } from './index.ts';

const CHUNK_BYTES = 64 * 1024;
const MAX_BATCHES = 16;
const MAX_CONCURRENT_FILES = 4;
export class FileTransferError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export type UploadManifest = { files: { path: string; size: number }[]; directories?: string[] };
export type UploadConflict = 'error' | 'replace' | 'rename';
export type DownloadMetadata = { filename: string; contentType: string; size?: number; inline: boolean };

/** Transfer paths have one spelling, so aliases cannot evade manifest accounting. */
function transferPath(value: unknown, allowRoot = false): string {
  if (typeof value !== 'string') throw new FileTransferError('File path must be a string');
  const parts = relativeParts(value, allowRoot);
  if (parts.join('/') !== value || /[\x00-\x1f\x7f]/.test(value) || parts.length > 64 || parts.some(part => Buffer.byteLength(part) > 255)) {
    throw new FileTransferError('File path must be canonical, without control characters, and at most 64 levels deep');
  }
  return value;
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FileTransferError('Transfer cancelled', 499);
}
async function ensureDirectory(root: string, relative: string): Promise<void> {
  const parts = relativeParts(relative, true);
  for (let index = 0; index < parts.length; index++) {
    await withWorkspaceDirectory(root, parts.slice(0, index), async parent => {
      await mkdir(path.join(parent, parts[index]), { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    });
  }
  await withWorkspaceDirectory(root, parts, async () => {}); // Reject an existing symlink, including the final component.
}
function parseManifest(value: unknown): { files: Map<string, number>; directories: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FileTransferError('Expected an upload manifest');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'files' && key !== 'directories') || !Array.isArray(input.files) ||
      (input.directories !== undefined && !Array.isArray(input.directories))) throw new FileTransferError('Invalid upload manifest');
  const dirs = input.directories as unknown[] | undefined ?? [];
  if (input.files.length + dirs.length > FILE_TRANSFER_LIMITS.maxEntries) throw new FileTransferError('Upload contains more than 5000 entries', 413);
  const files = new Map<string, number>();
  const directories = new Set<string>();
  let total = 0;
  for (const item of input.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => key !== 'path' && key !== 'size')) throw new FileTransferError('Invalid upload file');
    const relative = transferPath(item.path);
    if (files.has(relative)) throw new FileTransferError('Duplicate upload path');
    if (!Number.isSafeInteger(item.size) || item.size < 0) throw new FileTransferError('File size must be a non-negative integer');
    if (item.size > FILE_TRANSFER_LIMITS.maxFileBytes) throw new FileTransferError('Each upload file must be at most 100 MiB', 413);
    total += item.size;
    if (total > FILE_TRANSFER_LIMITS.maxBatchBytes) throw new FileTransferError('Upload batch exceeds 1 GiB', 413);
    files.set(relative, item.size);
  }
  for (const dir of dirs) {
    const relative = transferPath(dir);
    if (directories.has(relative)) throw new FileTransferError('Duplicate directory path');
    directories.add(relative);
  }
  for (const entry of [...files.keys(), ...directories]) {
    const parts = entry.split('/');
    for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join('/'));
  }
  if (files.size + directories.size === 0) throw new FileTransferError('Upload manifest is empty');
  if (files.size + directories.size > FILE_TRANSFER_LIMITS.maxEntries) throw new FileTransferError('Upload contains more than 5000 entries including directories', 413);
  if ([...directories].some(dir => files.has(dir))) throw new FileTransferError('A path cannot be both a file and a directory');
  return { files, directories: [...directories].sort((a, b) => a.split('/').length - b.split('/').length) };
}
type Batch = {
  root: string; expiresAt: number; files: Map<string, number>; completed: Set<string>;
  controller: AbortController; active: Map<string, Promise<{ path: string; size: number }>>;
};

/** The registry is per Runtime; root identity prevents cross-workspace batch reuse. */
export class UploadBatchStore {
  private readonly batches = new Map<string, Batch>();
  private readonly timer = setInterval(() => { void this.expire(); }, 30_000).unref();
  constructor(private readonly timeoutMs = FILE_TRANSFER_LIMITS.timeoutMs) {}
  get activeBatchCount(): number { return this.batches.size; }
  private async expire(): Promise<void> {
    await Promise.allSettled([...this.batches].filter(([, batch]) => batch.expiresAt <= Date.now()).map(([id, batch]) => this.cancel(batch.root, id)));
  }
  async create(root: string, manifest: unknown, signal?: AbortSignal): Promise<{ id: string }> {
    await this.expire();
    if (this.batches.size >= MAX_BATCHES) throw new FileTransferError('Too many active upload batches; cancel an existing upload first', 429);
    const parsed = parseManifest(manifest);
    const batch: Batch = { root, expiresAt: Date.now() + this.timeoutMs, files: parsed.files, completed: new Set(), controller: new AbortController(), active: new Map() };
    const id = `upload_${randomUUID()}`;
    // Reserve synchronously before any filesystem await so concurrent creates cannot exceed the cap.
    this.batches.set(id, batch);
    try {
      await withWorkspaceDirectory(root, [], async () => {});
      for (const dir of parsed.directories) { aborted(signal); aborted(batch.controller.signal); await ensureDirectory(root, dir); }
      aborted(signal);
      return { id };
    } catch (error) { this.batches.delete(id); batch.controller.abort(); throw error; }
  }
  private get(root: string, id: string): Batch {
    const batch = this.batches.get(id);
    if (!batch || batch.root !== root || batch.controller.signal.aborted) throw new FileTransferError('Upload batch not found', 404);
    if (batch.expiresAt <= Date.now()) { void this.cancel(root, id); throw new FileTransferError('Upload batch expired', 410); }
    return batch;
  }
  write(root: string, id: string, relative: string, source: Readable, conflict: UploadConflict = 'error', signal?: AbortSignal, onBytes?: (bytes: number) => void): Promise<{ path: string; size: number }> {
    const batch = this.get(root, id);
    transferPath(relative);
    if (!['error', 'replace', 'rename'].includes(conflict)) throw new FileTransferError('Invalid conflict policy');
    const size = batch.files.get(relative);
    if (size === undefined) throw new FileTransferError('File is not in the upload manifest');
    if (batch.completed.has(relative)) throw new FileTransferError('File has already completed', 409);
    if (batch.active.has(relative)) throw new FileTransferError('File is already uploading', 409);
    if (batch.active.size >= MAX_CONCURRENT_FILES) throw new FileTransferError('Too many parallel file uploads', 429);
    const combined = signal ? AbortSignal.any([signal, batch.controller.signal]) : batch.controller.signal;
    const touch = () => { batch.expiresAt = Date.now() + this.timeoutMs; };
    touch();
    const operation = this.writeAtomic(root, relative, source, size, conflict, combined, touch, onBytes).then(result => {
      batch.completed.add(relative);
      return result;
    }).finally(() => { batch.active.delete(relative); });
    batch.active.set(relative, operation);
    return operation;
  }
  private async writeAtomic(root: string, relative: string, source: Readable, expected: number, conflict: UploadConflict, signal: AbortSignal, touch: () => void, onBytes?: (bytes: number) => void): Promise<{ path: string; size: number }> {
    aborted(signal);
    await ensureDirectory(root, relative.split('/').slice(0, -1).join('/'));
    return withWorkspaceParent(root, relative, async target => {
      await checkDestination(target, conflict);
      const temp = path.join(path.dirname(target), `.cloud-work-upload-${randomUUID()}.part`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const stop = () => { source.destroy(); };
      source.on('error', ignoreSourceError);
      signal.addEventListener('abort', stop, { once: true });
      try {
        aborted(signal);
        let received = 0;
        // Avoid destroying an HTTP socket when a bounded validation error needs a JSON response.
        for await (const chunk of source.iterator({ destroyOnReturn: false })) {
          aborted(signal);
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += bytes.length;
          onBytes?.(bytes.length);
          if (received > expected || received > FILE_TRANSFER_LIMITS.maxFileBytes) throw new FileTransferError('Upload body exceeds its declared size', 413);
          let offset = 0;
          while (offset < bytes.length) {
            aborted(signal);
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
            if (!bytesWritten) throw new FileTransferError('Could not write upload');
            offset += bytesWritten;
          }
          touch();
        }
        aborted(signal);
        if (received !== expected) throw new FileTransferError('Upload body does not match its declared size');
        await handle.sync();
        aborted(signal);
        // Linking is an atomic no-clobber publication; replace uses rename on the pinned parent.
        const published = await publish(temp, target, conflict);
        const parentParts = relative.split('/').slice(0, -1);
        return { path: [...parentParts, path.basename(published)].join('/'), size: received };
      } finally {
        signal.removeEventListener('abort', stop);
        source.removeListener('error', ignoreSourceError);
        await handle.close();
        await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      }
    });
  }
  async cancel(root: string, id: string): Promise<void> {
    const batch = this.batches.get(id);
    if (!batch || batch.root !== root) throw new FileTransferError('Upload batch not found', 404);
    this.batches.delete(id);
    batch.controller.abort();
    await Promise.allSettled(batch.active.values());
  }
  async cancelWorkspace(root: string): Promise<void> {
    await Promise.allSettled([...this.batches].filter(([, batch]) => batch.root === root).map(([id]) => this.cancel(root, id)));
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    await Promise.allSettled([...this.batches].map(([id, batch]) => this.cancel(batch.root, id)));
  }
}
function ignoreSourceError(): void {}
async function checkDestination(target: string, conflict: UploadConflict): Promise<void> {
  let stat: Stats;
  try { stat = await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (conflict === 'error') throw new FileTransferError('Destination already exists', 409);
  if (conflict === 'replace' && !stat.isFile()) throw new FileTransferError('Only an existing regular file can be replaced', 409);
}
async function publish(temp: string, target: string, conflict: UploadConflict): Promise<string> {
  if (conflict === 'replace') { await checkDestination(target, conflict); await rename(temp, target); return target; }
  for (let suffix = 0; suffix <= FILE_TRANSFER_LIMITS.maxEntries; suffix++) {
    const extension = path.extname(target);
    const base = path.basename(target, extension);
    const candidate = suffix ? path.join(path.dirname(target), `${base} (${suffix})${extension}`) : target;
    if (Buffer.byteLength(path.basename(candidate)) > 255) throw new FileTransferError('Renamed filename would exceed 255 bytes');
    try { await link(temp, candidate); return candidate; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (conflict !== 'rename') throw new FileTransferError('Destination already exists', 409);
    }
  }
  throw new FileTransferError('Could not find an unused filename', 409);
}

async function writeChunk(output: Writable, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  aborted(signal);
  if (output.destroyed) throw new FileTransferError('Download disconnected', 499);
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error | null) => {
      output.off('error', onError); output.off('close', onClose); signal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new FileTransferError('Download disconnected', 499));
    const onAbort = () => finish(new FileTransferError('Transfer cancelled', 499));
    output.once('error', onError); output.once('close', onClose); signal?.addEventListener('abort', onAbort, { once: true });
    output.write(bytes, finish); // Await each callback, bounding buffering even for slow clients.
  });
}
async function readChunks(handle: FileHandle, size: number, consume: (bytes: Uint8Array) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let offset = 0;
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  while (offset < size) {
    aborted(signal);
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new FileTransferError('File changed during download', 409);
    offset += bytesRead;
    await consume(buffer.subarray(0, bytesRead));
  }
}
function safeImageType(prefix: Buffer): string | undefined {
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(prefix.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}
function unchanged(initial: Stats, current: Stats): boolean {
  return current.isFile() && initial.dev === current.dev && initial.ino === current.ino && initial.size === current.size && initial.mtimeMs === current.mtimeMs;
}
type ArchiveEntry = { relative: string; archivePath: string; stat: Stats; directory: boolean };
async function scanArchive(root: string, relative: string, signal?: AbortSignal): Promise<ArchiveEntry[]> {
  const result: ArchiveEntry[] = [];
  let size = 0;
  const base = relative ? path.posix.basename(relative) : path.basename(root);
  transferPath(base);
  async function visit(current: string, archivePath: string): Promise<void> {
    aborted(signal);
    transferPath(current, true);
    await withWorkspaceDirectory(root, relativeParts(current, true), async dir => {
      // opendir is incremental; a huge directory cannot allocate an unbounded names array.
      const handle = await opendir(dir);
      for await (const entry of handle) {
        aborted(signal);
        const child = current ? `${current}/${entry.name}` : entry.name;
        transferPath(child);
        const stat = await lstat(path.join(dir, entry.name));
        if (!stat.isFile() && !stat.isDirectory()) throw new FileTransferError('Archives cannot contain symlinks or special files');
        if (result.length >= FILE_TRANSFER_LIMITS.maxEntries) throw new FileTransferError('Archive contains more than 5000 entries', 413);
        if (stat.isFile()) { size += stat.size; if (size > FILE_TRANSFER_LIMITS.maxBatchBytes) throw new FileTransferError('Archive exceeds 1 GiB', 413); }
        const item = { relative: child, archivePath: `${archivePath}/${entry.name}`, stat, directory: stat.isDirectory() };
        result.push(item);
        if (item.directory) await visit(child, item.archivePath);
      }
    });
  }
  // Include the selected directory itself so downloading an empty folder preserves it.
  const stat = await withWorkspaceDirectory(root, relativeParts(relative, true), dir => lstat(dir));
  result.push({ relative, archivePath: base, stat, directory: true });
  await visit(relative, base);
  return result;
}

/** Metadata is emitted only after validation. Errors after output starts must terminate the response. */
export async function downloadWorkspace(root: string, relative: string, options: { archive?: boolean; inline?: boolean }, output: Writable, metadata: (info: DownloadMetadata) => void, signal?: AbortSignal): Promise<void> {
  transferPath(relative, Boolean(options.archive));
  aborted(signal);
  if (!options.archive) {
    await withWorkspaceParent(root, relative, async target => {
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new FileTransferError('Only regular files can be downloaded');
        let contentType = 'application/octet-stream';
        if (options.inline) {
          if (stat.size > FILE_TRANSFER_LIMITS.maxImagePreviewBytes) throw new FileTransferError('Image preview exceeds 20 MiB', 413);
          const prefix = Buffer.alloc(16);
          const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
          const type = safeImageType(prefix.subarray(0, bytesRead));
          if (!type) throw new FileTransferError('Only PNG, JPEG, GIF and WebP images can be previewed', 415);
          contentType = type;
        }
        metadata({ filename: path.posix.basename(relative), contentType, size: stat.size, inline: Boolean(options.inline) });
        await readChunks(handle, stat.size, bytes => writeChunk(output, bytes, signal), signal);
        if (!unchanged(stat, await handle.stat())) throw new FileTransferError('File changed during download', 409);
      } finally { await handle.close(); }
    });
    return;
  }
  if (options.inline) throw new FileTransferError('Archives cannot be previewed');
  const entries = await scanArchive(root, relative, signal);
  aborted(signal);
  metadata({ filename: `${relative ? path.posix.basename(relative) : path.basename(root)}.zip`, contentType: 'application/zip', inline: false });
  let pending: Uint8Array[] = [];
  let zipError: Error | undefined;
  const zip = new Zip((error, chunk) => { if (error) zipError = error; else pending.push(chunk); });
  async function flush(): Promise<void> {
    if (zipError) throw zipError;
    const chunks = pending; pending = [];
    for (const chunk of chunks) await writeChunk(output, chunk, signal);
  }
  let actualBytes = 0;
  try {
    for (const item of entries) {
      aborted(signal);
      const entry = new ZipPassThrough(`${item.archivePath}${item.directory ? '/' : ''}`);
      entry.os = 3;
      entry.attrs = item.directory ? (0o40700 << 16) | 16 : 0o100600 << 16;
      zip.add(entry);
      await flush();
      if (item.directory) {
        // Re-open directories too; a swap after preflight must not silently produce a partial archive.
        await withWorkspaceDirectory(root, relativeParts(item.relative, true), async () => {});
      } else {
        await withWorkspaceParent(root, item.relative, async target => {
          const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            if (!unchanged(item.stat, await handle.stat())) throw new FileTransferError('File changed while preparing archive', 409);
            await readChunks(handle, item.stat.size, async bytes => {
              actualBytes += bytes.length;
              if (actualBytes > FILE_TRANSFER_LIMITS.maxBatchBytes) throw new FileTransferError('Archive exceeds 1 GiB', 413);
              entry.push(bytes, false);
              await flush();
            }, signal);
            if (!unchanged(item.stat, await handle.stat())) throw new FileTransferError('File changed during archive download', 409);
          } finally { await handle.close(); }
        });
      }
      entry.push(new Uint8Array(0), true);
      await flush();
    }
    zip.end();
    await flush();
  } finally { zip.terminate(); }
}
