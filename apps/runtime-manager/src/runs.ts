import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db, agentEvents, agentMessageRequests, agentSessions, workspaces } from '@cloud-work/database';
import type { AgentEvent } from '@cloud-work/protocol';
import { HttpError, safeId } from './config.js';
import { publish, readEvents, terminal } from './events.js';
import type { RuntimeManager } from './lifecycle.js';

export const sessionLock = (id: string) => `session:${safeId(id)}:run-lock`;
export const sessionControlLock = (id: string) => `session:${safeId(id)}:control-lock`;
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

type Execution = { userId: string; sessionId: string; sessionRowId: string; requestId: string; runId: string; token: string; controller: AbortController; promise: Promise<void>; cancelling: boolean; started: boolean };

function promptFingerprint(prompt: string) {
  return createHash('sha256').update(prompt).digest('hex');
}

function assertSamePrompt(previous: string, fingerprint: string) {
  if (previous !== fingerprint) throw new HttpError(409, 'Message identifier was already used for different text', 'IDEMPOTENCY_KEY_CONFLICT');
}

export class Runs {
  private active = new Map<string, Execution>();
  constructor(private manager: RuntimeManager, private log: { error: (error: unknown, message?: string) => void }) {}

  async messageStatus(userId: string, sessionId: string, requestId: string) {
    const session = await ownedSession(userId, sessionId);
    return this.manager.leases.withLock(workspaceLock(session.workspaceId), async () => {
      const current = await ownedSession(userId, sessionId);
      const [durable] = await db.select({ status: agentMessageRequests.status }).from(agentMessageRequests)
        .where(and(eq(agentMessageRequests.sessionId, current.id), eq(agentMessageRequests.requestId, requestId))).limit(1);
      if (durable) return { state: 'accepted' as const, sessionStatus: current.status, requestStatus: durable.status };
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

  async launch(userId: string, sessionId: string, prompt: string, requestId: string) {
    const session = await ownedSession(userId, sessionId);
    return this.manager.leases.withLock(workspaceLock(session.workspaceId), () =>
      this.manager.leases.withLock(sessionControlLock(sessionId), async () => {
        const current = await ownedSession(userId, sessionId);
        const id = requestId;
        const text = prompt.trim();
        const fingerprint = promptFingerprint(text);
        const legacyFingerprint = promptFingerprint(prompt);
        const wasConfirmedBlank = current.confirmedBlank && current.firstMessageAt === null;
        if (await this.manager.leases.redis.exists(workspaceDeleted(session.workspaceId))) throw new HttpError(410, 'Workspace was deleted');
        const [previous] = await db.select({ promptFingerprint: agentMessageRequests.promptFingerprint, status: agentMessageRequests.status }).from(agentMessageRequests)
          .where(and(eq(agentMessageRequests.sessionId, current.id), eq(agentMessageRequests.requestId, id))).limit(1);
        if (previous) { assertSamePrompt(previous.promptFingerprint, fingerprint); return { requestStatus: previous.status }; }
        // Requests accepted before the durable ledger migration already have a
        // permanent user-message event. Do not replay them after their Redis TTL.
        const [legacy] = await db.select({ event: agentEvents.event }).from(agentEvents).where(and(
          eq(agentEvents.sessionId, current.id), sql`${agentEvents.event}->>'requestId' = ${id}`,
          sql`${agentEvents.event}->>'type' = 'user-message'`,
        )).limit(1);
        if (legacy) {
          assertSamePrompt(promptFingerprint(String(legacy.event.text ?? '')), legacyFingerprint);
          return { requestStatus: null };
        }
        const legacyValue = await this.manager.leases.redis.get(messageRequestKey(sessionId, id));
        if (legacyValue?.startsWith('accepted:')) { assertSamePrompt(legacyValue.slice(9), legacyFingerprint); return { requestStatus: null }; }
        if (legacyValue?.startsWith('pending:')) {
          assertSamePrompt(legacyValue.slice(8), legacyFingerprint);
          throw new HttpError(409, 'Message acceptance is still being confirmed');
        }
        if (['running', 'starting'].includes(current.status)) throw new HttpError(409, 'This conversation already has an active request');
        const token = await this.manager.leases.acquire(sessionLock(sessionId));
        let admitted = false;
        let inserted = false;
        try {
          await this.manager.admitActivity(userId, 'active-agent-tasks', sessionId, false);
          admitted = true;
          await this.manager.leases.renew(sessionLock(sessionId), token);
          // The receipt is also the durable outbox item. Either all of the
          // request, user event, and session transition commit or none do.
          inserted = await db.transaction(async tx => {
            const [newRequest] = await tx.insert(agentMessageRequests).values({ sessionId: current.id, requestId: id, prompt: text, promptFingerprint: fingerprint })
              .onConflictDoNothing().returning({ requestId: agentMessageRequests.requestId });
            if (!newRequest) return false;
            await tx.update(agentSessions).set({
              status: 'running', confirmedBlank: false,
              ...(wasConfirmedBlank ? {
                title: sql`coalesce(${agentSessions.title}, ${titleFromPrompt(text)})`,
                firstMessageAt: sql`coalesce(${agentSessions.firstMessageAt}, now())`,
              } : {}),
              lastActivityAt: sql`now()`, updatedAt: sql`now()`,
            }).where(and(eq(agentSessions.id, current.id), eq(agentSessions.userId, userId)));
            await tx.insert(agentEvents).values([
              { sessionId: current.id, event: { type: 'user-message', text, requestId: id } },
              { sessionId: current.id, event: { type: 'status', status: 'starting' } },
            ]);
            return true;
          });
        } catch (error) {
          if (admitted) await this.manager.leases.clearBusy(userId, 'active-agent-tasks', sessionId);
          await this.manager.leases.release(sessionLock(sessionId), token);
          throw error;
        }
        if (!inserted) {
          await this.manager.leases.clearBusy(userId, 'active-agent-tasks', sessionId);
          await this.manager.leases.release(sessionLock(sessionId), token);
          const [raced] = await db.select({ promptFingerprint: agentMessageRequests.promptFingerprint, status: agentMessageRequests.status }).from(agentMessageRequests)
            .where(and(eq(agentMessageRequests.sessionId, current.id), eq(agentMessageRequests.requestId, id))).limit(1);
          if (!raced) throw new Error('Message receipt conflict without durable record');
          assertSamePrompt(raced.promptFingerprint, fingerprint);
          return { requestStatus: raced.status };
        }
        this.startAcceptedExecution({ userId, sessionId, sessionRowId: current.id, requestId: id, token }, session.workspaceId, text);
        return { requestStatus: 'queued' as const };
      }));
  }

  private startAcceptedExecution(input: Pick<Execution, 'userId' | 'sessionId' | 'sessionRowId' | 'requestId' | 'token'>, workspaceId: string, prompt: string) {
    const execution: Execution = { ...input, runId: randomUUID(), controller: new AbortController(), promise: Promise.resolve(), cancelling: false, started: false };
    this.active.set(input.sessionId, execution);
    execution.promise = this.execute(execution, workspaceId, prompt);
    void execution.promise.catch(error => this.log.error(error, 'Agent execution cleanup failed'));
  }

  private async revokeRecordedGrant(userId: string, sessionId: string, sessionRowId: string, requestId: string, runId: string) {
    await this.manager.mcp.revoke(userId, runId);
    await this.manager.leases.redis.eval(clearMatchingKey, 1, mcpRunKey(sessionId), runId);
    await db.update(agentMessageRequests).set({ mcpRevokedAt: new Date(), updatedAt: new Date() }).where(and(
      eq(agentMessageRequests.sessionId, sessionRowId), eq(agentMessageRequests.requestId, requestId),
      eq(agentMessageRequests.runId, runId), inArray(agentMessageRequests.status, ['completed', 'failed']),
      isNull(agentMessageRequests.mcpRevokedAt),
    ));
  }

  private async retryPendingGrantCleanup() {
    const pending = await db.select({
      sessionRowId: agentMessageRequests.sessionId, requestId: agentMessageRequests.requestId,
      runId: agentMessageRequests.runId, userId: agentSessions.userId, sessionId: agentSessions.dshSessionId,
    }).from(agentMessageRequests).innerJoin(agentSessions, eq(agentSessions.id, agentMessageRequests.sessionId))
      .where(and(inArray(agentMessageRequests.status, ['completed', 'failed']), isNotNull(agentMessageRequests.runId), isNull(agentMessageRequests.mcpRevokedAt)))
      .orderBy(asc(agentMessageRequests.completedAt)).limit(10);
    await Promise.allSettled(pending.map(async row => {
      try {
        await this.revokeRecordedGrant(row.userId, row.sessionId, row.sessionRowId, row.requestId, row.runId!);
      } catch (error) { this.log.error(error, `MCP grant cleanup deferred for ${row.sessionId}`); }
    }));
  }

  private async execute(execution: Execution, workspaceId: string, prompt: string) {
    const { userId, sessionId, sessionRowId, requestId, runId, token, controller } = execution;
    const { leases } = this.manager;
    let terminalEvent = false, finalStatus = 'error', runStarted = false, executionSafe = true, abandonedClaim = false, leaseFailure: unknown;
    let terminalEvents: AgentEvent[] = [];
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
      await leases.withLock(workspaceLock(workspaceId), async () => {
        await ownedWorkspace(userId, workspaceId);
        if (execution.cancelling || controller.signal.aborted) throw new Error('Run cancelled before workspace preparation');
        await responseJson(await this.manager.request(userId, `/workspaces/${workspaceId}`, { method: 'POST' }));
        if (execution.cancelling || controller.signal.aborted) throw new Error('Run cancelled before session preparation');
        await responseJson(await this.manager.request(userId, `/sessions/${sessionId}`, { method: 'POST', body: JSON.stringify({ workspaceId }) }));
      });
      if (execution.cancelling) throw new Error('Run cancelled before execution');
      // Persist only the run identifier before issuing grants, including when the HTTP response is lost.
      await leases.redis.set(mcpRunKey(sessionId), runId);
      mcpAttempted = true;
      const mcp = await this.manager.mcp.snapshot(userId, runId, workspaceId, sessionId);
      mcpIssued = true;
      if (execution.cancelling || controller.signal.aborted) throw new Error('Run cancelled before execution');
      // Serialize the claim and initial /run dispatch with Stop. After Runtime
      // accepts the stream, Stop can cancel the specific active execution.
      const response = await leases.withLock(sessionControlLock(sessionId), async () => {
        try { await leases.renew(sessionLock(sessionId), token); }
        catch { return null; }
        if (execution.cancelling || controller.signal.aborted) return null;
        const [claimed] = await db.update(agentMessageRequests).set({ status: 'running', runId, startedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(agentMessageRequests.sessionId, sessionRowId), eq(agentMessageRequests.requestId, requestId), eq(agentMessageRequests.status, 'queued'), isNull(agentMessageRequests.runId)))
          .returning({ requestId: agentMessageRequests.requestId });
        if (!claimed) return null;
        runStarted = true;
        execution.started = true;
        executionSafe = false;
        if (execution.cancelling || controller.signal.aborted) throw new Error('Run cancelled before execution');
        return this.manager.request(userId, `/sessions/${sessionId}/run`, { method: 'POST', body: JSON.stringify({ prompt, mcp }), signal: controller.signal });
      });
      if (!response) { abandonedClaim = true; return; }
      if (!response.ok) await responseJson(response);
      if (!response.body) throw new Error('Runtime response contained no stream');
      for await (const event of readEvents(response.body)) {
        if (terminal(event)) {
          finalStatus = event.type === 'status' && event.status === 'error' ? 'error' : 'idle';
          terminalEvent = true;
          executionSafe = true;
          terminalEvents = [event];
          break;
        }
        await publish(leases.redis, sessionId, event.type === 'error' ? { ...event, code: event.code || runErrorCode(event.message) } : event);
      }
      if (!terminalEvent) throw new Error('Runtime stream ended without a terminal event');
    } catch (error) {
      // A preparation attempt that lost its lease never reached /run. Leave
      // its queued receipt for the surviving manager to resume.
      if (!runStarted && leaseFailure) return;
      // Never release a busy lease just because its HTTP reader failed. First terminate execution.
      if (runStarted && !terminalEvent) { await this.terminateExecution(userId, sessionId); executionSafe = true; }
      if (leaseFailure && await leases.redis.get(sessionLock(sessionId)) !== token) return;
      const cancelled = execution.cancelling && !leaseFailure;
      terminalEvents = cancelled
        ? [{ type: 'status', status: 'stopped' }]
        : [{ type: 'error', code: runErrorCode(error instanceof Error ? error.message : ''), message: error instanceof Error ? error.message : 'Agent execution failed' }, { type: 'status', status: 'error' }];
      finalStatus = cancelled ? 'idle' : 'error';
    } finally {
      mcpIssued = false;
      try {
        // No Runtime /run has received a pre-run grant. Failed cleanup cannot
        // hold the user's message indefinitely; gateway grants expire shortly.
        if (executionSafe && mcpAttempted && !runStarted) {
          try {
            await this.manager.mcp.revoke(userId, runId);
            await leases.redis.eval(clearMatchingKey, 1, mcpRunKey(sessionId), runId);
          } catch (error) {
            this.log.error(error, 'Pre-run MCP grant cleanup failed; unused gateway grant will expire');
          }
        }
        if (!executionSafe || !terminalEvents.length) {
          if (abandonedClaim && await leases.redis.get(sessionLock(sessionId)) === token) {
            await leases.clearBusy(userId, 'active-agent-tasks', sessionId);
            await leases.release(sessionLock(sessionId), token);
          }
          // Preserve running metadata and the lease on ambiguous termination.
          if (this.active.get(sessionId) === execution) this.active.delete(sessionId);
          return;
        }
        if (await leases.redis.get(sessionLock(sessionId)) !== token) {
          if (this.active.get(sessionId) === execution) this.active.delete(sessionId);
          return;
        }
        const finished = await db.transaction(async tx => {
          const [updated] = await tx.update(agentMessageRequests).set({ status: finalStatus === 'idle' ? 'completed' : 'failed', completedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(agentMessageRequests.sessionId, sessionRowId), eq(agentMessageRequests.requestId, requestId), or(
              and(eq(agentMessageRequests.status, 'queued'), isNull(agentMessageRequests.runId)),
              and(eq(agentMessageRequests.status, 'running'), eq(agentMessageRequests.runId, runId)),
            ))).returning({ requestId: agentMessageRequests.requestId });
          if (!updated) return false;
          await tx.insert(agentEvents).values(terminalEvents.map(event => ({ sessionId: sessionRowId, event })));
          await tx.update(agentSessions).set({ status: finalStatus, lastActivityAt: sql`now()`, updatedAt: sql`now()` }).where(eq(agentSessions.dshSessionId, sessionId));
          return true;
        });
        if (finished && runStarted && mcpAttempted) {
          // Persist the actual Runtime result before gateway cleanup. A gateway
          // outage must not rewrite a successful answer as an interrupted run.
          try { await this.revokeRecordedGrant(userId, sessionId, sessionRowId, requestId, runId); }
          catch (error) { this.log.error(error, 'MCP grant cleanup will be retried from the durable receipt'); }
        }
        if (await leases.redis.get(sessionLock(sessionId)) === token) {
          if (finished) await this.manager.touchRuntime(userId);
          await leases.clearBusy(userId, 'active-agent-tasks', sessionId);
          await leases.release(sessionLock(sessionId), token);
        }
        if (this.active.get(sessionId) === execution) this.active.delete(sessionId);
      } finally {
        clearInterval(heartbeat);
        if (this.active.get(sessionId) === execution) this.active.delete(sessionId);
      }
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

  private async completeQueuedStop(sessionRowId: string, requestId: string) {
    return db.transaction(async tx => {
      const [updated] = await tx.update(agentMessageRequests).set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(agentMessageRequests.sessionId, sessionRowId), eq(agentMessageRequests.requestId, requestId), eq(agentMessageRequests.status, 'queued')))
        .returning({ requestId: agentMessageRequests.requestId });
      if (!updated) return false;
      await tx.insert(agentEvents).values({ sessionId: sessionRowId, event: { type: 'status', status: 'stopped' } });
      await tx.update(agentSessions).set({ status: 'idle', lastActivityAt: sql`now()`, updatedAt: sql`now()` }).where(eq(agentSessions.id, sessionRowId));
      return true;
    });
  }

  private async completeRunningStop(sessionRowId: string, requestId?: string, runId?: string | null) {
    return db.transaction(async tx => {
      if (requestId) {
        const [updated] = await tx.update(agentMessageRequests).set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(agentMessageRequests.sessionId, sessionRowId), eq(agentMessageRequests.requestId, requestId),
            eq(agentMessageRequests.status, 'running'), runId ? eq(agentMessageRequests.runId, runId) : undefined))
          .returning({ requestId: agentMessageRequests.requestId });
        if (!updated) return false;
      }
      const [updatedSession] = await tx.update(agentSessions).set({ status: 'idle', lastActivityAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(agentSessions.id, sessionRowId), eq(agentSessions.status, 'running'))).returning({ id: agentSessions.id });
      if (!updatedSession) {
        if (requestId) throw new Error('Session changed while stopping its running request');
        return false;
      }
      await tx.insert(agentEvents).values({ sessionId: sessionRowId, event: { type: 'status', status: 'stopped' } });
      return true;
    });
  }

