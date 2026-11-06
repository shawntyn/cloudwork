import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, realpath, lstat, readdir, mkdir, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { FILE_TRANSFER_LIMITS, type FileEntry } from '@cloud-work/protocol';
import { FileTransferError } from './file-transfer.ts';

export const MAX_FILE_BYTES = FILE_TRANSFER_LIMITS.maxTextBytes;
export function validateId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) throw new Error('Invalid identifier');
  return id;
}
export function workspacePath(id: string): string { return `/home/work/workspaces/${validateId(id)}`; }
export function relativeParts(value: string, allowRoot = false): string[] {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || value.length > 4096) throw new Error('Invalid relative path');
  const parts = value.split('/').filter(p => p !== '' && p !== '.');
  if (parts.some(p => p === '..') || (!allowRoot && !parts.length)) throw new Error('Path must stay inside the workspace');
  return parts;
}

// Hold directory descriptors throughout every operation. On Linux, procfs paths
// pin each parent inode, so another process cannot redirect an ancestor between
// validation and open/rename/delete by swapping it for a symlink.
export async function withWorkspaceDirectory<T>(root: string, parts: string[], fn: (parent: string) => Promise<T>): Promise<T> {
  const handles: FileHandle[] = [];
  try {
    const resolved = await realpath(root);
    if (resolved !== path.resolve(root)) throw new Error('Symlink workspace roots are forbidden');
    let current = root;
    for (const part of ['', ...parts]) {
      if (part) current = path.join(current, part);
      const h = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(h);
      if (process.platform === 'linux') current = `/proc/self/fd/${h.fd}`;
      else {
        const actual = await realpath(current);
        if (actual !== resolved && !actual.startsWith(resolved + path.sep)) throw new Error('Path escapes workspace');
      }
    }
    return await fn(current);
  } finally { await Promise.all(handles.reverse().map(h => h.close())); }
}
export async function withWorkspaceParent<T>(root: string, relative: string, fn: (target: string) => Promise<T>): Promise<T> {
  const parts = relativeParts(relative);
  const name = parts.pop()!;
  return withWorkspaceDirectory(root, parts, dir => fn(path.join(dir, name)));
}
export async function listFiles(root: string, relative = ''): Promise<FileEntry[]> {
  const parts = relativeParts(relative, true);
  return withWorkspaceDirectory(root, parts, async dir => {
    const names = await readdir(dir);
    if (names.length > 10000) throw new Error('Directory contains too many entries');
    const entries = await Promise.all(names.map(async name => {
      const stat = await lstat(path.join(dir, name));
      return { name, path: [...parts, name].join('/'), type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file', size: stat.size, modifiedAt: stat.mtimeMs } as FileEntry;
    }));
    return entries.sort((a,b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
  });
}
export async function searchFiles(root: string, query: string): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  const term = query.trim().toLocaleLowerCase();
  if (!term || term.length > 100) throw new Error('Search query must contain 1–100 characters');
  const entries: FileEntry[] = [];
  const pending = [''];
  let inspected = 0;
  while (pending.length && inspected < 5000 && entries.length < 100) {
    const directory = pending.shift()!;
    const children = await listFiles(root, directory);
    for (const child of children) {
      inspected++;
      if (child.path.toLocaleLowerCase().includes(term)) entries.push(child);
      if (child.type === 'directory') pending.push(child.path);
      if (inspected >= 5000 || entries.length >= 100) break;
    }
  }
  return { entries, truncated: pending.length > 0 || inspected >= 5000 || entries.length >= 100 };
}
function contentVersion(content: Buffer | string): string { return createHash('sha256').update(content).digest('hex'); }
export async function readFileWithVersion(root: string, relative: string): Promise<{ content: string; version: string }> {
  return withWorkspaceParent(root, relative, async target => {
    const h = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await h.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Only regular text files up to 10 MiB are supported');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await h.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_FILE_BYTES) throw new Error('File is too large');
      const content = buffer.subarray(0, length);
      if (content.includes(0)) throw new Error('Binary files cannot be edited');
      try { return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content), version: contentVersion(content) }; }
      catch { throw new Error('Only UTF-8 text files can be edited'); }
    } finally { await h.close(); }
  });
}
export async function readFileContent(root: string, relative: string): Promise<string> {
  return (await readFileWithVersion(root, relative)).content;
}
export async function writeFileContent(root: string, relative: string, content: string, expectedVersion?: string): Promise<string> {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes('\0')) throw new Error('Text content exceeds 10 MiB or contains binary data');
  return withWorkspaceParent(root, relative, async target => {
    const h = await open(target, (expectedVersion === undefined ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDWR) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = await h.stat();
      if (!stat.isFile()) throw new Error('Not a regular file');
      if (expectedVersion !== undefined) {
        if (stat.size > MAX_FILE_BYTES) throw new FileTransferError('File changed since it was opened', 409);
        const current = Buffer.alloc(stat.size);
        let length = 0;
        while (length < current.length) {
          const { bytesRead } = await h.read(current, length, current.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== stat.size || contentVersion(current) !== expectedVersion) throw new FileTransferError('File changed since it was opened', 409);
      }
      await h.truncate(0);
      await h.writeFile(content, 'utf8');
      await h.sync();
      return contentVersion(content);
    } finally { await h.close(); }
  });
}
export async function makeDirectory(root: string, relative: string): Promise<void> {
  await withWorkspaceParent(root, relative, async target => { await mkdir(target, { mode: 0o700 }); });
}
export async function renameEntry(root: string, from: string, to: string): Promise<void> {
  await withWorkspaceParent(root, from, source => withWorkspaceParent(root, to, async target => {
    try { await lstat(target); throw new Error('Destination already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(source, target);
  }));
}
export async function deleteEntry(root: string, relative: string): Promise<void> {
  await withWorkspaceParent(root, relative, async target => { await rm(target, { recursive: true, force: false }); });
}

export * from './file-transfer.ts';
