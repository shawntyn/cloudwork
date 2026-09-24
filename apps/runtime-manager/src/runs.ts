import { and, eq, isNull, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db, agentEvents, agentSessions, workspaces } from '@cloud-work/database';
import type { AgentEvent } from '@cloud-work/protocol';
import { HttpError, safeId } from './config.js';
import { publish, readEvents, terminal } from './events.js';
import type { RuntimeManager } from './lifecycle.js';

export const sessionLock = (id: string) => `session:${safeId(id)}:run-lock`;
export const workspaceLock = (id: string) => `workspace:${safeId(id)}:operation-lock`;
export const workspaceDeleted = (id: string) => `workspace:${safeId(id)}:deleted`;
export const mcpRunKey = (id: string) => `session:${safeId(id)}:mcp-run`;
const messageRequestKey = (sessionId: string, requestId: string) => `session:${safeId(sessionId)}:message-request:${safeId(requestId)}`;
const clearMatchingKey = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

function titleFromPrompt(prompt: string) {
  const characters = Array.from(prompt.replace(/\s+/gu, ' ').trim());
  return characters.slice(0, 80).join('') + (characters.length > 80 ? '…' : '');
}

function runErrorCode(message: string) {
  return /timed?\s*out|timeout/i.test(message) ? 'RUN_TIMEOUT' : 'RUN_FAILED';
}

