import { pgTable, text, timestamp, boolean, integer, bigint, jsonb, index, uniqueIndex, pgEnum, primaryKey } from 'drizzle-orm/pg-core';
const dates = () => ({ createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull() });
export const users = pgTable('users', { id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(), emailVerified: boolean('email_verified').default(false).notNull(), image: text('image'), uiTheme: text('ui_theme', { enum: ['system', 'light', 'dark'] }).default('system').notNull(), uiLocale: text('ui_locale', { enum: ['auto', 'zh-CN', 'en'] }).default('auto').notNull(), ...dates() });
export const sessions = pgTable('sessions', { id: text('id').primaryKey(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), token: text('token').notNull().unique(), ...dates(), ipAddress: text('ip_address'), userAgent: text('user_agent'), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }) }, t => [index('sessions_user_idx').on(t.userId)]);
export const accounts = pgTable('accounts', { id: text('id').primaryKey(), accountId: text('account_id').notNull(), providerId: text('provider_id').notNull(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), accessToken: text('access_token'), refreshToken: text('refresh_token'), idToken: text('id_token'), accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }), refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }), scope: text('scope'), password: text('password'), ...dates() }, t => [uniqueIndex('accounts_provider_idx').on(t.providerId,t.accountId), index('accounts_user_idx').on(t.userId)]);
export const verifications = pgTable('verifications', { id: text('id').primaryKey(), identifier: text('identifier').notNull(), value: text('value').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), ...dates() }, t => [index('verifications_identifier_idx').on(t.identifier)]);
export const workspaces = pgTable('workspaces', { id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), name: text('name').notNull(), path: text('path').notNull(), deletedAt: timestamp('deleted_at', { withTimezone: true }), purgeStartedAt: timestamp('purge_started_at', { withTimezone: true }), ...dates() }, t => [index('workspaces_user_idx').on(t.userId), index('workspaces_deleted_at_idx').on(t.deletedAt)]);
export const agentSessions = pgTable('agent_sessions', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  dshSessionId: text('dsh_session_id').notNull().unique(), status: text('status').default('idle').notNull(),
  title: text('title'), firstMessageAt: timestamp('first_message_at', { withTimezone: true }),
  confirmedBlank: boolean('confirmed_blank').default(false).notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
  pinnedAt: timestamp('pinned_at', { withTimezone: true }), archivedAt: timestamp('archived_at', { withTimezone: true }),
  eventsBackfilledAt: timestamp('events_backfilled_at', { withTimezone: true }),
  ...dates(),
}, t => [index('agent_sessions_workspace_idx').on(t.workspaceId), index('agent_sessions_user_idx').on(t.userId), index('agent_sessions_navigation_idx').on(t.userId, t.archivedAt, t.lastActivityAt)]);
export const messageRequestStatus = pgEnum('message_request_status', ['queued', 'running', 'completed', 'failed']);
export const agentMessageRequests = pgTable('agent_message_requests', {
  sessionId: text('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
  requestId: text('request_id').notNull(),
  prompt: text('prompt').notNull(),
  promptFingerprint: text('prompt_fingerprint').notNull(),
  status: messageRequestStatus('status').default('queued').notNull(),
  runId: text('run_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  mcpRevokedAt: timestamp('mcp_revoked_at', { withTimezone: true }),
  ...dates(),
}, t => [
  primaryKey({ columns: [t.sessionId, t.requestId] }),
  index('agent_message_requests_status_created_idx').on(t.status, t.createdAt),
  index('agent_message_requests_cleanup_idx').on(t.status, t.mcpRevokedAt),
]);
export const agentEvents = pgTable('agent_events', {
  sessionId: text('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
  streamMs: bigint('stream_ms', { mode: 'number' }).generatedByDefaultAsIdentity({ name: 'agent_events_stream_ms_seq', startWith: 1800000000000000 }),
  streamSeq: bigint('stream_seq', { mode: 'number' }).default(0).notNull(),
  event: jsonb('event').$type<Record<string, unknown>>().notNull(),
}, t => [primaryKey({ columns: [t.sessionId, t.streamMs, t.streamSeq] })]);
export const mcpConnections = pgTable('mcp_connections', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), serverName: text('server_name').notNull(), url: text('url').notNull(),
  authType: text('auth_type').notNull().default('none'), secretCiphertext: text('secret_ciphertext'),
  enabled: boolean('enabled').notNull().default(true), revision: integer('revision').notNull().default(1),
  tools: jsonb('tools').$type<Array<{ name: string; description?: string }>>().notNull().default([]),
  lastTestStatus: text('last_test_status').notNull().default('never'), lastTestError: text('last_test_error'),
  lastTestAt: timestamp('last_test_at', { withTimezone: true }), ...dates(),
}, t => [index('mcp_connections_user_idx').on(t.userId), uniqueIndex('mcp_connections_server_idx').on(t.userId, t.serverName)]);

export const workspaceMcpBindings = pgTable('workspace_mcp_bindings', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull().references(() => mcpConnections.id, { onDelete: 'cascade' }),
  ...dates(),
}, t => [uniqueIndex('workspace_mcp_binding_unique').on(t.workspaceId, t.connectionId), index('workspace_mcp_bindings_user_idx').on(t.userId)]);

export const mcpRunGrants = pgTable('mcp_run_grants', {
  id: text('id').primaryKey(), tokenHash: text('token_hash').notNull().unique(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(), connectionId: text('connection_id').notNull().references(() => mcpConnections.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(), serverName: text('server_name').notNull(), url: text('url').notNull(),
  secretCiphertext: text('secret_ciphertext'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), ...dates(),
}, t => [index('mcp_run_grants_run_idx').on(t.userId, t.runId), index('mcp_run_grants_expiry_idx').on(t.expiresAt)]);

export const runtimeStatus = pgEnum('runtime_status', ['STARTING','RUNNING','IDLE','STOPPED','REMOVED','ERROR']);
export const runtimeInstances = pgTable('runtime_instances', { id: text('id').primaryKey(), userId: text('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }), containerId: text('container_id'), containerName: text('container_name').notNull().unique(), status: runtimeStatus('status').default('REMOVED').notNull(), hostId: text('host_id').default('local').notNull(), lastActiveAt: timestamp('last_active_at', { withTimezone: true }).defaultNow().notNull(), stoppedAt: timestamp('stopped_at', { withTimezone: true }), ...dates() }, t => [index('runtime_reaper_idx').on(t.status,t.lastActiveAt)]);
