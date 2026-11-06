# Repository Guidelines

## Project Structure & Module Organization

- `apps/web/`: Next.js pages, public API routes, SSE, React components, and assets such as `app/icon.svg`.
- `apps/runtime-manager/`: Docker lifecycle, Redis leases, and BullMQ cleanup.
- `apps/mcp-gateway/`: MCP connection storage, encrypted credentials, destination policy, per-run grants, and Streamable HTTP tool proxy. Web settings live at `/settings/mcp`; workspaces select connections in their toolbar dialog.
- `packages/`: authentication, Drizzle database/migrations, protocol types, workspace filesystem operations, and runtime adapters. Keep DSH SDK calls in `runtime-dsh`; consumers use `runtime-core` and `protocol`.
- `docker/`: platform images and user Runtime server/image. `scripts/` contains integration checks; `tests/` contains filesystem tests.

## Build, Test, and Development Commands

Use Node.js 24 and pnpm 11.21.0; commit dependency changes with `pnpm-lock.yaml`.

- `pnpm install --frozen-lockfile`: install locked dependencies and SDK patches.
- `pnpm dev`: run the Web development server; requires reachable database, Redis, and manager URLs.
- `pnpm typecheck`: check all workspace packages.
- `pnpm build`: build Next.js and validate other packages.
- `pnpm test`: run unit and SDK contract tests.
- `pnpm test:files`: exercise authenticated file transfer, preview, and editing against Compose.
- `pnpm db:generate` / `pnpm db:migrate`: generate/apply Drizzle migrations.
- `docker compose config --quiet`: validate Compose configuration.
- `docker compose up -d --build`: build and start the complete platform.

Initially copy `.env.example` to `.env`; configure credentials and an absolute `USER_DATA_ROOT`. Preserve existing configuration during routine work.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, and semicolons. Match surrounding formatting: backend code generally uses two spaces and single quotes; existing React components use four spaces and double quotes. Use kebab-case filenames, PascalCase components/types, and camelCase functions/variables. No repository formatter or linter is configured. For Web changes, follow `apps/web/AGENTS.md` and consult the installed Next.js documentation.

## Web Interaction & Localization

- The Web shell keeps workspace and conversation navigation on the left, the conversation in the center, and the file tree, preview, and editor in an on-demand right workbench. Narrow screens use accessible drawers. Preserve keyboard focus, Escape handling, and unsaved-edit confirmation; refresh expanded directories when an Agent run completes.
- A new conversation remains a client draft at `?draft=1` until its first message. Persisted conversations use `?session=<id>` links. Reuse only idle, unarchived sessions explicitly marked `confirmedBlank` with no first message; timestamps alone cannot prove an old session is empty. Do not delete ambiguous historical sessions to clean up navigation.
- Conversation title, first-message time, recent activity, pinning, and archiving live in `agent_sessions`; global search and metadata updates must keep the existing user and workspace ownership checks.
- Account theme and language preferences live in `users`, `/api/preferences`, and the server-rendered root layout. Preserve guest preferences before sign-in, the `system`/`light`/`dark` theme choices, and `auto`/`zh-CN`/`en` language choices. Automatic language follows browser priority for Chinese or English and otherwise defaults to Chinese. Use the semantic color variables in `apps/web/app/globals.css` for new UI.
- Translate new interface copy, dates, feedback, and accessibility labels through `useLocale` and stable API error codes. Keep user messages, Agent replies, file paths, and raw tool data in their original language.

## Message Submission & Recovery

