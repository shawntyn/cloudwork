// Explicit invocation only: DATABASE_URL=... tsx --test test/store.integration.ts
// This file is intentionally excluded from the ordinary *.test.ts unit-test glob.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { db, sql, users, workspaces, agentSessions, mcpConnections, mcpRunGrants } from '@cloud-work/database';
import { DestinationPolicy, GatewayError } from '../src/policy.ts';
import { Store } from '../src/store.ts';

if (!process.env.DATABASE_URL) throw new Error('Explicit DATABASE_URL is required for the MCP store integration test');

class PausableStore extends Store {
  private pause?: { entered: () => void; released: Promise<void> };
  pauseNextWorkspace() {
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    this.pause = { entered, released };
    return { ready, release };
  }
  override async workspace(userId: string, id: string, tx?: Parameters<Store['workspace']>[2]) {
    const row = await super.workspace(userId, id, tx);
    const pause = this.pause;
    if (pause) { this.pause = undefined; pause.entered(); await pause.released; }
    return row;
  }
}

test('real PostgreSQL MCP store enforces tenant ownership, encrypted snapshots and revocation lifecycle', { timeout: 60_000 }, async () => {
  const suffix = randomUUID();
  const userA = `mcp_test_a_${suffix}`, userB = `mcp_test_b_${suffix}`;
  const workspaceA = `ws_a_${suffix}`, workspaceA2 = `ws_a2_${suffix}`, workspaceB = `ws_b_${suffix}`;
  const sessionA = `session_db_a_${suffix}`, sessionB = `session_db_b_${suffix}`;
  const dshA = `sess_a_${suffix}`, dshB = `sess_b_${suffix}`;
  const oldSecret = `old-upstream-${randomBytes(16).toString('hex')}`;
  const newSecret = `new-upstream-${randomBytes(16).toString('hex')}`;
  const closed: string[] = [];
  const store = new PausableStore(new DestinationPolicy('http://mcp-fixture:4100', ''), randomBytes(32), async ids => { closed.push(...ids); });
  const endpoint = 'http://mcp-fixture:4100/mcp';
  const rejectsStatus = (operation: Promise<unknown>, status: number) => assert.rejects(operation, error => error instanceof GatewayError && error.statusCode === status);
  const runId = () => `run_${randomUUID()}`;
  const grantId = (entry: { path: string }) => entry.path.split('/').at(-1)!;
  async function issue(run = runId()) {
    const issued = await store.issue(userA, run, workspaceA, dshA);
    assert.equal(issued.snapshot.connections.length, 1);
    const entry = issued.snapshot.connections[0]!;
    return { run, entry, id: grantId(entry) };
  }
  try {
    await db.insert(users).values([
      { id: userA, name: 'Disposable MCP test A', email: `${userA}@integration.invalid` },
      { id: userB, name: 'Disposable MCP test B', email: `${userB}@integration.invalid` },
    ]);
    await db.insert(workspaces).values([
      { id: workspaceA, userId: userA, name: 'MCP test A', path: `/test/${workspaceA}` },
      { id: workspaceA2, userId: userA, name: 'MCP test A second', path: `/test/${workspaceA2}` },
      { id: workspaceB, userId: userB, name: 'MCP test B', path: `/test/${workspaceB}` },
    ]);
    await db.insert(agentSessions).values([
      { id: sessionA, userId: userA, workspaceId: workspaceA, dshSessionId: dshA },
      { id: sessionB, userId: userB, workspaceId: workspaceB, dshSessionId: dshB },
    ]);

    const connection = await store.create(userA, { serverName: 'sales_prod', name: ' Credential fixture ', url: endpoint, authType: 'bearer', token: oldSecret });
    const foreign = await store.create(userB, { serverName: 'sales_prod', url: endpoint, authType: 'none' });
    assert.equal(connection.serverName, 'sales_prod');
    assert.equal(connection.name, 'Credential fixture');
    assert.match(connection.id, /^mcp_[a-f0-9-]{36}$/);
    assert.notEqual(connection.id, connection.serverName);
    assert.equal(foreign.serverName, connection.serverName, 'aliases are scoped to each user');
    assert.equal(foreign.name, '', 'omitted display names remain empty for the UI fallback');
    await assert.rejects(store.create(userA, { serverName: 'sales_prod', name: 'Different display name', url: endpoint, authType: 'none' }), error => error instanceof GatewayError && error.statusCode === 409 && error.message.includes('name already exists'));
    const concurrent = await Promise.allSettled(Array.from({ length: 2 }, () => store.create(userA, { serverName: 'sales_test', name: '   ', url: endpoint, authType: 'none' })));
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = concurrent.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof GatewayError && rejected.reason.statusCode === 409, 'concurrent duplicate creation returns a conflict');
    const blankDisplayName = concurrent.find(result => result.status === 'fulfilled');
    assert.ok(blankDisplayName?.status === 'fulfilled');
    assert.equal(blankDisplayName.value.name, '');
    assert.equal((await store.update(userA, blankDisplayName.value.id, { name: 'Temporary label' })).serverName, 'sales_test');
    assert.equal((await store.update(userA, blankDisplayName.value.id, { name: '   ' })).name, '');
    await store.remove(userA, blankDisplayName.value.id);
    const legacyId = `mcp_${randomUUID()}`;
    await db.insert(mcpConnections).values({ id: legacyId, userId: userA, name: 'Legacy display name', serverName: 'legacy-server-with-old-name', url: endpoint, authType: 'none' });
    const legacy = await store.update(userA, legacyId, { name: '' });
    assert.equal(legacy.serverName, 'legacy-server-with-old-name', 'older aliases remain valid when editing other fields');
    assert.equal(legacy.name, '');
    await store.remove(userA, legacyId);
    assert.equal(connection.hasSecret, true);
    assert.equal(foreign.hasSecret, false);
    const stored = await store.connection(userA, connection.id);
    assert.ok(stored.secretCiphertext?.startsWith('v1.'));
    assert.equal(stored.secretCiphertext!.includes(oldSecret), false);
    assert.deepEqual(store.headers(stored), { Authorization: `Bearer ${oldSecret}` });
    const visible = JSON.stringify({ connection, listing: await store.list(userA) });
    assert.equal(visible.includes(oldSecret), false);
    assert.equal(visible.includes('secretCiphertext'), false);
    assert.equal(visible.includes(foreign.id), false);
    await rejectsStatus(store.connection(userB, connection.id), 404);
    await rejectsStatus(store.update(userB, connection.id, { name: 'Stolen' }), 404);
    await rejectsStatus(store.remove(userB, connection.id), 404);
    await rejectsStatus(store.bind(userA, workspaceA, [foreign.id]), 404);
    await rejectsStatus(store.bind(userB, workspaceA, [foreign.id]), 404);
    await store.bind(userA, workspaceA, [connection.id]);
    assert.deepEqual((await store.bindings(userA, workspaceA)).enabledConnectionIds, [connection.id]);
    await rejectsStatus(store.issue(userA, runId(), workspaceA2, dshA), 404);
    await rejectsStatus(store.issue(userA, runId(), workspaceA, dshB), 404);
    await rejectsStatus(store.issue(userA, runId(), workspaceA, sessionA), 404); // runtime uses dshSessionId, not the database row ID.

    const original = await issue();
    await rejectsStatus(store.issue(userA, original.run, workspaceA, dshA), 409);
    await rejectsStatus(store.authorize(original.id, 'invalid-grant-token'), 401);
    const originalGrant = await store.authorize(original.id, original.entry.token);
    assert.equal(original.entry.id, connection.id);
    assert.equal(original.entry.serverName, 'sales_prod');
    assert.equal(originalGrant.connectionId, connection.id);
    assert.equal(originalGrant.serverName, 'sales_prod');
    assert.equal(originalGrant.sessionId, sessionA);
    assert.equal(originalGrant.userId, userA);
    assert.equal(originalGrant.tokenHash.includes(original.entry.token), false);
    assert.equal(JSON.stringify(original.entry).includes(oldSecret), false);

    await rejectsStatus(store.update(userA, connection.id, { serverName: 'sales_test' }), 400);
    assert.equal((await store.connection(userA, connection.id)).revision, 1, 'an attempted alias change must not mutate the connection');
    const renamed = await store.update(userA, connection.id, { name: 'Renamed fixture' });
    assert.equal(renamed.revision, 2);
    assert.equal(renamed.serverName, 'sales_prod');
    assert.equal(renamed.id, connection.id);
    assert.deepEqual(store.headers(await store.connection(userA, connection.id)), { Authorization: `Bearer ${oldSecret}` });
    const changed = await store.update(userA, connection.id, { token: newSecret, url: endpoint + '-changed' });
    assert.equal(changed.revision, 3);
    assert.deepEqual(store.headers(await store.connection(userA, connection.id)), { Authorization: `Bearer ${newSecret}` });
    const preserved = await store.authorize(original.id, original.entry.token);
    assert.equal(preserved.revision, 1);
    assert.equal(preserved.url, endpoint);
    assert.deepEqual(store.grantHeaders(preserved), { Authorization: `Bearer ${oldSecret}` });
    const replacement = await issue();
    const replacementGrant = await store.authorize(replacement.id, replacement.entry.token);
    assert.equal(replacementGrant.revision, 3);
    assert.equal(replacement.entry.serverName, 'sales_prod');
    assert.deepEqual(store.grantHeaders(replacementGrant), { Authorization: `Bearer ${newSecret}` });
    // A stale connection test must not overwrite metadata for a newer revision.
    await store.testResult(stored, [{ name: 'stale_tool' }], null);
    assert.deepEqual((await store.connection(userA, connection.id)).tools, []);
    const current = await store.connection(userA, connection.id);
    assert.equal((await store.testResult(current, [{ name: 'current_tool' }], null)).lastTestStatus, 'ok');

    await store.update(userA, connection.id, { enabled: false });
    await rejectsStatus(store.authorize(original.id, original.entry.token), 401);
    await rejectsStatus(store.authorize(replacement.id, replacement.entry.token), 401);
    assert.ok(closed.includes(original.id) && closed.includes(replacement.id));
    assert.deepEqual((await store.issue(userA, runId(), workspaceA, dshA)).snapshot.connections, []);
    await store.update(userA, connection.id, { enabled: true });
    const unbound = await issue();
    await store.bind(userA, workspaceA, []);
    await rejectsStatus(store.authorize(unbound.id, unbound.entry.token), 401);
    assert.ok(closed.includes(unbound.id));
    await store.bind(userA, workspaceA, [connection.id]);

    const revoked = await issue();
    await store.revoke(userB, revoked.run);
    await store.authorize(revoked.id, revoked.entry.token);
    await store.revoke(userA, revoked.run);
    await rejectsStatus(store.authorize(revoked.id, revoked.entry.token), 401);
    assert.ok(closed.includes(revoked.id));

    const expiring = await issue();
    const soon = new Date(Date.now() + 5000);
    await db.update(mcpRunGrants).set({ expiresAt: soon }).where(and(eq(mcpRunGrants.id, expiring.id), eq(mcpRunGrants.userId, userA)));
    await store.renew(userA, expiring.run);
    assert.ok((await store.authorize(expiring.id, expiring.entry.token)).expiresAt.getTime() > soon.getTime());
    const expired = new Date(Date.now() - 1000);
    await db.update(mcpRunGrants).set({ expiresAt: expired }).where(and(eq(mcpRunGrants.id, expiring.id), eq(mcpRunGrants.userId, userA)));
    await store.renew(userA, expiring.run);
    await rejectsStatus(store.authorize(expiring.id, expiring.entry.token), 401);
    const [expiredRow] = await db.select().from(mcpRunGrants).where(and(eq(mcpRunGrants.id, expiring.id), eq(mcpRunGrants.userId, userA)));
    assert.equal(expiredRow!.expiresAt.getTime(), expired.getTime());

    // Pause issue() after it owns the user row lock but before grant insertion.
    // revoke() must queue behind that transaction instead of missing uncommitted grants.
    const raceRun = runId();
    const gate = store.pauseNextWorkspace();
    const issuing = store.issue(userA, raceRun, workspaceA, dshA);
    await Promise.race([gate.ready, issuing.then(() => { throw new Error('Grant issuance unexpectedly bypassed the transaction gate'); })]);
    let revokeFinished = false;
    const revoking = store.revoke(userA, raceRun).then(() => { revokeFinished = true; });
    let race!: Awaited<ReturnType<Store['issue']>>;
    try { await delay(100); assert.equal(revokeFinished, false, 'revocation must wait for in-flight grant issuance'); }
    finally { gate.release(); [race] = await Promise.all([issuing, revoking]); }
    const raceEntry = race.snapshot.connections[0]!;
    await rejectsStatus(store.authorize(grantId(raceEntry), raceEntry.token), 401);
    assert.ok(closed.includes(grantId(raceEntry)));

    const removed = await issue();
    await store.remove(userA, connection.id);
    await rejectsStatus(store.authorize(removed.id, removed.entry.token), 401);
    await rejectsStatus(store.connection(userA, connection.id), 404);
    assert.ok(closed.includes(removed.id));
    assert.deepEqual((await store.bindings(userA, workspaceA)).enabledConnectionIds, []);
    assert.deepEqual(await db.select().from(mcpConnections).where(and(eq(mcpConnections.id, connection.id), eq(mcpConnections.userId, userA))), []);
  } finally {
    // Cascades remove only these generated users' fixtures; never sweep shared tables.
    try { await db.delete(users).where(inArray(users.id, [userA, userB])); }
    finally { await sql.end({ timeout: 5 }); }
  }
});
