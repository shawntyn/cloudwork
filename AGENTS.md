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
- `pnpm db:generate` / `pnpm db:migrate`: generate/apply Drizzle migrations.
- `docker compose config --quiet`: validate Compose configuration.
- `docker compose up -d --build`: build and start the complete platform.

Initially copy `.env.example` to `.env`; configure credentials and an absolute `USER_DATA_ROOT`. Preserve existing configuration during routine work.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, and semicolons. Match surrounding formatting: backend code generally uses two spaces and single quotes; existing React components use four spaces and double quotes. Use kebab-case filenames, PascalCase components/types, and camelCase functions/variables. No repository formatter or linter is configured. For Web changes, follow `apps/web/AGENTS.md` and consult the installed Next.js documentation.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`, executed through `tsx`; name files `*.test.ts`. No numeric coverage threshold exists. Add behavioral regression tests for ownership, path safety, lifecycle, or streaming changes.

With Compose running, use `pnpm test:integration`. Use `EXPECT_LLM_SUCCESS=1 pnpm test:integration` to require real model/tool execution and incremental output. Tests retain disposable accounts and files. Record actual verification and limitations; visually check UI changes.

For MCP checks, the optional `mcp-test` Compose profile starts `mcp-fixture` at `http://mcp-fixture:4100/mcp`. Allow its exact origin and inspected Docker IP before testing; do not widen policy to a subnet. `MCP_FIXTURE_TOKEN` defaults to `local-mcp-fixture-test-token` for this fixture only. Verify tool discovery, workspace ownership, secret redaction, blank-edit credential retention, and revocation as well as an actual tool call. Follow the README fixture procedure.

## Commit & Pull Request Guidelines

Use imperative subjects, for example `Fix runtime lease renewal`. Keep changes focused. PRs should explain behavior, link relevant issues, list validation, disclose migration/configuration changes, and include screenshots for UI changes.

## Security & Configuration

Never commit secrets, `.data/`, `.cache/`, or generated `artifacts/`. Only runtime-manager may access Docker. Preserve ownership checks, path containment, sandbox enforcement, and resource limits. Runtime removal must preserve user directories. Follow README image-refresh instructions when changing Runtime code or provider configuration.

User-code sandboxes remain offline. MCP upstream credentials belong only to gateway and encrypted PostgreSQL storage; do not place them in public responses, logs, user HOME, or Runtime environment. Runtime receives scoped per-run gateway grants. Each new message snapshots connection settings; disabling/deleting/unbinding revokes access. First-version MCP supports Streamable HTTP tools with none, bearer, or custom-header authentication; do not silently add OAuth, stdio, resources, or prompts.

Generate independent `MCP_GATEWAY_ADMIN_TOKEN` and `MCP_ENCRYPTION_KEY` values with `openssl rand -hex 32`; retain and securely back up the encryption key with database recovery procedures. `MCP_ALLOWED_ORIGINS` is a comma-separated exact-origin allowlist. `MCP_ALLOWED_PRIVATE_IPS` accepts explicit IPs only, never ranges; loopback and link-local remain blocked. Gateway has no Docker socket. Updating Runtime code still requires a fresh `RUNTIME_IMAGE` tag/build, then Remove and Start existing user containers while preserving HOME/workspace data.