- Each message send has a client-generated UUID. Keep the same `requestId` and trimmed prompt for transport retries and status checks; use a new ID when the user edits the prompt or intentionally starts another Agent run. Preserve the `crypto.getRandomValues` fallback because `crypto.randomUUID` may be unavailable on intranet HTTP origins. After an uncertain response, verify the request status before offering a safe retry.
- Runtime-manager owns message acceptance. The PostgreSQL `agent_message_requests` row, keyed by session and request ID, is the durable receipt; persist it atomically with the user event and session transition. Repeating the same ID and prompt returns the recorded outcome, while reusing an ID for different text returns `IDEMPOTENCY_KEY_CONFLICT`. Redis leases and SSE do not replace this durable record. Keep session and workspace ownership checks on status and submission routes.
- Recovery may resume a `queued` request that has not invoked Runtime. Once a request is claimed as `running`, Runtime's `/run` has no idempotency token: never invoke it automatically again after a manager crash. Preserve durable Stop results and retryable MCP grant cleanup.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`, executed through `tsx`; name files `*.test.ts`. No numeric coverage threshold exists. Add behavioral regression tests for ownership, path safety, lifecycle, or streaming changes.

With Compose running, use `pnpm test:integration`. Use `EXPECT_LLM_SUCCESS=1 pnpm test:integration` to require real model/tool execution and incremental output. Tests retain disposable accounts and files. Record actual verification and limitations; visually check UI changes.

For changes to navigation, themes, language, or the file workbench, check both themes and languages at desktop and phone sizes, keyboard access, draft/URL restoration, and unsaved edits. Use `pnpm test:files` for file-transfer or editing changes; its passing checks do not prove a live Agent run.

For message-submission changes, test same-ID retries, changed-text conflicts, ambiguous network responses, concurrent sends, and recovery of queued versus already invoked requests. Check sending from an intranet HTTP origin as well as localhost; a successful local send does not prove the intranet case.

For MCP checks, the optional `mcp-test` Compose profile starts `mcp-fixture` at `http://mcp-fixture:4100/mcp`. Allow its exact origin and inspected Docker IP before testing; do not widen policy to a subnet. `MCP_FIXTURE_TOKEN` defaults to `local-mcp-fixture-test-token` for this fixture only. Verify tool discovery, workspace ownership, secret redaction, blank-edit credential retention, and revocation as well as an actual tool call. Follow the README fixture procedure.

## Commit & Pull Request Guidelines

Use imperative subjects, for example `Fix runtime lease renewal`. Keep changes focused. PRs should explain behavior, link relevant issues, list validation, disclose migration/configuration changes, and include screenshots for UI changes.

## Security & Configuration

Never commit secrets, `.data/`, `.cache/`, or generated `artifacts/`. Only runtime-manager may access Docker. Preserve ownership checks, path containment, sandbox enforcement, and resource limits. Runtime removal must preserve user directories. Follow README image-refresh instructions when changing Runtime code or provider configuration.

User-code sandboxes remain offline. MCP upstream credentials belong only to gateway and encrypted PostgreSQL storage; do not place them in public responses, logs, user HOME, or Runtime environment. Runtime receives scoped per-run gateway grants. Each new message snapshots connection settings; disabling/deleting/unbinding revokes access. First-version MCP supports Streamable HTTP tools with none, bearer, or custom-header authentication; do not silently add OAuth, stdio, resources, or prompts.

Generate independent `MCP_GATEWAY_ADMIN_TOKEN` and `MCP_ENCRYPTION_KEY` values with `openssl rand -hex 32`; retain and securely back up the encryption key with database recovery procedures. `MCP_ALLOWED_ORIGINS` is a comma-separated exact-origin allowlist. `MCP_ALLOWED_PRIVATE_IPS` accepts explicit IPs only, never ranges; loopback and link-local remain blocked. Gateway has no Docker socket. Deploy Runtime changes with `docker compose up -d --build`: manager automatically refreshes the output image tag from its immutable deployment image and reconciles idle containers by image ID and configuration. Preserve activity admission under the lifecycle lock, upload-batch protection, ownership/mount checks, and HOME/workspace data. Do not require manual version bumps or user Remove/Start for upgrades. Use `pnpm test:lifecycle` for isolated real-Docker upgrade regression.
