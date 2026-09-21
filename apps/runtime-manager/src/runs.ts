import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, agentSessions, workspaces } from '@cloud-work/database';
import type { AgentEvent } from '@cloud-work/protocol';
import { HttpError, safeId } from './config.js';
import { publish, readEvents, terminal } from './events.js';
import type { RuntimeManager } from './lifecycle.js';

export const sessionLock = (id: string) => `session:${safeId(id)}:run-lock`;
export const workspaceLock = (id: string) => `workspace:${safeId(id)}:operation-lock`;
export const workspaceDeleted = (id: string) => `workspace:${safeId(id)}:deleted`;
export const mcpRunKey = (id: string) => `session:${safeId(id)}:mcp-run`;

export async function ownedWorkspace(userId: string, workspaceId: string) {
  const workspace = (await db.select().from(workspaces).where(and(eq(workspaces.id, safeId(workspaceId)), eq(workspaces.userId, safeId(userId)))).limit(1))[0];
  if (!workspace) throw new HttpError(404, 'Workspace not found');
  return workspace;
}

export async function ownedSession(userId: string, sessionId: string) {
  const session = (await db.select().from(agentSessions).where(and(eq(agentSessions.dshSessionId, safeId(sessionId)), eq(agentSessions.userId, safeId(userId)))).limit(1))[0];
  if (!session) throw new HttpError(404, 'Session not found');
  await ownedWorkspace(userId, session.workspaceId);
  return session;
}

export async function responseJson(response: Response) {
  const body = await response.json().catch(() => ({ error: `Runtime returned HTTP ${response.status}` }));
  if (!response.ok) throw new HttpError(response.status, typeof body.error === 'string' ? body.error : 'Runtime request failed');
  return body;
}

type Execution = { userId: string; sessionId: string; token: string; controller: AbortController; promise: Promise<void>; cancelling: boolean; started: boolean };

export class Runs {
  private active = new Map<string, Execution>();
  constructor(private manager: RuntimeManager, private log: { error: (error: unknown, message?: string) => void }) {}

  async launch(userId: string, sessionId: string, prompt: string) {
    const session = await ownedSession(userId, sessionId);
    await this.manager.leases.withLock(workspaceLock(session.workspaceId), async () => {
      await ownedSession(userId, sessionId);
      if (await this.manager.leases.redis.exists(workspaceDeleted(session.workspaceId))) throw new HttpError(410, 'Workspace was deleted');
      const token = await this.manager.leases.acquire(sessionLock(sessionId));
      let markedRunning = false;
      try {
        // Publish ownership of the busy lease before returning 202, so reaping cannot race startup.
        await this.manager.leases.setBusy(userId, 'active-agent-tasks', sessionId);
        await db.update(agentSessions).set({ status: 'running', updatedAt: new Date() }).where(eq(agentSessions.id, session.id));
        markedRunning = true;
        await publish(this.manager.leases.redis, sessionId, { type: 'user-message', text: prompt });
        await publish(this.manager.leases.redis, sessionId, { type: 'status', status: 'starting' });
        const execution: Execution = { userId, sessionId, token, controller: new AbortController(), promise: Promise.resolve(), cancelling: false, started: false };
        this.active.set(sessionId, execution);
        execution.promise = this.execute(execution, session.workspaceId, prompt);
        void execution.promise.catch(error => this.log.error(error, 'Agent execution cleanup failed'));
      } catch (error) {
        let durableFailure = false;
        try {
          await publish(this.manager.leases.redis, sessionId, { type: 'error', message: 'The run could not be started' });
          await publish(this.manager.leases.redis, sessionId, { type: 'status', status: 'error' });
          durableFailure = true;
        } catch (journalError) { this.log.error(journalError, 'Failed to publish start failure; stale-run recovery will retry'); }
        if (!markedRunning || durableFailure) {
          await this.manager.leases.clearBusy(userId, 'active-agent-tasks', sessionId);
          await this.manager.leases.release(sessionLock(sessionId), token);
          await db.update(agentSessions).set({ status: 'error', updatedAt: new Date() }).where(eq(agentSessions.id, session.id));
        }
        throw error;
      }
    });
  }

