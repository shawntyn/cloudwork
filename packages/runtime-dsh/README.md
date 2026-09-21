# DSH runtime integration

Pinned upstream packages: `@deepseek-ai/dsh` and `@deepseek-ai/dsh-sdk-client` **0.1.5-rc.2**. The SDK npm `latest` tag still points at obsolete `0.0.1-rc.1`; do not replace the explicit version with that tag.

The adapter uses the published `DeepSeekHarness({ profile: 'sdk', cwd, processCwd, dshHome, patches, provider, model, env })`, `run(prompt, { sessionId, onNotification })` and `close()` APIs. The stock SDK creates durable sessions lazily at first prompt. Provider `deepseek` is an alias for the actual DSH route `deepseek-official`; `DSH_API_KEY` becomes `DEEPSEEK_API_KEY` only in the explicitly restricted DSH child environment. Runtime authentication and platform secrets are excluded from that child environment.

`session.event` envelopes are mapped from `assistant/chunk` / `text-delta`, `assistant/message`, `tool/call`, `tool/result`, and `turn/end`. Root text streams immediately; subagent tool activity is included with namespaced IDs. Assembled messages are fallback-only, so text is not duplicated. SDK `session.status idle` is withheld until process cleanup finishes.

## Persistence compatibility patch

The published SDK server has no session-resume RPC and calls `agents.create()` unconditionally in a new process, which rejects an existing persisted ID. `patches/dsh-sdk-jsonrpc-server-0.1.5-rc.2.patch` changes that one integration point to call the official `agents.resume({resumeSessionId,agentOptions})`, falling back to create **only** on `SessionPersistenceNotFoundError`. Corruption and ownership failures propagate; restored workspace mismatch is rejected. The patch is tracked in the pnpm lock and installed automatically. Remove it only after confirming upstream SDK provides equivalent resume behavior.

This does not implement an agent loop or a persistence format: DSH owns both. JSONL history, attachment storage and profile state remain in the mounted `/home/work/.dsh` directory. DSH resumes interrupted logs using its own recovery logic.

## Cancellation and process lifetime

The SDK does not expose a mid-turn cancel RPC. Each active session has its own subprocess. `cancel(sessionId)` awaits `close()`, whose published implementation requests shutdown then escalates through stdin EOF, SIGTERM and SIGKILL until the process exits. Completion also closes the subprocess before a terminal event is emitted. The next prompt resumes the same persistent session in a new subprocess.

Consequently SDK-managed background commands are scoped to the active turn and are terminated on completion. The MVP does not support detached jobs or keep-alive tasks surviving across turns. Other sessions are unaffected by an individual Stop. Runtime or browser disconnection also cancels the owned execution.

## Sandbox

The last deployment overlay pins `workspace-write` for the sandbox policy and leaves sandbox, bash-sandbox and fs-sandbox enabled. Approval policy `never` means deterministic rejection of escalation, not automatic approval. Even the danger-full-access preset is mapped to workspace-write. SDK telemetry is disabled.

The runtime startup uses DSH's functional probe sequence: bubblewrap first, then the official native Landlock helper. If neither confines commands, startup fails with `SANDBOX_UNAVAILABLE`; Docker isolation never switches DSH into unrestricted mode. Linux with Landlock enabled is required when Docker's default seccomp denies nested bubblewrap namespaces. No privileged mode, SYS_ADMIN capability or seccomp-unconfined setting is needed on a compatible host.

DSH's default workspace-write policy is a **write boundary**: reads outside the active workspace can remain available within the same user's container. Different users have separate mounts, containers and networks. POSIX file APIs additionally enforce workspace path boundaries and reject symlink traversal.

The prepared pnpm binary is shared read-only at `/opt/corepack`, with latest-version lookup disabled. Tool subprocesses use workspace-local `.npm`, `.cache` and `.local/share` paths for npm, Python and pnpm data caches, so ordinary package installation remains inside the granted write boundary and those files remain on the persistent workspace mount. The stock DSH policy does not expose an additional-writable-roots setting; the persistent HOME cache/config directories exist for host/profile state but are not granted wholesale to agent commands.
