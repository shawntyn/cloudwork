import { and, eq, isNull } from 'drizzle-orm';
import { db, agentSessions, workspaces } from '@cloud-work/database';
import { HttpError, safeId } from './config.js';
import type { RuntimeManager } from './lifecycle.js';
import { ownedWorkspace, workspaceDeleted, workspaceLock } from './runs.js';
import { moveWorkspaceStorage, purgeWorkspaceStorage } from './workspace-trash-storage.js';

export const WORKSPACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The workspace lock serializes trash transitions with runs and file transfers. */
export async function trashWorkspace(manager: RuntimeManager, userId: string, workspaceId: string) {
  const user = safeId(userId), id = safeId(workspaceId);
  return manager.leases.withLock(workspaceLock(id), async () => {
    const workspace = await ownedWorkspace(user, id, true);
    if (workspace.deletedAt) {
      await moveWorkspaceStorage(manager.config.dataRoot, user, id, 'trash');
      return { workspace };
    }
    const running = await db.select({ id: agentSessions.id }).from(agentSessions)
      .where(and(eq(agentSessions.workspaceId, id), eq(agentSessions.status, 'running'))).limit(1);
    if (running.length) throw new HttpError(409, 'Stop active agents before moving this workspace to trash');
    const [updated] = await db.update(workspaces).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workspaces.id, id), eq(workspaces.userId, user), isNull(workspaces.deletedAt))).returning();
    await moveWorkspaceStorage(manager.config.dataRoot, user, id, 'trash');
    return { workspace: updated ?? await ownedWorkspace(user, id, true) };
  });
}

/** Reconcile an existing tombstone without turning a concurrently restored workspace back into Trash. */
export async function reconcileTrashedWorkspace(manager: RuntimeManager, userId: string, workspaceId: string) {
  const user = safeId(userId), id = safeId(workspaceId);
  return manager.leases.withLock(workspaceLock(id), async () => {
    const workspace = await ownedWorkspace(user, id, true);
    if (!workspace.deletedAt) return;
    await moveWorkspaceStorage(manager.config.dataRoot, user, id, 'trash');
  });
}

export async function restoreWorkspace(manager: RuntimeManager, userId: string, workspaceId: string) {
  const user = safeId(userId), id = safeId(workspaceId);
  return manager.leases.withLock(workspaceLock(id), async () => {
    const workspace = await ownedWorkspace(user, id, true);
    if (!workspace.deletedAt) return { workspace };
    if (workspace.purgeStartedAt || Date.now() - workspace.deletedAt.getTime() >= WORKSPACE_RETENTION_MS) throw new HttpError(410, 'Workspace restore period has expired');
    await moveWorkspaceStorage(manager.config.dataRoot, user, id, 'restore');
    await manager.leases.redis.del(workspaceDeleted(id));
    const [updated] = await db.update(workspaces).set({ deletedAt: null, updatedAt: new Date() })
      .where(and(eq(workspaces.id, id), eq(workspaces.userId, user))).returning();
    return { workspace: updated };
  });
}

/** Also used by the scheduled reaper. A missing runtime response is safe to retry. */
export async function purgeWorkspace(manager: RuntimeManager, userId: string, workspaceId: string, confirmName?: string) {
  const user = safeId(userId), id = safeId(workspaceId);
  return manager.leases.withLock(workspaceLock(id), async () => {
    const workspace = await ownedWorkspace(user, id, true);
    if (!workspace.deletedAt) throw new HttpError(409, 'Move this workspace to trash before deleting it permanently');
    if (confirmName !== undefined && confirmName !== workspace.name) throw new HttpError(400, 'Type the workspace name to confirm permanent deletion');
    // Complete any interrupted Trash move before starting irreversible deletion.
    await moveWorkspaceStorage(manager.config.dataRoot, user, id, 'trash');
    // The durable deletedAt marker already blocks all normal workspace operations.
    await manager.leases.redis.set(workspaceDeleted(id), 'deleting', 'EX', 7 * 24 * 3600);
    try {
      const sessionIds = await db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.workspaceId, id));
      if (!workspace.purgeStartedAt) await db.update(workspaces).set({ purgeStartedAt: new Date() })
        .where(and(eq(workspaces.id, id), eq(workspaces.userId, user)));
      await purgeWorkspaceStorage(manager.config.dataRoot, user, id);
      await db.delete(workspaces).where(and(eq(workspaces.id, id), eq(workspaces.userId, user)));
      if (sessionIds.length) await manager.leases.redis.del(...sessionIds.map(session => `session:${session.id}:events`));
      await manager.leases.redis.del(workspaceDeleted(id));
      return { ok: true };
    } catch (error) {
      // Keep the tombstone until a retry or restore explicitly clears it.
      throw error;
    }
  });
}
