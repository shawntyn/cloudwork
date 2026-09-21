import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import { db, users, workspaces, agentSessions, mcpConnections, workspaceMcpBindings, mcpRunGrants } from '@cloud-work/database';
import type { McpAuthType, McpConnectionInput, McpConnectionSummary } from '@cloud-work/protocol';
import { decryptSecret, encryptSecret, secretContext, tokenHash } from './crypto.ts';
import { DestinationPolicy, GatewayError } from './policy.ts';

type Connection = typeof mcpConnections.$inferSelect;
export type Grant = typeof mcpRunGrants.$inferSelect;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export function summary(row: Connection): McpConnectionSummary {
  return { id: row.id, name: row.name, serverName: row.serverName, url: row.url, transport: 'streamable-http', authType: row.authType as McpAuthType, hasSecret: Boolean(row.secretCiphertext), enabled: row.enabled, revision: row.revision, tools: row.tools, lastTestStatus: row.lastTestStatus as McpConnectionSummary['lastTestStatus'], lastTestError: row.lastTestError, lastTestAt: row.lastTestAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export class Store {
  constructor(readonly policy: DestinationPolicy, private key: Buffer, private closeGrants: (ids: string[]) => Promise<void>) {}
  private async locked<T>(userId: string, action: (tx: Transaction) => Promise<T>): Promise<T> {
    return db.transaction(async tx => {
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      if (!user) throw new GatewayError(404, 'User not found');
      return action(tx);
    });
  }
  async connection(userId: string, id: string, tx: typeof db | Transaction = db) {
    const [row] = await tx.select().from(mcpConnections).where(and(eq(mcpConnections.userId, userId), eq(mcpConnections.id, id)));
    if (!row) throw new GatewayError(404, 'MCP connection not found');
    return row;
  }
  async workspace(userId: string, id: string, tx: typeof db | Transaction = db) {
    const [row] = await tx.select().from(workspaces).where(and(eq(workspaces.userId, userId), eq(workspaces.id, id)));
    if (!row) throw new GatewayError(404, 'Workspace not found');
    return row;
  }
  async list(userId: string) {
    const rows = await db.select().from(mcpConnections).where(eq(mcpConnections.userId, userId)).orderBy(mcpConnections.createdAt);
    return { connections: rows.map(summary), policy: { allowedOrigins: this.policy.allowedOrigins } };
  }
  headers(row: Pick<Connection, 'userId' | 'id' | 'revision' | 'secretCiphertext'>) { return decryptSecret(row.secretCiphertext, secretContext(row.userId, row.id, row.revision), this.key); }
  grantHeaders(row: Grant) { return decryptSecret(row.secretCiphertext, secretContext(row.userId, row.connectionId, row.revision), this.key); }
  private credentials(input: Partial<McpConnectionInput>, authType: McpAuthType, existing?: Connection) {
    if (authType === 'none') {
      if (input.token || input.headers) throw new GatewayError(400, 'No-auth connections cannot include credentials');
      return {};
    }
    if (authType === 'bearer') {
      if (input.headers) throw new GatewayError(400, 'Bearer connections cannot include custom headers');
      if (input.token) return { Authorization: `Bearer ${input.token}` };
    } else {
      if (input.token) throw new GatewayError(400, 'Custom-header connections cannot include a bearer token');
      if (input.headers) return input.headers;
    }
    if (existing?.authType === authType && existing.secretCiphertext) return this.headers(existing);
    throw new GatewayError(400, 'Provide the connection credentials');
  }
  async create(userId: string, input: McpConnectionInput) {
    const url = this.policy.url(input.url).href;
    const headers = this.credentials(input, input.authType);
    return this.locked(userId, async tx => {
      const owned = await tx.select({ id: mcpConnections.id }).from(mcpConnections).where(eq(mcpConnections.userId, userId));
      if (owned.length >= 32) throw new GatewayError(409, 'Maximum 32 MCP connections per user');
      const id = `mcp_${randomUUID()}`, revision = 1;
      const [row] = await tx.insert(mcpConnections).values({ id, userId, name: input.name, serverName: `mcp_${randomBytes(10).toString('hex')}`, url, authType: input.authType, enabled: input.enabled ?? true, secretCiphertext: Object.keys(headers).length ? encryptSecret(headers, secretContext(userId, id, revision), this.key) : null }).returning();
      return summary(row!);
    });
  }
  async update(userId: string, id: string, input: Partial<McpConnectionInput>) {
    const result = await this.locked(userId, async tx => {
      const old = await this.connection(userId, id, tx);
      const authType = input.authType ?? old.authType as McpAuthType;
      const headers = this.credentials(input, authType, old), revision = old.revision + 1;
      const [row] = await tx.update(mcpConnections).set({ name: input.name ?? old.name, url: this.policy.url(input.url ?? old.url).href, authType, enabled: input.enabled ?? old.enabled, revision, secretCiphertext: Object.keys(headers).length ? encryptSecret(headers, secretContext(userId, id, revision), this.key) : null, tools: [], lastTestStatus: 'never', lastTestAt: null, lastTestError: null, updatedAt: new Date() }).where(eq(mcpConnections.id, id)).returning();
      const revoked = !row!.enabled ? await tx.delete(mcpRunGrants).where(eq(mcpRunGrants.connectionId, id)).returning({ id: mcpRunGrants.id }) : [];
      return { row: row!, ids: revoked.map(r => r.id) };
    });
    await this.closeGrants(result.ids);
    return summary(result.row);
  }
  async remove(userId: string, id: string) {
    const ids = await this.locked(userId, async tx => {
      await this.connection(userId, id, tx);
      const grants = await tx.select({ id: mcpRunGrants.id }).from(mcpRunGrants).where(eq(mcpRunGrants.connectionId, id));
      await tx.delete(mcpConnections).where(eq(mcpConnections.id, id));
      return grants.map(row => row.id);
    });
    await this.closeGrants(ids);
  }
  async bindings(userId: string, workspaceId: string) {
    await this.workspace(userId, workspaceId);
    const [list, bindings] = await Promise.all([this.list(userId), db.select().from(workspaceMcpBindings).where(and(eq(workspaceMcpBindings.userId, userId), eq(workspaceMcpBindings.workspaceId, workspaceId)))]);
    return { connections: list.connections, enabledConnectionIds: bindings.map(row => row.connectionId) };
  }
  async bind(userId: string, workspaceId: string, ids: string[]) {
    const revoked = await this.locked(userId, async tx => {
      await this.workspace(userId, workspaceId, tx);
      for (const id of ids) await this.connection(userId, id, tx);
      await tx.delete(workspaceMcpBindings).where(eq(workspaceMcpBindings.workspaceId, workspaceId));
      if (ids.length) await tx.insert(workspaceMcpBindings).values(ids.map(connectionId => ({ id: randomUUID(), userId, workspaceId, connectionId })));
      const grants = await tx.select().from(mcpRunGrants).where(and(eq(mcpRunGrants.userId, userId), eq(mcpRunGrants.workspaceId, workspaceId)));
      const removed = grants.filter(row => !ids.includes(row.connectionId)).map(row => row.id);
      if (removed.length) await tx.delete(mcpRunGrants).where(inArray(mcpRunGrants.id, removed));
      return removed;
    });
    await this.closeGrants(revoked);
    return this.bindings(userId, workspaceId);
  }
  async testResult(row: Connection, tools: Connection['tools'], error: string | null) {
    await db.update(mcpConnections).set({ tools, lastTestStatus: error ? 'error' : 'ok', lastTestError: error, lastTestAt: new Date(), updatedAt: new Date() }).where(and(eq(mcpConnections.id, row.id), eq(mcpConnections.revision, row.revision)));
    return summary(await this.connection(row.userId, row.id));
  }
  async issue(userId: string, runId: string, workspaceId: string, sessionId: string) {
    return this.locked(userId, async tx => {
      await this.workspace(userId, workspaceId, tx);
      const [session] = await tx.select().from(agentSessions).where(and(eq(agentSessions.dshSessionId, sessionId), eq(agentSessions.userId, userId), eq(agentSessions.workspaceId, workspaceId)));
      if (!session) throw new GatewayError(404, 'Session not found');
      const existing = await tx.select({ id: mcpRunGrants.id }).from(mcpRunGrants).where(and(eq(mcpRunGrants.userId, userId), eq(mcpRunGrants.runId, runId)));
      if (existing.length) throw new GatewayError(409, 'MCP run already exists');
      const rows = await tx.select({ connection: mcpConnections }).from(workspaceMcpBindings).innerJoin(mcpConnections, eq(workspaceMcpBindings.connectionId, mcpConnections.id)).where(and(eq(workspaceMcpBindings.userId, userId), eq(workspaceMcpBindings.workspaceId, workspaceId), eq(mcpConnections.userId, userId), eq(mcpConnections.enabled, true)));
      if (rows.length > 16) throw new GatewayError(409, 'Too many enabled MCP connections');
      const connections = [];
      for (const { connection: row } of rows) {
        this.policy.url(row.url);
        const id = `grant_${randomUUID()}`, token = randomBytes(32).toString('base64url');
        await tx.insert(mcpRunGrants).values({ id, tokenHash: tokenHash(token), userId, workspaceId, sessionId: session.id, runId, connectionId: row.id, revision: row.revision, serverName: row.serverName, url: row.url, secretCiphertext: row.secretCiphertext, expiresAt: new Date(Date.now() + 120_000) });
        connections.push({ id: row.id, serverName: row.serverName, path: `/mcp/${id}`, token });
      }
      return { snapshot: { runId, revision: randomUUID(), connections } };
    });
  }
  async authorize(id: string, token: string): Promise<Grant> {
    const [result] = await db.select({ grant: mcpRunGrants }).from(mcpRunGrants)
      .innerJoin(mcpConnections, and(eq(mcpConnections.id, mcpRunGrants.connectionId), eq(mcpConnections.userId, mcpRunGrants.userId), eq(mcpConnections.enabled, true)))
      .innerJoin(workspaceMcpBindings, and(eq(workspaceMcpBindings.connectionId, mcpRunGrants.connectionId), eq(workspaceMcpBindings.workspaceId, mcpRunGrants.workspaceId), eq(workspaceMcpBindings.userId, mcpRunGrants.userId)))
      .where(and(eq(mcpRunGrants.id, id), eq(mcpRunGrants.tokenHash, tokenHash(token)), gt(mcpRunGrants.expiresAt, new Date())));
    if (!result) throw new GatewayError(401, 'MCP run authorization has expired or was revoked');
    return result.grant;
  }
  async renew(userId: string, runId: string) {
    // Never resurrect expired or deleted grants. An empty run needs no grant.
    await db.update(mcpRunGrants).set({ expiresAt: new Date(Date.now() + 120_000), updatedAt: new Date() }).where(and(eq(mcpRunGrants.userId, userId), eq(mcpRunGrants.runId, runId), gt(mcpRunGrants.expiresAt, new Date())));
  }
  async revoke(userId: string, runId: string) {
    const rows = await this.locked(userId, tx => tx.delete(mcpRunGrants).where(and(eq(mcpRunGrants.userId, userId), eq(mcpRunGrants.runId, runId))).returning({ id: mcpRunGrants.id }));
    await this.closeGrants(rows.map(row => row.id));
  }
  async expire(cachedIds: string[] = []) {
    const rows = await db.delete(mcpRunGrants).where(lte(mcpRunGrants.expiresAt, new Date())).returning({ id: mcpRunGrants.id });
    await this.closeGrants(rows.map(row => row.id));
    if (cachedIds.length) {
      const live = new Set((await db.select({ id: mcpRunGrants.id }).from(mcpRunGrants).where(inArray(mcpRunGrants.id, cachedIds))).map(row => row.id));
      await this.closeGrants(cachedIds.filter(id => !live.has(id)));
    }
  }
}
