import assert from 'node:assert/strict';
import test from 'node:test';
import {
  connectionResponseSchema,
  createConnectionSchema,
  publicMcpResponse,
  updateConnectionSchema,
  workspaceMcpSchema,
} from './mcp';

test('MCP requests reject transport overrides, unsafe URLs and header injection', () => {
  const valid = { serverName: 'team_tools', name: 'Team tools', url: 'https://tools.example/mcp', authType: 'none' };
  assert.equal(createConnectionSchema.safeParse(valid).success, true);
  for (const change of [
    { command: 'node server.js' },
    { transport: 'stdio' },
    { url: 'file:///tmp/server' },
    { url: 'https://user:password@tools.example/mcp' },
    { url: 'https://tools.example/mcp?token=secret' },
    { authType: 'headers', headers: { Authorization: 'Bearer value\r\nHost: other.example' } },
    { authType: 'headers', headers: { 'Invalid header': 'secret' } },
    { authType: 'headers', headers: { Host: 'other.example' } },
    { authType: 'headers', headers: { 'X-Key': 'one', 'x-key': 'two' } },
    { authType: 'bearer', token: '' },
    { authType: 'headers', headers: {} },
  ]) assert.equal(createConnectionSchema.safeParse({ ...valid, ...change }).success, false);
});

test('MCP input limits match gateway limits', () => {
  const valid = { serverName: 'team_tools', name: 'Team tools', url: 'https://tools.example/mcp', authType: 'bearer' };
  assert.equal(createConnectionSchema.safeParse({ ...valid, token: 'x'.repeat(4096) }).success, true);
  assert.equal(createConnectionSchema.safeParse({ ...valid, token: 'x'.repeat(4097) }).success, false);
  const headers = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`X-Header-${index}`, 'value']));
  assert.equal(createConnectionSchema.safeParse({ ...valid, authType: 'headers', headers }).success, false);
  delete headers['X-Header-16'];
  assert.equal(createConnectionSchema.safeParse({ ...valid, authType: 'headers', headers }).success, true);
  const connectionIds = Array.from({ length: 17 }, (_, index) => `mcp_${index}`);
  assert.equal(workspaceMcpSchema.safeParse({ connectionIds }).success, false);
  assert.equal(workspaceMcpSchema.safeParse({ connectionIds: connectionIds.slice(0, 16) }).success, true);
});

test('MCP callable names are required, bounded and immutable; display names can be omitted or cleared', () => {
  const valid = { serverName: 'sales_prod', url: 'https://tools.example/mcp', authType: 'none' };
  assert.equal(createConnectionSchema.parse(valid).name, undefined);
  assert.equal(createConnectionSchema.parse({ ...valid, name: '   ' }).name, '');
  assert.equal(createConnectionSchema.parse({ ...valid, name: '  销售数据库  ' }).name, '销售数据库');
  for (const serverName of ['a', '1', '_', 'a'.repeat(24)]) {
    assert.equal(createConnectionSchema.safeParse({ ...valid, serverName }).success, true);
  }
  for (const serverName of [undefined, '', '   ', 'Sales', 'sales-prod', 'sales.prod', 'sales prod', '销售', 'a'.repeat(25), 'sales\nprod']) {
    assert.equal(createConnectionSchema.safeParse({ ...valid, serverName }).success, false, String(serverName));
  }
  for (const name of ['a'.repeat(101), 'bad\u0000label', 'bad\nlabel']) {
    assert.equal(createConnectionSchema.safeParse({ ...valid, name }).success, false);
  }
  assert.deepEqual(updateConnectionSchema.parse({ name: '   ' }), { name: '' });
  assert.equal(updateConnectionSchema.safeParse({ serverName: 'new_alias' }).success, false);
});

test('blank edited credentials are omitted so existing secrets survive', () => {
  const update = updateConnectionSchema.parse({ name: 'Renamed connection', token: '   ' });
  assert.equal(JSON.stringify(update), '{"name":"Renamed connection"}');
  assert.equal(updateConnectionSchema.safeParse({}).success, false);
  assert.equal(updateConnectionSchema.safeParse({ token: '' }).success, false);
  assert.equal(updateConnectionSchema.safeParse({ headers: {} }).success, false);
});

test('public MCP responses never forward stored or plaintext credentials', () => {
  const response = publicMcpResponse(connectionResponseSchema, {
    token: 'outer-token',
    connection: {
      id: 'mcp_fixture', name: 'Team tools', serverName: 'team_tools',
      url: 'https://tools.example/mcp', transport: 'streamable-http', authType: 'bearer',
      hasSecret: true, enabled: true, revision: 1,
      tools: [{ name: 'lookup', description: 'Look up a record', inputSchema: { private: true } }],
      lastTestStatus: 'ok', lastTestError: null, lastTestAt: '2026-09-20T00:00:00.000Z',
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
      token: 'plaintext-secret', headers: { Authorization: 'Bearer header-secret' },
      encryptedCredentials: 'ciphertext-secret',
    },
  });
  const serialized = JSON.stringify(response);
  for (const value of ['outer-token', 'plaintext-secret', 'header-secret', 'ciphertext-secret', 'inputSchema']) assert.equal(serialized.includes(value), false);
  assert.equal(response.connection.hasSecret, true);
  assert.throws(() => publicMcpResponse(connectionResponseSchema, { token: 'bad-response' }), error => error instanceof Error && 'status' in error && error.status === 503);
});

test('workspace bindings reject duplicate IDs and ownership spoofing fields', () => {
  assert.deepEqual(workspaceMcpSchema.parse({ connectionIds: [] }), { connectionIds: [] });
  assert.equal(workspaceMcpSchema.safeParse({ connectionIds: ['mcp_a', 'mcp_a'] }).success, false);
  assert.equal(workspaceMcpSchema.safeParse({ connectionIds: ['../../another-user'] }).success, false);
  assert.equal(workspaceMcpSchema.safeParse({ connectionIds: ['mcp_a'], userId: 'another-user' }).success, false);
});
