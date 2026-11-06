import { z } from 'zod';
import { FILE_TRANSFER_LIMITS } from '@cloud-work/protocol';
import { ApiError, body, currentUser, idSchema, ownedWorkspace, rateLimit, validatePath } from './api';
import { FileProxyError, proxyFileTransfer } from './file-transfer-streams';

const manifestSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1).max(4096), size: z.number().int().min(0).max(FILE_TRANSFER_LIMITS.maxFileBytes) }).strict()).max(FILE_TRANSFER_LIMITS.maxEntries),
  directories: z.array(z.string().min(1).max(4096)).max(FILE_TRANSFER_LIMITS.maxEntries).optional(),
}).strict();

export async function fileTransfer(request: Request, operation: 'create' | 'upload' | 'cancel' | 'download'): Promise<Response> {
  const user = await currentUser(request);
  const url = new URL(request.url);
  const workspace = await ownedWorkspace(user.id, url.pathname.split('/')[3]!);
  idSchema.parse(user.id);
  const query = new URLSearchParams();
  let data: unknown;
  let suffix: string;
  if (operation === 'create') {
    await rateLimit(user.id, 'file-upload-batch', 60);
    const manifest = manifestSchema.parse(await body(request));
    for (const entry of manifest.files) validatePath(entry.path);
    for (const entry of manifest.directories ?? []) validatePath(entry);
    if (manifest.files.length + (manifest.directories?.length ?? 0) > FILE_TRANSFER_LIMITS.maxEntries ||
        manifest.files.reduce((total, entry) => total + entry.size, 0) > FILE_TRANSFER_LIMITS.maxBatchBytes) {
      throw new ApiError(413, 'Upload batch exceeds 1 GiB or 5000 entries');
    }
    data = manifest; suffix = '/uploads';
  } else if (operation === 'upload' || operation === 'cancel') {
    const id = idSchema.parse(url.pathname.split('/').at(-1));
    if (!id.startsWith('upload_')) throw new ApiError(400, 'Invalid upload batch');
    suffix = `/uploads/${id}`;
    if (operation === 'upload') {
      const path = url.searchParams.get('path') ?? ''; validatePath(path);
      query.set('path', path);
      query.set('conflict', z.enum(['error', 'replace', 'rename']).parse(url.searchParams.get('conflict') ?? 'error'));
    }
  } else {
    const path = url.searchParams.get('path') ?? '';
    const archive = url.searchParams.get('archive');
    const inline = url.searchParams.get('inline');
    if ((archive !== null && archive !== '1') || (inline !== null && inline !== '1') || (archive && inline)) {
      throw new ApiError(400, 'Invalid download mode');
    }
    validatePath(path, archive === '1');
    query.set('path', path);
    if (archive) query.set('archive', archive);
    if (inline) query.set('inline', inline);
    suffix = '/download';
  }
  const managerUrl = process.env.RUNTIME_MANAGER_URL ?? 'http://localhost:4000';
  try {
    return await proxyFileTransfer(request, `${managerUrl}/internal/users/${user.id}/workspaces/${workspace.id}/files${suffix}?${query}`, process.env.MANAGER_TOKEN ?? '', data);
  } catch (error) {
    if (error instanceof FileProxyError) throw new ApiError(error.status, error.message);
    throw error;
  }
}
