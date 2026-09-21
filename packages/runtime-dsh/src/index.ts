import { DeepSeekHarness, type DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client';
import type { AgentRuntime } from '@cloud-work/runtime-core';
import type { AgentEvent, McpRunSnapshot } from '@cloud-work/protocol';
import { validateId } from '@cloud-work/workspace';
import { isAbsolute, join } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveDshProvider, dshProviderEnvironment, type DshProviderInput, type DshProviderConfiguration } from './provider.ts';
import { DshEventNormalizer } from './normalize.ts';
import { parseMcpRunSnapshot, prepareMcpRunOverlay, redactAgentEvent, runRedactor, type McpRunOverlay } from './mcp.ts';

export { DshEventNormalizer } from './normalize.ts';
export { parseMcpRunSnapshot } from './mcp.ts';

interface SessionState {
  workspacePath: string;
  harness?: DeepSeekHarness;
  active?: Promise<void>;
  cancelled: boolean;
  mcpOverlay?: McpRunOverlay;
  redact?: (message: string) => string;
}

/** Each execution owns its DSH subprocess, so termination never cancels another session. */
export class DshRuntime implements AgentRuntime {
  private readonly sessions = new Map<string, SessionState>();
  private readonly home: string;
  private readonly providerConfig: DshProviderConfiguration;
  private readonly apiKey: string;

  constructor(options: DshProviderInput & { home?: string; apiKey?: string } = {}) {
    this.home = options.home ?? process.env.HOME ?? '/home/work';
    this.providerConfig = resolveDshProvider({
      provider: options.provider ?? process.env.DSH_PROVIDER,
      model: options.model ?? process.env.DSH_MODEL,
      baseUrl: options.baseUrl ?? process.env.DSH_BASE_URL,
      contextWindow: options.contextWindow ?? process.env.DSH_CONTEXT_WINDOW,
      maxTokens: options.maxTokens ?? process.env.DSH_MAX_TOKENS,
    });
    this.apiKey = options.apiKey ?? process.env.DSH_API_KEY ?? '';
  }

  async createSession(input: { sessionId: string; workspacePath: string }): Promise<void> {
    validateId(input.sessionId);
    if (!input.sessionId.startsWith('sess_')) throw new Error('Invalid DSH session ID');
    if (!isAbsolute(input.workspacePath)) throw new Error('Workspace path must be absolute');
    const canonical = await realpath(input.workspacePath);
    if (canonical !== input.workspacePath || !(await stat(canonical)).isDirectory()) throw new Error('Workspace root must be a real directory');
    const previous = this.sessions.get(input.sessionId);
    if (previous) {
      if (previous.workspacePath !== canonical) throw new Error('Session workspace cannot change');
      return;
    }
    if (this.sessions.size >= 128) {
      const disposable = [...this.sessions].find(([, state]) => !state.active && !state.harness);
      if (!disposable) throw new Error('All session execution slots are busy');
      // Only in-memory handles are evicted; DSH's durable history is untouched.
      this.sessions.delete(disposable[0]);
    }
    this.sessions.set(input.sessionId, { workspacePath: canonical, cancelled: false });
    // DSH session(id) is a lazy handle: server-side durable creation occurs on first prompt.
  }

  private createHarness(state: SessionState): DeepSeekHarness {
    const env: NodeJS.ProcessEnv = {
      HOME: this.home,
      // DSH itself probes/spawns helpers: mutable HOME/workspace PATH entries must not shadow them.
      PATH: '/opt/workspace-python/bin:/usr/local/bin:/usr/bin:/bin:/app/packages/runtime-dsh/node_modules/.bin:/pnpm',
      CLOUD_WORK_TOOL_PATH: join(state.workspacePath, '.local', 'share', 'pnpm'),
      PNPM_HOME: join(state.workspacePath, '.local', 'share', 'pnpm'),
      USER: 'work', LOGNAME: 'work', LANG: 'C.UTF-8',
      TMPDIR: '/tmp', NODE_ENV: 'production',
      ...(process.env.COREPACK_HOME ? { COREPACK_HOME: process.env.COREPACK_HOME } : {}),
      COREPACK_DEFAULT_TO_LATEST: '0',
      // Stock DSH grants cwd and /tmp only. Keep tool caches in the persistent workspace.
      npm_config_cache: join(state.workspacePath, '.npm'),
      XDG_CACHE_HOME: join(state.workspacePath, '.cache'),
      XDG_DATA_HOME: join(state.workspacePath, '.local', 'share'),
      PIP_CACHE_DIR: join(state.workspacePath, '.cache', 'pip'),
      VIRTUAL_ENV: '/opt/workspace-python',
      PYTHONDONTWRITEBYTECODE: '1',
      PIP_NO_INDEX: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      ...dshProviderEnvironment(this.providerConfig, this.apiKey),
      ...state.mcpOverlay?.env,
      // Native sandbox helpers and subprocesses must never inherit RUNTIME_TOKEN or platform secrets.
    };
    const options: DeepSeekHarnessOptions = {
      profile: 'sdk',
      cwd: state.workspacePath,
      processCwd: state.workspacePath,
      dshHome: join(this.home, '.dsh'),
      provider: this.providerConfig.provider,
      model: this.providerConfig.model,
      ...(this.providerConfig.maxTokens !== undefined ? { maxTokens: this.providerConfig.maxTokens } : {}),
      env,
      initializeTimeoutMs: 60_000,
      shutdownTimeoutMs: 1_000,
      disposeEofGraceMs: 2_000,
      disposeGraceMs: 2_000,
      patches: [
        ...(this.providerConfig.gateway ? [fileURLToPath(new URL('./gateway.patch.yml', import.meta.url))] : []),
        ...(state.mcpOverlay ? [state.mcpOverlay.path] : []),
        fileURLToPath(new URL('../../../docker/runtime/cloud-work.patch.yml', import.meta.url)),
      ],
    };
    return new DeepSeekHarness(options);
  }

