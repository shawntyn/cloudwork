import { lstat, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { deleteEntry, withWorkspaceDirectory } from '@cloud-work/workspace';
import { HttpError, safeId } from './config.js';

async function realDirectory(directory: string) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HttpError(409, 'User data directory must be a real directory');
}

async function workspaceState(target: string): Promise<'directory' | 'missing'> {
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HttpError(409, 'Workspace data must be a real directory');
    return 'directory';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function roots(dataRoot: string, userId: string) {
  if (!path.isAbsolute(dataRoot)) throw new Error('User data root must be absolute');
  const userRoot = path.join(dataRoot, safeId(userId));
  const activeRoot = path.join(userRoot, 'workspaces');
  const trashRoot = path.join(userRoot, 'trash');
  await realDirectory(dataRoot);
  for (const directory of [userRoot, activeRoot, trashRoot]) {
    await mkdir(directory, { recursive: false, mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await realDirectory(directory);
  }
  return { activeRoot, trashRoot };
}

/** Atomic rename between pinned parent directories, both inside one user's data root. */
export async function moveWorkspaceStorage(dataRoot: string, userId: string, workspaceId: string, direction: 'trash' | 'restore') {
  const id = safeId(workspaceId);
  const { activeRoot, trashRoot } = await roots(dataRoot, userId);
  const sourceRoot = direction === 'trash' ? activeRoot : trashRoot;
  const targetRoot = direction === 'trash' ? trashRoot : activeRoot;
  return withWorkspaceDirectory(sourceRoot, [], sourceParent => withWorkspaceDirectory(targetRoot, [], async targetParent => {
    const source = path.join(sourceParent, id), target = path.join(targetParent, id);
    const sourceState = await workspaceState(source), targetState = await workspaceState(target);
    if (sourceState === 'directory' && targetState === 'directory') throw new HttpError(409, 'Workspace exists in both active and trash storage');
    if (sourceState === 'missing') return false;
    await rename(source, target);
    return true;
  }));
}

/** A partial Trash transition is completed before any permanent file removal. */
export async function purgeWorkspaceStorage(dataRoot: string, userId: string, workspaceId: string) {
  const id = safeId(workspaceId);
  await moveWorkspaceStorage(dataRoot, userId, id, 'trash');
  const { trashRoot } = await roots(dataRoot, userId);
  await withWorkspaceDirectory(trashRoot, [], async parent => {
    if (await workspaceState(path.join(parent, id)) === 'directory') await deleteEntry(trashRoot, id);
  });
}
