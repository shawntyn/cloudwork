# Implementation contract

Next.js combines public API and web. Only runtime-manager accesses Docker. Internal calls require `Authorization: Bearer ${MANAGER_TOKEN}`. User runtimes require distinct per-user derived tokens, never the manager token. Public API derives userId from Better Auth and checks DB ownership before calling manager.

Shared TypeScript source packages use ESM, exports `./src/index.ts`, `tsc --noEmit`, runtime via `tsx`. Root owns packages/database, auth, workspace, protocol, runtime-core, root package/config, Compose, platform Dockerfile, public API, tests and README. UI agent owns apps/web client pages/components/CSS and Next config/package. Manager agent owns apps/runtime-manager. DSH agent owns packages/runtime-dsh and docker/runtime (runtime HTTP server + image).

## Shared contracts

`@cloud-work/database`: exports db (Drizzle postgres-js), users, sessions, accounts, verifications, workspaces, agentSessions, runtimeInstances and schema. All timestamps are Date. workspaces: id,userId,name,path,createdAt,updatedAt. agentSessions: id,userId,workspaceId,dshSessionId,status,createdAt,updatedAt. runtimeInstances: id,userId,containerId(nullable),containerName,status,hostId,lastActiveAt,stoppedAt(nullable),createdAt,updatedAt. Runtime status strings STARTING/RUNNING/IDLE/STOPPED/REMOVED/ERROR. Unique userId runtime row.

`@cloud-work/protocol`: AgentEvent union specified by user plus `{type:'user-message',text:string}` for platform history. `RuntimeStatus`, `FileEntry {name,path,type:'file'|'directory'|'symlink',size:number}`. Public SSE frames replayed from the event journal have `id: <redis-id>` and `data: <AgentEvent JSON>`. Runtime-to-manager SSE carries AgentEvent data without Redis IDs; heartbeat comments and transient connection errors are not journal entries.

`@cloud-work/runtime-core`: AgentRuntime createSession({sessionId,workspacePath}), run({sessionId,prompt}): AsyncIterable<AgentEvent>, cancel(sessionId), destroySession(sessionId).

`@cloud-work/workspace`: `workspacePath(workspaceId)`; `validateId(id)`; `listFiles(root,relative='')`, `readFileContent(root,relative)`, `writeFileContent(root,relative,content)`, `makeDirectory(root,relative)`, `renameEntry(root,from,to)`, `deleteEntry(root,relative)`. These are async safe POSIX operations (reject symlinks and traversal), file contents UTF-8 strings. Root itself never deleted by file API. Uses workspace root in runtime. id accepts safe alphanumeric, underscore, hyphen max 100 chars.

## Manager HTTP on 4000

GET /health (no auth; readiness)
POST /internal/users/:userId/ensure -> runtime DB row
GET /internal/users/:userId/status -> runtime row or {status:'REMOVED'}
POST /internal/users/:userId/stop; POST .../remove; POST .../touch
POST /internal/users/:userId/workspaces/:workspaceId -> ensure runtime + mkdir workspace
DELETE /internal/users/:userId/workspaces/:workspaceId -> remove workspace files, refuse active runs
GET /internal/users/:userId/workspaces/:workspaceId/files?path= -> {entries:FileEntry[]}
GET /internal/users/:userId/workspaces/:workspaceId/files/content?path= -> {content:string}
PUT /internal/users/:userId/workspaces/:workspaceId/files/content {path,content}
POST /internal/users/:userId/workspaces/:workspaceId/files {operation:'mkdir',path} OR {operation:'rename',path,to}
DELETE /internal/users/:userId/workspaces/:workspaceId/files?path=
POST /internal/users/:userId/sessions/:sessionId {workspaceId} -> ensure runtime + create DSH session. sessionId is sess_<uuid> = dshSessionId.
POST /internal/users/:userId/sessions/:sessionId/messages {prompt} -> 202 after ownership checks, acquiring the session lease and recording the initial events; ensure+create session if needed and execute the streamed turn in the background. Single concurrent run per session. Publish normalized events (including user-message) with Redis XADD key `session:${sessionId}:events`, field `event`, MAXLEN ~ 10000, expiry 7 days. Update agentSessions.status running/idle/error. Root public SSE reads this stream from 0-0 or Last-Event-ID. Execution errors produce a terminal status; if Redis cannot persist it or execution termination is uncertain, preserve running metadata for stale-run recovery. Runtime network stream ends on terminal status or closed response.
POST /internal/users/:userId/sessions/:sessionId/cancel -> cancel runtime run, publish stopped terminal event via background reader. Busy release only after execution exits.
POST /internal/users/:userId/leases/:kind/:leaseId {ttlMs?} -> register or renew a finite `foreground-commands`, `keepalive-jobs` or `active-connections` lease; TTL 1 second to 24 hours, default 120 seconds.
DELETE /internal/users/:userId/leases/:kind/:leaseId -> release that lease. `active-agent-tasks` is maintained only by manager run execution.

Manager coordinates ensure/reap with a per-user distributed Redis lock, deterministic container name, ownership labels and per-user bind mounts. Workspace operations use a separate distributed lock; deletion refuses running sessions and records a tombstone to prevent a concurrent launch from recreating deleted files before the public API removes metadata. Runtime HTTP listens on internal port 3080; no user container publishes host ports. Manual stop/remove refuses active work. Stop retains the container and networks; remove deletes the container and its dedicated control/egress networks while retaining every user data directory.