  async cancel(userId: string, sessionId: string) {
    const session = await ownedSession(userId, sessionId);
    return this.manager.leases.withLock(sessionControlLock(sessionId), async () => {
      const execution = this.active.get(sessionId);
      if (execution) {
        execution.cancelling = true;
        if (!execution.started && await this.completeQueuedStop(execution.sessionRowId, execution.requestId)) {
          execution.controller.abort(new Error('Run cancelled'));
          return { ok: true };
        }
        // Abort the reader only after the runtime confirms the session process has exited.
        await this.terminateExecution(userId, sessionId);
        execution.controller.abort(new Error('Run cancelled'));
        await this.completeRunningStop(execution.sessionRowId, execution.requestId, execution.runId);
        return { ok: true };
      }
      const [current] = await db.select({ status: agentSessions.status }).from(agentSessions).where(eq(agentSessions.id, session.id)).limit(1);
      if (!current || current.status !== 'running') return { ok: true };
      const [queued] = await db.select({ requestId: agentMessageRequests.requestId }).from(agentMessageRequests).where(and(
        eq(agentMessageRequests.sessionId, session.id), eq(agentMessageRequests.status, 'queued'),
      )).limit(1);
      if (queued) {
        const stopped = await this.completeQueuedStop(session.id, queued.requestId);
        if (stopped) {
          const abandonedRunId = await this.manager.leases.redis.get(mcpRunKey(sessionId));
          if (abandonedRunId) {
            try {
              await this.manager.mcp.revoke(userId, safeId(abandonedRunId));
              await this.manager.leases.redis.eval(clearMatchingKey, 1, mcpRunKey(sessionId), abandonedRunId);
            } catch (error) { this.log.error(error, 'Stopped queued message gateway grant will expire'); }
          }
          if (!await this.manager.leases.redis.exists(sessionLock(sessionId)))
            await this.manager.leases.clearBusy(userId, 'active-agent-tasks', sessionId);
          return { ok: true };
        }
      }
      const resumedExecution = this.active.get(sessionId);
      if (resumedExecution) {
        resumedExecution.cancelling = true;
        if (!resumedExecution.started && await this.completeQueuedStop(resumedExecution.sessionRowId, resumedExecution.requestId)) {
          resumedExecution.controller.abort(new Error('Run cancelled'));
          return { ok: true };
        }
        await this.terminateExecution(userId, sessionId);
        resumedExecution.controller.abort(new Error('Run cancelled'));
        await this.completeRunningStop(resumedExecution.sessionRowId, resumedExecution.requestId, resumedExecution.runId);
        return { ok: true };
      }
      const [invoked] = await db.select({ requestId: agentMessageRequests.requestId, runId: agentMessageRequests.runId })
        .from(agentMessageRequests).where(and(eq(agentMessageRequests.sessionId, session.id), eq(agentMessageRequests.status, 'running'))).limit(1);
      await this.terminateExecution(userId, sessionId);
      const stopped = await this.completeRunningStop(session.id, invoked?.requestId, invoked?.runId);
      if (stopped && !await this.manager.leases.redis.exists(sessionLock(sessionId)))
        await this.manager.leases.clearBusy(userId, 'active-agent-tasks', sessionId);
      return { ok: true };
    });
  }