export async function ownedWorkspace(userId: string, workspaceId: string, includeDeleted = false) {
  const workspace = (await db.select().from(workspaces).where(and(eq(workspaces.id, safeId(workspaceId)), eq(workspaces.userId, safeId(userId)), includeDeleted ? undefined : isNull(workspaces.deletedAt))).limit(1))[0];
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

  async messageStatus(userId: string, sessionId: string, requestId: string) {
    const session = await ownedSession(userId, sessionId);
    return this.manager.leases.withLock(workspaceLock(session.workspaceId), async () => {
      const current = await ownedSession(userId, sessionId);
      const [record] = await db.select({ event: agentEvents.event }).from(agentEvents).where(and(
        eq(agentEvents.sessionId, current.id),
        sql`${agentEvents.event}->>'requestId' = ${requestId}`,
        sql`${agentEvents.event}->>'type' = 'user-message'`,
      )).limit(1);
      const key = messageRequestKey(sessionId, requestId);
      const value = await this.manager.leases.redis.get(key);
      if (record) {
        const prompt = record.event.text;
        if (value?.startsWith('pending:') && typeof prompt === 'string') {
          const fingerprint = createHash('sha256').update(prompt).digest('hex');
          await this.manager.leases.redis.set(key, `accepted:${fingerprint}`, 'EX', 7 * 24 * 3600);
        }
        return { state: 'accepted' as const, sessionStatus: current.status };
      }
      if (value?.startsWith('accepted:')) return { state: 'accepted' as const, sessionStatus: current.status };
      if (value?.startsWith('pending:')) {
        // A crashed manager can leave this marker without ever journaling the
        // user message. Only clear it after both the run lease and durable
        // session state confirm that no execution can still accept it.
        if (this.active.has(sessionId) || await this.manager.leases.redis.exists(sessionLock(sessionId)) || ['running', 'starting'].includes(current.status))
          return { state: 'pending' as const, sessionStatus: current.status };
        await this.manager.leases.redis.eval(clearMatchingKey, 1, key, value);
      }
      return { state: 'absent' as const, sessionStatus: current.status };
    });
  }

  async launch(userId: string, sessionId: string, prompt: string, requestId?: string) {
    const session = await ownedSession(userId, sessionId);
    await this.manager.leases.withLock(workspaceLock(session.workspaceId), async () => {
      const current = await ownedSession(userId, sessionId);
      const wasConfirmedBlank = current.confirmedBlank && current.firstMessageAt === null;
      if (await this.manager.leases.redis.exists(workspaceDeleted(session.workspaceId))) throw new HttpError(410, 'Workspace was deleted');
      const requestKey = requestId ? messageRequestKey(sessionId, requestId) : undefined;
      const fingerprint = requestKey ? createHash('sha256').update(prompt).digest('hex') : undefined;
      if (requestKey) {
        const previous = await this.manager.leases.redis.get(requestKey);
        if (previous === `accepted:${fingerprint}`) return;
        if (previous) throw new HttpError(409, 'Message acceptance is still being confirmed');
      }
      const token = await this.manager.leases.acquire(sessionLock(sessionId));
      if (requestKey) {
        try {
          if (await this.manager.leases.redis.set(requestKey, `pending:${fingerprint}`, 'EX', 3600, 'NX') !== 'OK') throw new HttpError(409, 'Message acceptance is still being confirmed');
        } catch (error) {
          await this.manager.leases.release(sessionLock(sessionId), token);
          throw error;
        }
      }
      let markedRunning = false, messagePublished = false;
      try {
        // Publish ownership of the busy lease before returning 202, so reaping cannot race startup.
        await this.manager.admitActivity(userId, 'active-agent-tasks', sessionId);
        await this.manager.leases.renew(sessionLock(sessionId), token);
        // Clear the blank marker before publishing a user message. An interrupted
        // metadata write must never make a conversation eligible for reuse.
        await db.update(agentSessions).set({ status: 'running', confirmedBlank: false, lastActivityAt: sql`now()`, updatedAt: sql`now()` }).where(eq(agentSessions.id, session.id));
        markedRunning = true;
        await publish(this.manager.leases.redis, sessionId, { type: 'user-message', text: prompt, ...(requestId ? { requestId } : {}) });
        messagePublished = true;
        if (requestKey) await this.manager.leases.redis.set(requestKey, `accepted:${fingerprint}`, 'EX', 7 * 24 * 3600);
        // Only a newly created draft has a known first-message time. A manual
        // rename made before sending takes precedence over the automatic title.
        await db.update(agentSessions).set({
          ...(wasConfirmedBlank ? {
            title: sql`coalesce(${agentSessions.title}, ${titleFromPrompt(prompt)})`,
            firstMessageAt: sql`coalesce(${agentSessions.firstMessageAt}, now())`,
          } : {}),
          lastActivityAt: sql`now()`,
          updatedAt: sql`now()`,
        }).where(and(eq(agentSessions.id, session.id), eq(agentSessions.userId, userId)));
        await publish(this.manager.leases.redis, sessionId, { type: 'status', status: 'starting' });
        const execution: Execution = { userId, sessionId, token, controller: new AbortController(), promise: Promise.resolve(), cancelling: false, started: false };
        this.active.set(sessionId, execution);
        execution.promise = this.execute(execution, session.workspaceId, prompt);
        void execution.promise.catch(error => this.log.error(error, 'Agent execution cleanup failed'));
      } catch (error) {
        if (requestKey) {
          try {
            if (messagePublished) await this.manager.leases.redis.set(requestKey, `accepted:${fingerprint}`, 'EX', 7 * 24 * 3600);
            else await this.manager.leases.redis.del(requestKey);
          } catch (requestError) { this.log.error(requestError, 'Failed to reconcile message acceptance key'); }
        }
        let durableFailure = false;
        try {
          await publish(this.manager.leases.redis, sessionId, { type: 'error', code: 'RUN_START_FAILED', message: 'The run could not be started' });
          await publish(this.manager.leases.redis, sessionId, { type: 'status', status: 'error' });
          durableFailure = true;
        } catch (journalError) { this.log.error(journalError, 'Failed to publish start failure; stale-run recovery will retry'); }
        if (!markedRunning || durableFailure) {
          await this.manager.leases.clearBusy(userId, 'active-agent-tasks', sessionId);
          await this.manager.leases.release(sessionLock(sessionId), token);
          await db.update(agentSessions).set({ status: 'error', lastActivityAt: sql`now()`, updatedAt: sql`now()` }).where(eq(agentSessions.id, session.id));
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
        await publish(leases.redis, sessionId, event.type === 'error' ? { ...event, code: event.code || runErrorCode(event.message) } : event);
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
        : [{ type: 'error', code: runErrorCode(error instanceof Error ? error.message : ''), message: error instanceof Error ? error.message : 'Agent execution failed' }, { type: 'status', status: 'error' }];
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
      await db.update(agentSessions).set({ status: finalStatus, lastActivityAt: sql`now()`, updatedAt: sql`now()` }).where(eq(agentSessions.dshSessionId, sessionId));
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
    // A late or repeated Stop has no run to cancel. It must not overwrite a
    // completed error with a misleading "stopped" event.
    return { ok: true };
  }

  async recoverStale(userId?: string) {
    const condition = userId ? and(eq(agentSessions.status, 'running'), eq(agentSessions.userId, userId)) : eq(agentSessions.status, 'running');
    const sessions = await db.select().from(agentSessions).where(condition);
    for (const session of sessions) {
      try {
        if (await this.manager.leases.redis.exists(sessionLock(session.dshSessionId))) continue;
        await this.manager.leases.withLock(workspaceLock(session.workspaceId), async () => {
          if (await this.manager.leases.redis.exists(sessionLock(session.dshSessionId))) return;
          await this.terminateExecution(session.userId, session.dshSessionId);
          const runId = await this.manager.leases.redis.get(mcpRunKey(session.dshSessionId));
          if (runId) {
            await this.manager.mcp.revoke(session.userId, safeId(runId));
            await this.manager.leases.redis.del(mcpRunKey(session.dshSessionId));
          }
          await publish(this.manager.leases.redis, session.dshSessionId, { type: 'error', code: 'RUN_INTERRUPTED', message: 'Execution interrupted when its manager lease was lost. Your workspace files are preserved.' });
          await publish(this.manager.leases.redis, session.dshSessionId, { type: 'status', status: 'error' });
          await db.update(agentSessions).set({ status: 'error', lastActivityAt: sql`now()`, updatedAt: sql`now()` }).where(eq(agentSessions.id, session.id));
          await this.manager.leases.clearBusy(session.userId, 'active-agent-tasks', session.dshSessionId);
        });
      } catch (error) {
        // Keep its running record/lease intact, but do not block unrelated tenants or manager startup.
        this.log.error(error, `Stale execution recovery deferred for ${session.dshSessionId}`);
      }
    }
  }

  async shutdown() {
    for (const execution of this.active.values()) await this.cancel(execution.userId, execution.sessionId).catch(error => this.log.error(error, 'Shutdown cancellation failed'));
    await Promise.allSettled([...this.active.values()].map(execution => execution.promise));
  }
}
