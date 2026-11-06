import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, desktopInstances, computerTasks, computerActions, agentMessageRequests, agentSessions, workspaces } from '@cloud-work/database';
import { actionSchema, planSchema, signScope, verifyScope, terminalTask, type Scope, type DesktopView, type ComputerTaskState, type ComputerPlan } from '@cloud-work/computer';
import { HttpError, safeId, managerControlAlias } from './config.js';
import { ownedWorkspace, ownedSession, workspaceLock, type Runs } from './runs.js';
import type { RuntimeManager } from './lifecycle.js';
import { DesktopContainers, desktopNames } from './desktop-containers.js';
import { publish } from './events.js';

type Task = typeof computerTasks.$inferSelect;
const activeStates = ['queued', 'running', 'confirmation'];
export class ComputerService {
  containers: DesktopContainers;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private nextImageCheck = 0;
  readonly enabled = process.env.COMPUTER_ENABLED === 'true';
  constructor(readonly manager: RuntimeManager, private runs: Runs) { this.containers = new DesktopContainers(manager); }
  private lock<T>(id: string, fn: () => Promise<T>) { return this.manager.leases.withLock('desktop:' + safeId(id) + ':control', fn); }
  private requireEnabled() { if (!this.enabled) throw new HttpError(409, 'Computer is not enabled', 'DESKTOP_DISABLED'); }
  async row(workspaceId: string) { return (await db.select().from(desktopInstances).where(eq(desktopInstances.workspaceId, workspaceId)))[0]; }
  async ensure(userId: string, workspaceId: string) {
    return this.manager.leases.withLock(workspaceLock(workspaceId), () => this.ensureActive(userId, workspaceId));
  }
  private async ensureActive(userId: string, workspaceId: string) {
    this.requireEnabled(); await ownedWorkspace(userId, workspaceId);
    await this.manager.withActivity(userId, async () => {
      const response = await this.manager.request(userId, `/workspaces/${workspaceId}`, { method: 'POST' });
      if (!response.ok) throw new HttpError(503, 'Workspace is unavailable'); await response.body?.cancel();
    });
    return this.manager.leases.withLock('desktop:capacity', () => this.lock(workspaceId, async () => {
      await ownedWorkspace(userId, workspaceId);
      const row = await this.row(workspaceId);
      const running = await db.select().from(desktopInstances).where(inArray(desktopInstances.status, ['ready', 'starting']));
      if (!row || !['ready', 'starting'].includes(row.status)) {
        if (running.length >= Number(process.env.DESKTOP_MAX_RUNNING || 8) || running.filter(r => r.userId === userId).length >= Number(process.env.DESKTOP_MAX_PER_USER || 3)) throw new HttpError(429, 'Desktop capacity reached', 'DESKTOP_CAPACITY');
      }
      await db.insert(desktopInstances).values({ workspaceId, userId, status: 'starting' }).onConflictDoUpdate({ target: desktopInstances.workspaceId, set: { status: 'starting', updatedAt: new Date() } });
      try {
        const imageId = await this.containers.ensure(userId, workspaceId, Boolean(row && row.mode !== 'idle'));
        await db.update(desktopInstances).set({ status: 'ready', imageId, errorCode: null, lastActiveAt: new Date(), updatedAt: new Date() }).where(eq(desktopInstances.workspaceId, workspaceId));
      } catch (error) {
        await this.containers.stop(userId, workspaceId).catch(() => {});
        await db.update(desktopInstances).set({ status: 'error', errorCode: 'DESKTOP_UNAVAILABLE', updatedAt: new Date() }).where(eq(desktopInstances.workspaceId, workspaceId)); throw error;
      }
      return this.view(userId, workspaceId);
    }));
  }
  async view(userId: string, workspaceId: string): Promise<DesktopView> {
    await ownedWorkspace(userId, workspaceId); const row = await this.row(workspaceId);
    const [task] = await db.select().from(computerTasks).where(row?.mode === 'ai' && row.owner ? and(eq(computerTasks.workspaceId, workspaceId), eq(computerTasks.id, row.owner)) : eq(computerTasks.workspaceId, workspaceId)).orderBy(desc(computerTasks.createdAt)).limit(1);
    const queued = await db.select({ id: computerTasks.id }).from(computerTasks).where(and(eq(computerTasks.workspaceId, workspaceId), eq(computerTasks.state, 'queued')));
    return { enabled: this.enabled, available: Boolean(process.env.COMPUTER_MODEL), status: row?.status as DesktopView['status'] ?? 'stopped', mode: row?.mode as DesktopView['mode'] ?? 'idle', owner: row?.mode === 'manual' && (row.controlExpiresAt?.getTime() ?? 0) <= Date.now() ? null : row?.owner ?? null, epoch: row?.epoch ?? 0, queued: queued.length,
      task: task ? { id: task.id, sessionId: task.sessionId, goal: task.goal, state: task.state as ComputerTaskState, actionCount: task.actionCount, result: task.result, progress: task.progress, confirmation: task.confirmation as ComputerPlan | null } : null };
  }
  grant(userId: string, workspaceId: string, sessionId: string, runId: string) {
    if (!this.enabled || !process.env.COMPUTER_MODEL) return undefined;
    const scope: Scope = { kind: 'run', userId, workspaceId, sessionId, runId, expires: Date.now() + 24 * 3600000 };
    // Runtime connects on its private user control network; never receives manager credentials.
    return { url: `http://${managerControlAlias(userId)}:4000/computer/mcp`, token: signScope(scope, this.manager.config.tokenSecret) };
  }
  async authorize(token: string, kind?: Scope['kind']) {
    let scope: Scope; try { scope = verifyScope(token, this.manager.config.tokenSecret); } catch { throw new HttpError(401, 'Invalid computer authorization'); }
    if (kind && scope.kind !== kind) throw new HttpError(403, 'Invalid authorization scope');
    await this.parent(scope); return scope;
  }
  async parent(scope: Pick<Scope, 'userId' | 'workspaceId' | 'sessionId' | 'runId'>) {
    await ownedWorkspace(scope.userId, scope.workspaceId);
    const session = await ownedSession(scope.userId, scope.sessionId);
    if (session.workspaceId !== scope.workspaceId) throw new HttpError(403, 'Workspace mismatch');
    const [receipt] = await db.select().from(agentMessageRequests).where(and(eq(agentMessageRequests.sessionId, session.id), eq(agentMessageRequests.runId, scope.runId), eq(agentMessageRequests.status, 'running'))).limit(1);
    if (!receipt || session.status !== 'running') throw new HttpError(409, 'Parent run has ended', 'COMPUTER_PARENT_ENDED');
    // A durable running receipt alone does not prove a manager still owns execution.
    if (!await this.manager.leases.redis.exists(`session:${scope.sessionId}:run-lock`)) throw new HttpError(409, 'Parent run lease was lost', 'COMPUTER_PARENT_ENDED');
    return session;
  }
  async start(scope: Scope, requestId: string, goal: string) {
    this.requireEnabled(); safeId(requestId);
    if (!goal.trim() || goal.length > 16000) throw new HttpError(400, 'Invalid computer goal');
    const session = await this.parent(scope);
    return this.lock(scope.workspaceId, async () => {
      await this.parent(scope);
      const [prior] = await db.select().from(computerTasks).where(and(eq(computerTasks.runId, scope.runId), eq(computerTasks.requestId, requestId)));
      if (prior) { if (prior.goal !== goal.trim()) throw new HttpError(409, 'Task ID reused with different goal', 'IDEMPOTENCY_KEY_CONFLICT'); return this.publicTask(prior); }
      const [stopped] = await db.select({ id: computerTasks.id }).from(computerTasks).where(and(eq(computerTasks.runId, scope.runId), inArray(computerTasks.state, ['cancelled', 'interrupted']))).limit(1);
      if (stopped) throw new HttpError(409, 'Computer task was stopped; a new user message is required', 'COMPUTER_RUN_STOPPED');
      const pending = await db.select({ id: computerTasks.id }).from(computerTasks).where(and(eq(computerTasks.userId, scope.userId), inArray(computerTasks.state, activeStates)));
      if (pending.length >= 20) throw new HttpError(429, 'Computer queue is full', 'COMPUTER_QUEUE_FULL');
      const [task] = await db.insert(computerTasks).values({ id: `ct_${randomUUID()}`, userId: scope.userId, workspaceId: scope.workspaceId, sessionId: session.id, runId: scope.runId, requestId, goal: goal.trim(), deadline: new Date(Date.now() + Number(process.env.COMPUTER_TASK_MINUTES || 30) * 60000) }).returning();
      return this.publicTask(task!);
    });
  }
  private publicTask(task: Task) { return { id: task.id, state: task.state, goal: task.goal, progress: task.progress, result: task.result, confirmation: task.confirmation, actionCount: task.actionCount, inputTokens: task.inputTokens, outputTokens: task.outputTokens }; }
  async task(scope: Scope, id: string) {
    safeId(id); const [task] = await db.select().from(computerTasks).where(and(eq(computerTasks.id, id), eq(computerTasks.userId, scope.userId), eq(computerTasks.workspaceId, scope.workspaceId), eq(computerTasks.runId, scope.runId)));
    if (!task || (scope.kind === 'task' && scope.taskId !== id)) throw new HttpError(404, 'Computer task not found'); return task;
  }
  async status(scope: Scope, id: string) { return this.publicTask(await this.task(scope, id)); }
  async claim(runnerId: string) {
    this.requireEnabled(); safeId(runnerId);
    const queued = await db.select().from(computerTasks).where(eq(computerTasks.state, 'queued')).orderBy(asc(computerTasks.createdAt)).limit(20);
    for (const task of queued) {
      const session = (await db.select().from(agentSessions).where(eq(agentSessions.id, task.sessionId)))[0];
      if (!session) continue;
      const scope: Scope = { kind: 'task', userId: task.userId, workspaceId: task.workspaceId, sessionId: session.dshSessionId, runId: task.runId, taskId: task.id, expires: task.deadline.getTime() };
      try {
        await this.parent(scope);
        const before = await this.row(task.workspaceId);
        if (before && before.mode !== 'idle') continue;
        await this.ensure(task.userId, task.workspaceId);
        const claimed = await this.lock(task.workspaceId, async () => {
          await this.parent(scope); const row = (await this.row(task.workspaceId))!;
          if (row.mode !== 'idle') return null;
          const epoch = row.epoch + 1;
          const [updated] = await db.update(computerTasks).set({ state: 'running', epoch, runnerId, heartbeatAt: new Date(), updatedAt: new Date() }).where(and(eq(computerTasks.id, task.id), eq(computerTasks.state, 'queued'))).returning();
          if (!updated) return null;
          await db.update(desktopInstances).set({ mode: 'ai', epoch, owner: task.id, controlExpiresAt: new Date(Date.now() + 15000), lastActiveAt: new Date() }).where(eq(desktopInstances.workspaceId, task.workspaceId));
          await this.containers.request(task.workspaceId, '/lease', { epoch, owner: task.id, mode: 'ai' });
          return { ...this.publicTask(updated), token: signScope(scope, this.manager.config.tokenSecret), workspaceId: task.workspaceId, deadline: task.deadline.toISOString() };
        });
        if (claimed) return claimed;
      } catch (error) {
        await this.finish(task, 'failed', error instanceof HttpError ? error.code || 'COMPUTER_START_FAILED' : 'COMPUTER_START_FAILED');
      }
    }
    return null;
  }
  async heartbeat(scope: Scope) {
    return this.lock(scope.workspaceId, async () => {
      await this.parent(scope); const task = await this.task(scope, scope.taskId!), row = await this.row(scope.workspaceId);
      if (!['running', 'confirmation'].includes(task.state) || row?.mode !== 'ai' || row.owner !== task.id || row.epoch !== task.epoch) throw new HttpError(409, 'Computer control lost', 'DESKTOP_CONTROL_LOST');
      if (task.deadline.getTime() <= Date.now()) throw new HttpError(409, 'Task time budget exceeded', 'COMPUTER_BUDGET');
      await this.containers.request(scope.workspaceId, '/lease', { epoch: row.epoch, owner: task.id, mode: 'ai' });
      await db.update(computerTasks).set({ heartbeatAt: new Date() }).where(eq(computerTasks.id, task.id));
      await db.update(desktopInstances).set({ controlExpiresAt: new Date(Date.now() + 15000), lastActiveAt: new Date() }).where(eq(desktopInstances.workspaceId, scope.workspaceId));
      await this.manager.leases.setBusy(scope.userId, 'foreground-commands', task.id, 20000);
      return { ...this.publicTask(task), instructions: task.instructions };
    });
  }
  async screenshot(scope: Scope) {
    await this.heartbeat(scope); const task = await this.task(scope, scope.taskId!);
    return this.containers.request(scope.workspaceId, '/screenshot', { epoch: task.epoch, owner: task.id });
  }
  async action(scope: Scope, sequence: number, operation: unknown) {
    const parsed = actionSchema.parse(operation); await this.parent(scope);
    return this.lock(scope.workspaceId, async () => {
      await this.parent(scope);
      const task = await this.task(scope, scope.taskId!), row = await this.row(scope.workspaceId);
      if (task.state !== 'running' || row?.mode !== 'ai' || row.owner !== task.id || row.epoch !== task.epoch || (row.controlExpiresAt?.getTime() ?? 0) <= Date.now()) throw new HttpError(409, 'Computer control lost', 'DESKTOP_CONTROL_LOST');
      const [prior] = await db.select().from(computerActions).where(and(eq(computerActions.taskId, task.id), eq(computerActions.sequence, sequence)));
      if (prior) {
        if (JSON.stringify(prior.operation) !== JSON.stringify(parsed)) throw new HttpError(409, 'Action ID conflict');
        if (prior.state === 'completed') return { ok: true, duplicate: true };
        throw new HttpError(409, 'Action result unknown; do not replay', 'COMPUTER_EFFECT_UNKNOWN');
      }
      if (sequence !== task.actionCount + 1 || sequence > Number(process.env.COMPUTER_MAX_ACTIONS || 100) || task.deadline.getTime() <= Date.now()) throw new HttpError(409, 'Computer action budget exceeded', 'COMPUTER_BUDGET');
      await db.transaction(async tx => {
        await tx.insert(computerActions).values({ taskId: task.id, sequence, epoch: row.epoch, operation: parsed, state: 'executing' });
        await tx.update(computerTasks).set({ actionCount: sequence, updatedAt: new Date() }).where(eq(computerTasks.id, task.id));
      });
      try {
        await this.containers.request(scope.workspaceId, '/action', { epoch: row.epoch, owner: task.id, sequence, operation: parsed });
        await db.update(computerActions).set({ state: 'completed', updatedAt: new Date() }).where(and(eq(computerActions.taskId, task.id), eq(computerActions.sequence, sequence)));
        return { ok: true };
      } catch (error) {
        await db.update(computerActions).set({ state: 'unknown', updatedAt: new Date() }).where(and(eq(computerActions.taskId, task.id), eq(computerActions.sequence, sequence))); throw error;
      }
    });
  }
  async progress(scope: Scope, value: { text: string; inputTokens: number; outputTokens: number }) {
    const task = await this.task(scope, scope.taskId!); if (terminalTask(task.state)) throw new HttpError(409, 'Task ended');
    const inputTokens = task.inputTokens + Math.max(0, Math.floor(value.inputTokens)), outputTokens = task.outputTokens + Math.max(0, Math.floor(value.outputTokens));
    if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || inputTokens + outputTokens > Number(process.env.COMPUTER_MAX_TOKENS || 300000)) throw new HttpError(409, 'Model token budget exceeded', 'COMPUTER_BUDGET');
    await db.update(computerTasks).set({ inputTokens, outputTokens, progress: value.text.slice(0, 2000), updatedAt: new Date() }).where(eq(computerTasks.id, task.id));
  }
  async confirmation(scope: Scope, plan: unknown) {
    const parsed = planSchema.parse(plan); if (parsed.kind !== 'confirmation' && parsed.kind !== 'handoff') throw new HttpError(400, 'Invalid confirmation');
    await this.lock(scope.workspaceId, async () => {
      await this.parent(scope);
      const task = await this.task(scope, scope.taskId!);
      if (task.state !== 'running') throw new HttpError(409, 'Task is not running');
      await db.update(computerTasks).set({ state: 'confirmation', confirmation: { ...parsed, id: randomUUID() }, updatedAt: new Date() }).where(and(eq(computerTasks.id, task.id), eq(computerTasks.state, 'running')));
    });
  }
  async complete(scope: Scope, result: string, success: boolean) { const task = await this.task(scope, scope.taskId!); await this.finish(task, success ? 'completed' : result === 'COMPUTER_INTERRUPTED' || result.startsWith('COMPUTER_CONTROL_HTTP_') ? 'interrupted' : 'failed', result.slice(0, 16000)); return { ok: true }; }
  private async finish(task: Task, state: string, result: string) {
    return this.lock(task.workspaceId, async () => {
      await db.update(computerTasks).set({ state, result, updatedAt: new Date() }).where(and(eq(computerTasks.id, task.id), inArray(computerTasks.state, activeStates)));
      const row = await this.row(task.workspaceId);
      if (row?.owner === task.id) await this.revokeUnlocked(row, 'idle', null);
      await this.manager.leases.clearBusy(task.userId, 'foreground-commands', task.id);
    });
  }
  private async revokeUnlocked(row: typeof desktopInstances.$inferSelect, mode: 'idle' | 'manual', owner: string | null) {
    const epoch = row.epoch + 1;
    await db.update(desktopInstances).set({ mode: 'revoking', epoch, owner: null, controlExpiresAt: null }).where(eq(desktopInstances.workspaceId, row.workspaceId));
    try { await this.containers.request(row.workspaceId, '/lease', { epoch, mode, owner: owner ?? '' }); }
    catch (error) {
      await this.containers.stop(row.userId, row.workspaceId);
      await db.update(desktopInstances).set({ status: 'stopped', mode: 'idle', owner: null }).where(eq(desktopInstances.workspaceId, row.workspaceId));
      if (mode === 'manual') throw error;
      return;
    }
    await db.update(desktopInstances).set({ mode, owner, controlExpiresAt: mode === 'manual' ? new Date(Date.now() + 15000) : null, lastActiveAt: new Date() }).where(eq(desktopInstances.workspaceId, row.workspaceId));
  }
  async cancelSession(userId: string, sessionId: string) {
    const session = await ownedSession(userId, sessionId);
    const tasks = await db.select().from(computerTasks).where(and(eq(computerTasks.sessionId, session.id), inArray(computerTasks.state, activeStates)));
    for (const task of tasks) await this.finish(task, 'cancelled', 'COMPUTER_PARENT_ENDED');
  }
  async cancelRun(runId: string) {
    const tasks = await db.select().from(computerTasks).where(and(eq(computerTasks.runId, runId), inArray(computerTasks.state, activeStates)));
    for (const task of tasks) await this.finish(task, 'cancelled', 'COMPUTER_PARENT_ENDED');
  }
  async manual(userId: string, workspaceId: string, clientId: string, take: boolean) {
    safeId(clientId); await ownedWorkspace(userId, workspaceId);
    if (take) await this.ensure(userId, workspaceId);
    // Revoke the desktop first, then cancel only its owner. Never cancel unrelated DSH sessions.
    let sessionId: string | undefined;
    await this.lock(workspaceId, async () => {
      const row = await this.row(workspaceId); if (!row) throw new HttpError(409, 'Desktop is stopped');
      if (row.mode === 'manual' && row.owner !== clientId && (row.controlExpiresAt?.getTime() ?? 0) > Date.now()) throw new HttpError(409, 'Another tab controls the desktop', 'DESKTOP_BUSY');
      if (!take && row.owner !== clientId) throw new HttpError(409, 'This tab does not control the desktop', 'DESKTOP_CONTROL_LOST');
      sessionId = row.takeoverSessionId ?? undefined;
      if (row.mode === 'ai' && row.owner) {
        const [task] = await db.select().from(computerTasks).where(eq(computerTasks.id, row.owner));
        if (task) { const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, task.sessionId)); sessionId = session?.dshSessionId;
          await db.update(computerTasks).set({ state: 'interrupted', result: 'COMPUTER_MANUAL_TAKEOVER', updatedAt: new Date() }).where(eq(computerTasks.id, task.id)); }
      }
      await this.revokeUnlocked(row, 'idle', null);
      // Block queue admission until the owning DSH process has confirmed termination.
      if (take) await db.update(desktopInstances).set({ mode: 'revoking', owner: clientId, takeoverSessionId: sessionId ?? null }).where(eq(desktopInstances.workspaceId, workspaceId));
    });
    if (sessionId) await this.runs.cancel(userId, sessionId, false);
    if (take) await this.lock(workspaceId, async () => { const row = (await this.row(workspaceId))!; if (row.mode !== 'revoking' || row.owner !== clientId) throw new HttpError(409, 'Takeover superseded'); await this.revokeUnlocked(row, 'manual', clientId); await db.update(desktopInstances).set({ takeoverSessionId: null }).where(eq(desktopInstances.workspaceId, workspaceId)); });
    return this.view(userId, workspaceId);
  }
  async manualInput(userId: string, workspaceId: string, clientId: string, text: string, readClipboard = false) {
    await ownedWorkspace(userId, workspaceId);
    return this.lock(workspaceId, async () => {
      const row = await this.row(workspaceId);
      if (!row || row.mode !== 'manual' || row.owner !== clientId || (row.controlExpiresAt?.getTime() ?? 0) <= Date.now()) throw new HttpError(403, 'Desktop control not owned');
      const response = await this.containers.request(workspaceId, readClipboard ? '/manual-clipboard' : '/manual-input', { epoch: row.epoch, owner: clientId, text });
      return response.json();
    });
  }
  async viewer(userId: string, workspaceId: string, clientId: string, control: boolean) {
    await ownedWorkspace(userId, workspaceId); const row = await this.row(workspaceId);
    if (!row || row.status !== 'ready') throw new HttpError(409, 'Desktop is not ready', 'DESKTOP_UNAVAILABLE');
    if (control) {
      if (row.mode !== 'manual' || row.owner !== clientId || (row.controlExpiresAt?.getTime() ?? 0) <= Date.now()) throw new HttpError(403, 'Desktop control not owned by this tab');
      await this.containers.request(workspaceId, '/lease', { epoch: row.epoch, mode: 'manual', owner: clientId });
      await db.update(desktopInstances).set({ controlExpiresAt: new Date(Date.now() + 15000), lastActiveAt: new Date() }).where(and(eq(desktopInstances.workspaceId, workspaceId), eq(desktopInstances.epoch, row.epoch), eq(desktopInstances.owner, clientId)));
    }
    return { host: desktopNames(workspaceId).control, port: control ? 5900 : 5901, epoch: row.epoch };
  }
  async userTask(userId: string, workspaceId: string, taskId: string, operation: string, value: string) {
    await ownedWorkspace(userId, workspaceId);
    const find = async () => {
      const [task] = await db.select().from(computerTasks).where(and(eq(computerTasks.id, safeId(taskId)), eq(computerTasks.workspaceId, workspaceId), eq(computerTasks.userId, userId)));
      if (!task) throw new HttpError(404, 'Computer task not found');
      return task;
    };
    if (operation === 'cancel') await this.finish(await find(), 'cancelled', 'COMPUTER_CANCELLED');
    else await this.lock(workspaceId, async () => {
      const task = await find();
      if (operation === 'approve') {
        if (task.state !== 'confirmation' || task.confirmation?.kind !== 'confirmation' || task.confirmation?.id !== value) throw new HttpError(409, 'Confirmation expired');
        await db.update(computerTasks).set({ state: 'running', confirmation: { ...task.confirmation, approved: true }, updatedAt: new Date() }).where(and(eq(computerTasks.id, task.id), eq(computerTasks.state, 'confirmation')));
      } else if (operation === 'steer') {
        if (terminalTask(task.state) || !value.trim() || value.length > 4000 || task.instructions.length >= 50) throw new HttpError(400, 'Invalid task instruction');
        await db.update(computerTasks).set({ instructions: [...task.instructions, { id: randomUUID(), text: value.trim() }], updatedAt: new Date() }).where(eq(computerTasks.id, task.id));
      } else throw new HttpError(400, 'Unknown computer operation');
    });
    return { ok: true };
  }

  async stopWorkspace(userId: string, workspaceId: string, purge = false) {
    await ownedWorkspace(userId, workspaceId, true);
    await this.lock(workspaceId, async () => {
      const tasks = await db.select().from(computerTasks).where(and(eq(computerTasks.workspaceId, workspaceId), inArray(computerTasks.state, activeStates)));
      await db.update(computerTasks).set({ state: 'cancelled', result: 'COMPUTER_WORKSPACE_STOPPED', updatedAt: new Date() }).where(and(eq(computerTasks.workspaceId, workspaceId), inArray(computerTasks.state, activeStates)));
      const row = await this.row(workspaceId);
      if (row) await this.revokeUnlocked(row, 'idle', null);
      if (purge) await this.containers.purge(userId, workspaceId); else await this.containers.stop(userId, workspaceId);
      await db.update(desktopInstances).set({ status: 'stopped', mode: 'idle', owner: null }).where(eq(desktopInstances.workspaceId, workspaceId));
      for (const task of tasks) await this.manager.leases.clearBusy(userId, 'foreground-commands', task.id);
    });
  }

  async sweep(restart = false) {
    if (this.ticking || !this.enabled) return; this.ticking = true;
    try {
      const tasks = await db.select().from(computerTasks).where(inArray(computerTasks.state, activeStates));
      for (const task of tasks) {
        const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, task.sessionId));
        try {
          if (!session) throw new Error('Parent missing');
          await this.parent({ userId: task.userId, workspaceId: task.workspaceId, sessionId: session.dshSessionId, runId: task.runId });
          if (restart || task.deadline.getTime() <= Date.now() || (task.state !== 'queued' && (task.heartbeatAt?.getTime() ?? 0) < Date.now() - 20000)) throw new Error('Execution interrupted');
        } catch { await this.finish(task, 'interrupted', 'COMPUTER_INTERRUPTED'); }
      }
      const reconcileImages = Date.now() >= this.nextImageCheck;
      if (reconcileImages) this.nextImageCheck = Date.now() + 60000;
      const rows = await db.select().from(desktopInstances);
      for (const row of rows) {
        const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId));
        if (workspace?.deletedAt) { await this.stopWorkspace(row.userId, row.workspaceId); continue; }
        if (row.mode !== 'idle' && (restart || (row.controlExpiresAt !== null && row.controlExpiresAt.getTime() < Date.now()))) await this.lock(row.workspaceId, async () => { const current = await this.row(row.workspaceId); if (current && current.epoch === row.epoch) { await this.revokeUnlocked(current, 'idle', null); if (row.mode === 'manual') await db.update(desktopInstances).set({ mode: 'manual', owner: row.owner, controlExpiresAt: null }).where(eq(desktopInstances.workspaceId, row.workspaceId)); } });
        if (reconcileImages && row.status === 'ready') await this.lock(row.workspaceId, async () => {
          const current = await this.row(row.workspaceId);
          if (current?.status !== 'ready') return;
          const names = desktopNames(row.workspaceId);
          try {
            await this.containers.connect(names.private, this.manager.config.managerContainer);
            await this.containers.connect(names.private, process.env.DESKTOP_GATEWAY_CONTAINER_NAME || 'cloud-work-desktop-gateway');
            if (current.mode === 'idle') {
              const imageId = await this.containers.ensure(row.userId, row.workspaceId, false);
              await db.update(desktopInstances).set({ imageId, updatedAt: new Date() }).where(eq(desktopInstances.workspaceId, row.workspaceId));
            }
          } catch { console.error('Desktop reconciliation pending:', row.workspaceId); }
        });
        if (row.status === 'ready' && (row.mode === 'idle' || (row.mode === 'manual' && row.controlExpiresAt === null)) && row.lastActiveAt.getTime() < Date.now() - Number(process.env.DESKTOP_IDLE_MINUTES || 30) * 60000) await this.stopWorkspace(row.userId, row.workspaceId);
      }
    } finally { this.ticking = false; }
  }
  async initialize() { if (!this.enabled) return; await this.sweep(true); this.timer = setInterval(() => { void this.sweep().catch(error => console.error('Computer reconciliation failed:', error instanceof Error ? error.name : 'unknown')); }, 5000); this.timer.unref(); }
  close() { if (this.timer) clearInterval(this.timer); }
}