  private async execute(execution: Execution, workspaceId: string, prompt: string) {
    const { userId, sessionId, token, controller } = execution;
    const { leases } = this.manager;
    let terminalEvent = false, finalStatus = 'error', runStarted = false, executionSafe = true, durableTerminal = false, leaseFailure: unknown;
    const runId = randomUUID();
    let mcpAttempted = false, mcpIssued = false;
    let heartbeatPending = false;
    const heartbeat = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      void (async () => {
        await leases.renew(sessionLock(sessionId), token);
        await leases.setBusy(userId, 'active-agent-tasks', sessionId);
        await this.manager.touchRuntime(userId);
        if (mcpIssued) await this.manager.mcp.renew(userId, runId);
      })().catch(error => { leaseFailure = error; controller.abort(error); }).finally(() => { heartbeatPending = false; });
    }, this.manager.config.heartbeatMs);
    heartbeat.unref();
    try {
      await this.manager.ensureRuntime(userId);
      if (controller.signal.aborted) throw controller.signal.reason;
      await responseJson(await this.manager.request(userId, `/workspaces/${workspaceId}`, { method: 'POST' }));
      await responseJson(await this.manager.request(userId, `/sessions/${sessionId}`, { method: 'POST', body: JSON.stringify({ workspaceId }) }));
      if (execution.cancelling) throw new Error('Run cancelled before execution');
      // Persist only the run identifier before issuing grants, including when the HTTP response is lost.
      await leases.redis.set(mcpRunKey(sessionId), runId);
      mcpAttempted = true;
      const mcp = await this.manager.mcp.snapshot(userId, runId, workspaceId, sessionId);
      mcpIssued = true;
      if (execution.cancelling || controller.signal.aborted) throw new Error('Run cancelled before execution');
      runStarted = true;
      execution.started = true;
      executionSafe = false;
      const response = await this.manager.request(userId, `/sessions/${sessionId}/run`, { method: 'POST', body: JSON.stringify({ prompt, mcp }), signal: controller.signal });
      if (!response.ok) await responseJson(response);
      if (!response.body) throw new Error('Runtime response contained no stream');
      for await (const event of readEvents(response.body)) {
        await publish(leases.redis, sessionId, event);
        if (terminal(event)) {
          finalStatus = event.type === 'status' && event.status === 'error' ? 'error' : 'idle';
          terminalEvent = true;
          executionSafe = true;
          durableTerminal = true;
          break;
        }
      }
      if (!terminalEvent) throw new Error('Runtime stream ended without a terminal event');
    } catch (error) {
      // Never release a busy lease just because its HTTP reader failed. First terminate execution.
      if (runStarted && !terminalEvent) { await this.terminateExecution(userId, sessionId); executionSafe = true; }
      const cancelled = execution.cancelling && !leaseFailure;
      const events: AgentEvent[] = cancelled
        ? [{ type: 'status', status: 'stopped' }]
        : [{ type: 'error', message: error instanceof Error ? error.message : 'Agent execution failed' }, { type: 'status', status: 'error' }];
      for (const event of events) {
        try { await publish(leases.redis, sessionId, event); if (terminal(event)) durableTerminal = true; }
        catch (journalError) { this.log.error(journalError, 'Failed to publish terminal event; stale-run reconciliation will retry'); }
      }
      finalStatus = cancelled ? 'idle' : 'error';
    } finally {
      clearInterval(heartbeat);
      mcpIssued = false;
      if (executionSafe && mcpAttempted) {
        try {
          await this.manager.mcp.revoke(userId, runId);
          await leases.redis.del(mcpRunKey(sessionId));
        } catch {
          // Retain running metadata and the identifier for recovery. No grant token is journaled.
          this.log.error(new Error('MCP grant revocation failed'), 'Stale-run recovery will retry MCP cleanup');
          this.active.delete(sessionId);
          return;
        }
      }
      if (!executionSafe || !durableTerminal) {
        // Preserve running metadata and the lease on ambiguous termination. The reaper
        // cannot stop busy runtimes; stale-run recovery retries once Docker returns.
        this.active.delete(sessionId);
        return;
      }
      await db.update(agentSessions).set({ status: finalStatus, updatedAt: new Date() }).where(eq(agentSessions.dshSessionId, sessionId));
      await this.manager.touchRuntime(userId);
      await leases.clearBusy(userId, 'active-agent-tasks', sessionId);
      await leases.release(sessionLock(sessionId), token);
      this.active.delete(sessionId);
    }
  }

  private async terminateExecution(userId: string, sessionId: string) {
    try {
      await responseJson(await this.manager.request(userId, `/sessions/${sessionId}/cancel`, { method: 'POST' }, 20_000));
    } catch (error) {
      this.log.error(error, 'Runtime cancel failed; stopping container to terminate execution');
      await this.manager.leases.withUserLock(userId, () => this.manager.stopUnlocked(userId, true));
    }
  }

  async cancel(userId: string, sessionId: string) {
    await ownedSession(userId, sessionId);
    const execution = this.active.get(sessionId);
    if (execution) {
      execution.cancelling = true;
      // Abort the reader only after the runtime confirms the session process has exited.
      if (execution.started) await this.terminateExecution(userId, sessionId);
      execution.controller.abort(new Error('Run cancelled'));
      return { ok: true };
    }
    if (await this.manager.leases.redis.exists(sessionLock(sessionId))) {
      await this.terminateExecution(userId, sessionId);
      return { ok: true };
    }
    await publish(this.manager.leases.redis, sessionId, { type: 'status', status: 'stopped' });
    await db.update(agentSessions).set({ status: 'idle', updatedAt: new Date() }).where(eq(agentSessions.dshSessionId, sessionId));
    return { ok: true };
  }

  async recoverStale(userId?: string) {
    const condition = userId ? and(eq(agentSessions.status, 'running'), eq(agentSessions.userId, userId)) : eq(agentSessions.status, 'running');
    const sessions = await db.select().from(agentSessions).where(condition);
    for (const session of sessions) {
      if (await this.manager.leases.redis.exists(sessionLock(session.dshSessionId))) continue;
      await this.manager.leases.withLock(workspaceLock(session.workspaceId), async () => {
        if (await this.manager.leases.redis.exists(sessionLock(session.dshSessionId))) return;
        await this.terminateExecution(session.userId, session.dshSessionId);
        const runId = await this.manager.leases.redis.get(mcpRunKey(session.dshSessionId));
        if (runId) {
          await this.manager.mcp.revoke(session.userId, safeId(runId));
          await this.manager.leases.redis.del(mcpRunKey(session.dshSessionId));
        }
        await publish(this.manager.leases.redis, session.dshSessionId, { type: 'error', message: 'Execution interrupted when its manager lease was lost. Your workspace files are preserved.' });
        await publish(this.manager.leases.redis, session.dshSessionId, { type: 'status', status: 'error' });
        await db.update(agentSessions).set({ status: 'error', updatedAt: new Date() }).where(eq(agentSessions.id, session.id));
        await this.manager.leases.clearBusy(session.userId, 'active-agent-tasks', session.dshSessionId);
      });
    }
  }

  async shutdown() {
    for (const execution of this.active.values()) await this.cancel(execution.userId, execution.sessionId).catch(error => this.log.error(error, 'Shutdown cancellation failed'));
    await Promise.allSettled([...this.active.values()].map(execution => execution.promise));
  }
}
