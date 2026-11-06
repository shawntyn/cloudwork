import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  downloadWorkspace, FileTransferError, UploadBatchStore, type UploadConflict,
} from '@cloud-work/workspace';
import { FILE_TRANSFER_LIMITS } from '@cloud-work/protocol';

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function manifestBody(req: IncomingMessage, signal: AbortSignal, consumed: (bytes: number) => void): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    consumed(bytes.length);
    if (length > 3 * 1024 * 1024) throw new FileTransferError('Upload manifest exceeds 3 MiB', 413);
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Consume a rejected request before proxies receive its JSON error. Early socket close
 * can otherwise replace a useful 409 with a transport failure during a large upload. */
async function drainRejectedBody(req: IncomingMessage, remainingBytes: number, signal: AbortSignal): Promise<void> {
  if (req.destroyed || signal.aborted || req.readableEnded) return;
  if (remainingBytes < 0) { req.destroy(); return; }
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted();
    remainingBytes -= Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    if (remainingBytes < 0) { req.destroy(); return; }
  }
}
function disposition(filename: string, inline: boolean): string {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`;
}
type Transfer = { root: string; controller: AbortController; done: Promise<void> };

/** HTTP lifetimes own cancellation; the filesystem implementation owns all byte/path limits. */
export class WorkspaceFileTransfers {
  private readonly uploads = new UploadBatchStore();
  private readonly active = new Set<Transfer>();
  constructor(private readonly timeoutMs = FILE_TRANSFER_LIMITS.timeoutMs) {}
  get activity() { return { activeTransfers: this.active.size, uploadBatches: this.uploads.activeBatchCount }; }

  async handle(req: IncomingMessage, res: ServerResponse, root: string, segments: string[], url: URL): Promise<boolean> {
    const uploads = segments[3] === 'uploads';
    const download = segments[3] === 'download';
    if (!uploads && !download) return false;
    const method = req.method;
    const create = uploads && segments.length === 4 && method === 'POST';
    const write = uploads && segments.length === 5 && method === 'PUT';
    const cancel = uploads && segments.length === 5 && method === 'DELETE';
    if (!create && !write && !cancel && !(download && segments.length === 4 && method === 'GET')) return false;
    if (this.active.size >= 16) throw new FileTransferError('Too many active file transfers', 429);
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); req.destroy(); res.destroy(); }, this.timeoutMs).unref();
    const stopIO = () => { req.destroy(); };
    controller.signal.addEventListener('abort', stopIO, { once: true });
    const disconnect = () => { if (!res.writableFinished) controller.abort(); };
    const aborted = () => controller.abort();
    req.on('aborted', aborted);
    res.on('close', disconnect);
    req.setTimeout(this.timeoutMs);
    let consumedBytes = 0;
    const consumed = (bytes: number) => { consumedBytes += bytes; };
    const run = async () => {
      if (create) {
        json(res, await this.uploads.create(root, await manifestBody(req, controller.signal, consumed), controller.signal));
      } else if (write) {
        const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/octet-stream') throw new FileTransferError('Uploads require application/octet-stream', 415);
        json(res, await this.uploads.write(root, segments[4], url.searchParams.get('path') ?? '', req, (url.searchParams.get('conflict') ?? 'error') as UploadConflict, controller.signal, consumed));
      } else if (cancel) {
        await this.uploads.cancel(root, segments[4]);
        json(res, { ok: true });
      } else {
        await downloadWorkspace(root, url.searchParams.get('path') ?? '', {
          archive: url.searchParams.get('archive') === '1', inline: url.searchParams.get('inline') === '1',
        }, res, info => {
          const headers: Record<string, string> = {
            'content-type': info.contentType,
            'content-disposition': disposition(info.filename, info.inline),
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
          };
          if (info.size !== undefined) headers['content-length'] = String(info.size);
          res.writeHead(200, headers);
        }, controller.signal);
        res.end();
      }
    };
    const transfer: Transfer = { root, controller, done: Promise.resolve() };
    this.active.add(transfer);
    transfer.done = run().catch(async error => {
      if ((write || create) && !res.headersSent) {
        const cap = write ? FILE_TRANSFER_LIMITS.maxFileBytes : 3 * 1024 * 1024;
        // The same registry entry, abort listeners and absolute deadline protect draining.
        await drainRejectedBody(req, cap - consumedBytes, controller.signal);
      }
      throw error;
    });
    try { await transfer.done; }
    finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', stopIO);
      req.off('aborted', aborted);
      res.off('close', disconnect);
      this.active.delete(transfer);
    }
    return true;
  }
  async cancelWorkspace(root: string): Promise<void> {
    const operations = [...this.active].filter(transfer => transfer.root === root);
    for (const transfer of operations) transfer.controller.abort();
    await this.uploads.cancelWorkspace(root);
    await Promise.allSettled(operations.map(transfer => transfer.done));
  }
  async close(): Promise<void> {
    for (const transfer of this.active) transfer.controller.abort();
    await this.uploads.close();
    await Promise.allSettled([...this.active].map(transfer => transfer.done));
  }
}
