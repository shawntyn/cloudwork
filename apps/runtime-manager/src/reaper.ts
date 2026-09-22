import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { db, runtimeInstances } from '@cloud-work/database';
import type { RuntimeManager } from './lifecycle.js';
import type { Runs } from './runs.js';

export function reaperAction(input: { running: boolean; busy: boolean; lastActiveAt: number; stoppedAt: number | null }, now: number, idleMs: number, removeMs: number): 'stop' | 'remove' | null {
  if (input.busy) return null;
  if (input.running && now - input.lastActiveAt >= idleMs) return 'stop';
  if (!input.running && input.stoppedAt !== null && now - input.stoppedAt >= removeMs) return 'remove';
  return null;
}

export async function startReaper(manager: RuntimeManager, runs: Runs, log: { error: (error: unknown, message?: string) => void }) {
  const connection = new Redis(manager.config.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue('cloud-work-runtime-reaper', { connection });
  const worker = new Worker('cloud-work-runtime-reaper', async () => {
    // A Redis error is deliberately propagated: unknown busy state must never trigger recycling.
    await runs.recoverStale();
    const rows = await db.select().from(runtimeInstances);
    for (const candidate of rows) {
      if (candidate.status === 'REMOVED') continue;
      try { await manager.leases.withUserLock(candidate.userId, async () => {
        await manager.reconcileRuntimeUnlocked(candidate.userId);
        const row = await manager.row(candidate.userId);
        if (!row) return;
        const container = await manager.inspect(row.userId);
        if (!container) { await manager.setStatus(row.userId, 'REMOVED', null); return; }
        const busy = await manager.leases.isBusy(row.userId) || await manager.hasRunningSessions(row.userId) || (container.State.Running && await manager.hasRuntimeActivity(row.userId));
        const action = reaperAction({ running: container.State.Running, busy, lastActiveAt: row.lastActiveAt.getTime(), stoppedAt: row.stoppedAt?.getTime() ?? null }, Date.now(), manager.config.idleMs, manager.config.removeMs);
        if (action === 'stop') await manager.stopUnlocked(row.userId);
        else if (action === 'remove') await manager.removeUnlocked(row.userId);
        else if (!container.State.Running && !row.stoppedAt && row.status !== 'ERROR') await manager.setStatus(row.userId, 'STOPPED', container.Id);
        else if (container.State.Running && !busy && row.status !== 'IDLE' && row.status !== 'ERROR') await manager.setStatus(row.userId, 'IDLE', container.Id);
      }); } catch (error) { log.error(error, `Runtime reconciliation failed for ${candidate.userId}; other users will still be checked`); }
    }
  }, { connection, concurrency: 1 });
  worker.on('error', error => log.error(error, 'Runtime reaper error'));
  worker.on('failed', (_job, error) => log.error(error, 'Runtime reaper job failed safely'));
  await queue.upsertJobScheduler('idle-runtime-sweep', { every: manager.config.reaperMs }, { name: 'sweep', data: {}, opts: { removeOnComplete: 20, removeOnFail: 100 } });
  await queue.add('deployment-reconcile', {}, { removeOnComplete: true, removeOnFail: 100 });
  return async () => { await worker.close(); await queue.close(); await connection.quit(); };
}