  async recoverStale(userId?: string) {
    await this.retryPendingGrantCleanup();
    const condition = userId ? and(eq(agentSessions.status, 'running'), eq(agentSessions.userId, userId)) : eq(agentSessions.status, 'running');
    const sessions = await db.select().from(agentSessions).where(condition);
    for (const session of sessions) {
      try {
        if (await this.manager.leases.redis.exists(sessionLock(session.dshSessionId))) continue;
        await this.manager.leases.withLock(workspaceLock(session.workspaceId), () =>
          this.manager.leases.withLock(sessionControlLock(session.dshSessionId), async () => {
            if (await this.manager.leases.redis.exists(sessionLock(session.dshSessionId))) return;
            const [current] = await db.select().from(agentSessions).where(eq(agentSessions.id, session.id)).limit(1);
            if (!current || current.status !== 'running') return;
            const [queued] = await db.select().from(agentMessageRequests).where(and(
              eq(agentMessageRequests.sessionId, session.id), eq(agentMessageRequests.status, 'queued'),
            )).limit(1);
            if (queued) {
              // No /run invocation has been claimed yet. Clean up any abandoned
              // setup grant, then replay the durable outbox item with a new lease.
              const abandonedRunId = await this.manager.leases.redis.get(mcpRunKey(session.dshSessionId));
              if (abandonedRunId) {
                try {
                  await this.manager.mcp.revoke(session.userId, safeId(abandonedRunId));
                  await this.manager.leases.redis.eval(clearMatchingKey, 1, mcpRunKey(session.dshSessionId), abandonedRunId);
                } catch (error) { this.log.error(error, 'Abandoned pre-run gateway grant will expire'); }
              }
              const token = await this.manager.leases.acquire(sessionLock(session.dshSessionId));
              let admitted = false;
              try {
                await this.manager.admitActivity(session.userId, 'active-agent-tasks', session.dshSessionId, false);
                admitted = true;
                await this.manager.leases.renew(sessionLock(session.dshSessionId), token);
                this.startAcceptedExecution({ userId: session.userId, sessionId: session.dshSessionId, sessionRowId: session.id, requestId: queued.requestId, token }, session.workspaceId, queued.prompt);
              } catch (error) {
                if (admitted) await this.manager.leases.clearBusy(session.userId, 'active-agent-tasks', session.dshSessionId);
                await this.manager.leases.release(sessionLock(session.dshSessionId), token);
                throw error;
              }
              return;
            }
            // A running request may already have reached Runtime. Its /run API
            // has no idempotency token, so never invoke it again automatically.
            const [invoked] = await db.select().from(agentMessageRequests).where(and(
              eq(agentMessageRequests.sessionId, session.id), eq(agentMessageRequests.status, 'running'),
            )).limit(1);
            await this.terminateExecution(session.userId, session.dshSessionId);
            const interrupted = await db.transaction(async tx => {
              if (invoked) {
                const [updated] = await tx.update(agentMessageRequests).set({ status: 'failed', completedAt: new Date(), updatedAt: new Date() })
                  .where(and(eq(agentMessageRequests.sessionId, session.id), eq(agentMessageRequests.requestId, invoked.requestId), eq(agentMessageRequests.status, 'running'), eq(agentMessageRequests.runId, invoked.runId!)))
                  .returning({ requestId: agentMessageRequests.requestId });
                if (!updated) return false;
              }
              const [currentSession] = await tx.update(agentSessions).set({ status: 'error', lastActivityAt: sql`now()`, updatedAt: sql`now()` })
                .where(and(eq(agentSessions.id, session.id), eq(agentSessions.status, 'running'))).returning({ id: agentSessions.id });
              if (!currentSession) return false;
              await tx.insert(agentEvents).values([
                { sessionId: session.id, event: { type: 'error', code: 'RUN_INTERRUPTED', message: 'Execution interrupted when its manager lease was lost. Your workspace files are preserved.' } },
                { sessionId: session.id, event: { type: 'status', status: 'error' } },
              ]);
              return true;
            });
            if (interrupted) await this.manager.leases.clearBusy(session.userId, 'active-agent-tasks', session.dshSessionId);
            const runId = invoked?.runId ?? await this.manager.leases.redis.get(mcpRunKey(session.dshSessionId));
            if (runId) {
              try {
                if (invoked) await this.revokeRecordedGrant(session.userId, session.dshSessionId, session.id, invoked.requestId, runId);
                else {
                  await this.manager.mcp.revoke(session.userId, safeId(runId));
                  await this.manager.leases.redis.eval(clearMatchingKey, 1, mcpRunKey(session.dshSessionId), runId);
                }
              } catch (error) { this.log.error(error, `MCP grant cleanup deferred for ${session.dshSessionId}`); }
            }
          }));
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