  async *run(input: { sessionId: string; prompt: string; mcp?: McpRunSnapshot }): AsyncIterable<AgentEvent> {
    const state = this.sessions.get(input.sessionId);
    if (!state) throw new Error('Session is not initialized');
    if (state.active) throw new Error('Session already has an active run');
    if (!input.prompt.trim()) throw new Error('Prompt cannot be empty');
    const snapshot = input.mcp === undefined ? undefined : parseMcpRunSnapshot(input.mcp);
    const redact = runRedactor([this.apiKey, ...(snapshot?.connections.map(connection => connection.token) ?? [])]);
    state.redact = redact;
    state.cancelled = false;
    const events: AgentEvent[] = [{ type: 'status', status: 'starting' }];
    let wake: (() => void) | undefined;
    let done = false;
    const enqueue = (event: AgentEvent) => {
      events.push(redactAgentEvent(event, redact));
      wake?.(); wake = undefined;
    };
    const normalizer = new DshEventNormalizer(input.sessionId);
    const execution = (async () => {
      try {
        if (!this.apiKey) throw new Error('DSH_API_KEY is not configured. Set a provider API key and restart this runtime.');
        if (snapshot) state.mcpOverlay = await prepareMcpRunOverlay(this.home, state.workspacePath, snapshot);
        if (state.cancelled) return;
        const harness = this.createHarness(state);
        state.harness = harness;
        await harness.run(input.prompt, {
          sessionId: input.sessionId,
          onNotification: notification => {
            for (const event of normalizer.normalize(notification)) enqueue(event);
          },
        });
      } catch (error) {
        if (!state.cancelled) {
          normalizer.failed = true;
          enqueue({ type: 'error', message: error instanceof Error ? error.message : 'DSH execution failed' });
        }
      } finally {
        try { await this.closeHarness(state); }
        catch (error) {
          const message = redact(error instanceof Error ? error.message : 'DSH subprocess teardown failed');
          enqueue({ type: 'error', message });
          // A failed teardown must close the transport WITHOUT a terminal status.
          // The manager then cancels, and force-stops the container if exit cannot be proved.
          done = true;
          wake?.(); wake = undefined;
          throw new Error(message);
        }
        enqueue({ type: 'status', status: normalizer.failed ? 'error' : state.cancelled ? 'stopped' : 'idle' });
        done = true;
        wake?.(); wake = undefined;
      }
    })();
    state.active = execution;
    void execution.catch(() => {}); // Observed below; prevent early unhandled rejection while draining events.
    try {
      while (!done || events.length > 0) {
        const event = events.shift();
        if (event) yield event;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally {
      if (!done) await this.cancel(input.sessionId);
      try { await execution; }
      finally { if (!state.harness) { state.active = undefined; state.redact = undefined; } }
    }
  }

  private async closeHarness(state: SessionState): Promise<void> {
    await state.harness?.close();
    state.harness = undefined;
    // Never unlink an overlay until the subprocess has actually exited.
    await state.mcpOverlay?.cleanup();
    state.mcpOverlay = undefined;
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state?.active) return;
    state.cancelled = true;
    // Published SDK has no mid-turn cancel RPC. close() waits through EOF/TERM/KILL to actual exit.
    try {
      await this.closeHarness(state);
      await state.active;
    } catch (error) {
      throw new Error(state.redact?.(error instanceof Error ? error.message : 'DSH cancellation failed') ?? 'DSH cancellation failed');
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.cancel(sessionId);
    await this.sessions.get(sessionId)?.harness?.close();
    this.sessions.delete(sessionId);
  }
}
