import { pgTable, text, timestamp, boolean, integer, jsonb, index, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
const dates = () => ({ createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull() });
export const users = pgTable('users', { id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(), emailVerified: boolean('email_verified').default(false).notNull(), image: text('image'), ...dates() });
export const sessions = pgTable('sessions', { id: text('id').primaryKey(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), token: text('token').notNull().unique(), ...dates(), ipAddress: text('ip_address'), userAgent: text('user_agent'), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }) }, t => [index('sessions_user_idx').on(t.userId)]);
export const accounts = pgTable('accounts', { id: text('id').primaryKey(), accountId: text('account_id').notNull(), providerId: text('provider_id').notNull(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), accessToken: text('access_token'), refreshToken: text('refresh_token'), idToken: text('id_token'), accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }), refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }), scope: text('scope'), password: text('password'), ...dates() }, t => [uniqueIndex('accounts_provider_idx').on(t.providerId,t.accountId), index('accounts_user_idx').on(t.userId)]);
export const verifications = pgTable('verifications', { id: text('id').primaryKey(), identifier: text('identifier').notNull(), value: text('value').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), ...dates() }, t => [index('verifications_identifier_idx').on(t.identifier)]);
export const workspaces = pgTable('workspaces', { id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), name: text('name').notNull(), path: text('path').notNull(), ...dates() }, t => [index('workspaces_user_idx').on(t.userId)]);
export const agentSessions = pgTable('agent_sessions', { id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), dshSessionId: text('dsh_session_id').notNull().unique(), status: text('status').default('idle').notNull(), ...dates() }, t => [index('agent_sessions_workspace_idx').on(t.workspaceId), index('agent_sessions_user_idx').on(t.userId)]);
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