At manager startup, if the configured `RUNTIME_IMAGE` tag is absent, inspect the manager container's immutable image ID and build a small derived image through Docker Engine `buildImage`. The temporary build context contains only the generated Dockerfile from `apps/runtime-manager/src/runtime-image.ts`. Its `FROM sha256:<manager-image-id>` reuses the toolchain, locked dependencies and source already installed by Compose; it does not run apt or pnpm install again. The layer typechecks the runtime server, prepares `/home/work`, uses UID/GID 1000, readable Corepack cache `/opt/corepack`, per-user `PNPM_HOME`, tini and an absolute tsx loader/server command. The image records `cloud-work.runtime-source-image`; Compose-injected container secrets are not copied into it. Existing image tags and existing containers are not automatically refreshed. `docker/runtime/Dockerfile` remains the standalone build path; there is no packaged source-context bootstrap, static Compose runtime service or nested Docker daemon.

All user containers join the `cloud-runtime` internal bridge with `com.docker.network.bridge.enable_icc=false`. Each user also receives a dedicated internal control network shared only with manager and a separate egress bridge with higher gateway priority. Names use the first 24 SHA-256 hex characters of userId. The control-only Docker DNS alias `cloud-work-control-<hash>` resolves to that user's control endpoint, avoiding ambiguity from the container name present on multiple networks. Manager targets `http://<control-alias>:3080` after Docker inspect confirms ownership, running state, network membership and the alias. Runtime containers never join the platform database/Redis network.

BullMQ scans runtime activity and Redis busy state on the configured interval. Agent/session leases last 120 seconds and renew every 20 seconds; finite file/session setup requests also hold activity leases, but passive browser SSE does not. Idle stop and stopped-container removal require no busy leases and no running session metadata. Redis failures abort recycling rather than treating unknown state as idle. Stale-run recovery waits for an expired session lease, terminates the orphaned execution, records an error terminal event and preserves files. If session cancellation cannot confirm termination, manager stops that user's container, which can interrupt its other sessions.

## Runtime HTTP on 3080

Use same suffix routes without `/internal/users/:userId`: GET /health, POST/DELETE /workspaces/:workspaceId, file endpoints above; POST /sessions/:sessionId {workspaceId}; POST /sessions/:sessionId/run {prompt} responds SSE AgentEvent until complete; POST /sessions/:sessionId/cancel. Validate all IDs and inputs even internal. Health requires runtime token too. Runtime token `RUNTIME_TOKEN` and an explicit allowlist of DSH provider/model/key/base URL/token limits; NO database/redis/manager secrets. Bind user HOME=/home/work, workspaces=/home/work/workspaces. Keep DSH sandbox enabled and fail if unavailable. Per-session termination fallback allowed.

Compatible providers use `DSH_PROVIDER=openai-compatible|anthropic-compatible`, `DSH_BASE_URL`, an exact `DSH_MODEL`, `DSH_API_KEY`, and optional `DSH_CONTEXT_WINDOW` / `DSH_MAX_TOKENS`. The adapter registers the model on DSH's installed llm-pi-ai plugin under internal route `cloud-work-gateway`; platform callers never import this plugin or its wire types. Key material is referenced from the child environment and not written into profile patches. The original native DeepSeek route remains supported.

## Public API and UI

Better Auth /api/auth/* email/password. GET/POST /api/workspaces -> {workspaces:[...]} / {workspace}. GET/DELETE /api/workspaces/:id -> {workspace,runtime} / {ok:true}. All workspace GET detail ensures runtime and directory.
File endpoints match specification + POST /api/workspaces/:id/files for mkdir/rename (proxy manager).
GET /api/workspaces/:id/sessions -> {sessions:[...]}; POST same -> {session}. GET /api/runtime -> {runtime}; POST /api/runtime {action:'start'|'stop'|'remove'}.
POST /api/sessions/:sessionId/messages {prompt} -> {accepted:true}; GET .../events SSE; POST .../cancel. GET /api/sessions/:sessionId -> {session}.
All errors `{error:string}`, non-2xx. Dates serialized ISO. UI can use fetch Better Auth routes directly (sign-up/email, sign-in/email, get-session, sign-out). Session browser EventSource reconnect uses IDs, appends streaming assistant blocks, tools and user-message from event history; no frontend DSH imports. Prompt retained on send error. New session and list session switching supported.

## Environment

Compose supplies DATABASE_URL, REDIS_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL=http://localhost:3000, MANAGER_TOKEN, RUNTIME_MANAGER_URL=http://runtime-manager:4000, USER_DATA_ROOT=/data/cloud-work/users (same host + manager absolute path), RUNTIME_IMAGE=cloud-work-runtime:local, RUNTIME_NETWORK=cloud-runtime, MANAGER_CONTAINER_NAME=cloud-work-runtime-manager, RUNTIME_CPUS=2, RUNTIME_MEMORY_MB=4096, RUNTIME_PIDS_LIMIT=256, RUNTIME_IDLE_MINUTES=30, RUNTIME_REMOVE_HOURS=24, RUNTIME_REAPER_INTERVAL_MS=60000, DSH_PROVIDER=deepseek-official, DSH_MODEL=deepseek-v4-flash, DSH_API_KEY, RUNTIME_TOKEN_SECRET (manager only; derive per-user). The manager's provider/model fallbacks match these Compose defaults. `RUNTIME_BUILD_CONTEXT` is no longer used.

Root verification: pnpm install,typecheck,build,test; Docker compose config,build,up; real auth/workspace/runtime/files/isolation/stop/recreate/stream/cancel/reaper where provider key permits. Never fabricate real LLM success without a configured key.
