import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptSecret, encryptionKey, redactSecrets, secretContext, secureEqual, tokenHash } from '../src/crypto.ts';
import { DestinationPolicy, GatewayError } from '../src/policy.ts';
import { bindingInput, connectionInput, connectionPatch, parse, runInput } from '../src/validation.ts';

const key = encryptionKey('ab'.repeat(32));
const headers = { Authorization: 'Bearer upstream-private-test-key', 'X-Api-Key': 'other-upstream-test-key' };
const context = secretContext('user_a', 'mcp_a', 1);
const connection = { serverName: 'fixture', name: 'Fixture', url: 'https://mcp.example/mcp', authType: 'bearer' as const, token: 'upstream-private-test-key' };

test('credentials are randomized authenticated ciphertext scoped to user, connection, and revision', () => {
  const first = encryptSecret(headers, context, key);
  const second = encryptSecret(headers, context, key);
  assert.notEqual(first, second);
  assert.equal(first.includes(headers.Authorization), false);
  assert.deepEqual(decryptSecret(first, context, key), headers);
  assert.deepEqual(decryptSecret(null, context, key), {});
  for (const otherContext of [secretContext('user_b', 'mcp_a', 1), secretContext('user_a', 'mcp_b', 1), secretContext('user_a', 'mcp_a', 2)]) {
    assert.throws(() => decryptSecret(first, otherContext, key));
  }
  assert.throws(() => decryptSecret(first, context, encryptionKey('cd'.repeat(32))));
});

test('ciphertext rejects modified data and malformed envelope encodings', () => {
  const ciphertext = encryptSecret(headers, context, key);
  for (const index of [1, 2, 3]) {
    const parts = ciphertext.split('.');
    const bytes = Buffer.from(parts[index]!, 'base64url');
    bytes[0] = bytes[0]! ^ 1;
    parts[index] = bytes.toString('base64url');
    assert.throws(() => decryptSecret(parts.join('.'), context, key));
  }
  for (const malformed of ['', 'v1', 'v2.' + ciphertext.split('.').slice(1).join('.'), ciphertext + '.tampered', ciphertext + '.', ciphertext + '!']) {
    if (!malformed) continue; // null/empty storage represents a no-auth connection.
    assert.throws(() => decryptSecret(malformed, context, key), `reject malformed envelope ${malformed.slice(0, 12)}`);
  }
  for (const malformed of ['', 'ab', 'ab'.repeat(31), 'gg'.repeat(32)]) assert.throws(() => encryptionKey(malformed));
});

test('opaque grant hashes and timing-safe comparisons do not rely on plaintext storage', () => {
  const token = 'short-lived-grant-fixture';
  assert.match(tokenHash(token), /^[a-f0-9]{64}$/);
  assert.equal(tokenHash(token), tokenHash(token));
  assert.notEqual(tokenHash(token), tokenHash(token + 'x'));
  assert.equal(secureEqual(token, token), true);
  assert.equal(secureEqual(token, token + 'x'), false);
  assert.equal(secureEqual(token, 'x'.repeat(token.length)), false);
});

test('redaction removes full headers and bare credentials recursively without mutating input', () => {
  const original = { message: `Rejected ${headers.Authorization}`, nested: [{ token: 'upstream-private-test-key', key: headers['X-Api-Key'] }], count: 2, enabled: true, nullable: null };
  assert.deepEqual(redactSecrets(original, headers), { message: 'Rejected [redacted]', nested: [{ token: '[redacted]', key: '[redacted]' }], count: 2, enabled: true, nullable: null });
  assert.equal(original.nested[0]!.token, 'upstream-private-test-key');
});

test('redaction also covers credential-bearing keys and JSON-escaped upstream diagnostics', () => {
  const secret = 'quoted"and\\escaped-private-credential';
  const payload = { [secret]: { message: JSON.stringify({ credential: secret }) } };
  const redacted = redactSecrets(payload, { 'X-Api-Key': secret });
  assert.deepEqual(redacted, { '[redacted]': { message: '{"credential":"[redacted]"}' } });
});

test('destination URLs require the exact configured origin and forbid alternate schemes or authority', () => {
  const policy = new DestinationPolicy('https://MCP.Example,https://mcp.example:443,http://gateway.example:1234', '');
  assert.deepEqual(policy.allowedOrigins, ['https://mcp.example', 'http://gateway.example:1234']);
  assert.equal(policy.url('https://mcp.example/path/to/mcp').href, 'https://mcp.example/path/to/mcp');
  for (const url of ['http://mcp.example/mcp', 'https://mcp.example:444/mcp', 'https://sub.mcp.example/mcp', 'https://mcp.example.attacker.invalid/mcp', 'https://attacker.invalid/mcp', 'file:///etc/passwd', 'https://name:secret@mcp.example/mcp']) {
    assert.throws(() => policy.url(url), GatewayError);
  }
  assert.throws(() => new DestinationPolicy('https://mcp.example/path', ''));
});

test('URL and origin validation rejects all query/fragment markers and URL control characters', () => {
  const policy = new DestinationPolicy('https://mcp.example', '');
  for (const suffix of ['?', '#', '?key=secret', '#fragment']) {
    assert.throws(() => policy.url(`https://mcp.example/mcp${suffix}`));
    assert.throws(() => new DestinationPolicy(`https://mcp.example/${suffix}`, ''));
  }
  for (const url of ['https://mcp.exa\nmple/mcp', 'https://mcp.example/\tpath']) assert.throws(() => policy.url(url));
});

test('local control hostnames are forbidden even when accidentally present in the origin allowlist', () => {
  for (const host of ['localhost', 'api.localhost', 'host.docker.internal', 'gateway.docker.internal', 'metadata.google.internal']) {
    const policy = new DestinationPolicy(`http://${host}`, '127.0.0.1');
    assert.throws(() => policy.url(`http://${host}/mcp`), GatewayError);
  }
});

test('address policy denies private ranges unless exact addresses are explicitly allowed', () => {
  const policy = new DestinationPolicy('', '');
  assert.equal(policy.address('8.8.8.8'), '8.8.8.8');
  assert.equal(policy.address('2606:4700:4700::1111'), '2606:4700:4700::1111');
  for (const address of ['10.20.30.40', '172.16.0.1', '192.168.0.1', '100.64.0.1', 'fd00::1', '::ffff:10.20.30.40']) assert.throws(() => policy.address(address));
  const exact = new DestinationPolicy('', '10.20.30.40,fd00::1');
  assert.equal(exact.address('10.20.30.40'), '10.20.30.40');
  assert.equal(exact.address('::ffff:10.20.30.40'), '10.20.30.40');
  assert.equal(exact.address('fd00::1'), 'fd00::1');
  assert.throws(() => exact.address('10.20.30.41'));
  assert.throws(() => exact.address('fd00::2'));
  assert.equal(new DestinationPolicy('', '::ffff:10.20.30.40').address('10.20.30.40'), '10.20.30.40');
  assert.throws(() => new DestinationPolicy('', '10.0.0.0/8'));
});

test('loopback, link-local, unspecified, multicast and reserved addresses can never be allowed', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '169.254.169.254', 'fe80::1', '0.0.0.0', '::', '224.0.0.1', 'ff02::1', '255.255.255.255', '192.0.2.1']) {
    const policy = new DestinationPolicy('', address);
    assert.throws(() => policy.address(address), GatewayError, address);
  }
});

test('IPv4-mapped literal resolution returns the matching normalized socket family without DNS', async () => {
  const policy = new DestinationPolicy('http://[::ffff:a14:1e28]', '10.20.30.40');
  assert.deepEqual(await policy.resolve(policy.url('http://[::ffff:10.20.30.40]/mcp')), [{ address: '10.20.30.40', family: 4 }]);
});

test('connection validation rejects unknown capabilities, reserved headers and duplicate header casing', () => {
  assert.deepEqual(parse(connectionInput, connection), connection);
  for (const field of ['transport', 'command', 'args', 'env', 'plugins', 'userId']) assert.throws(() => parse(connectionInput, { ...connection, [field]: 'untrusted' }), GatewayError);
  for (const header of ['Host', 'Connection', 'Content-Length', 'Transfer-Encoding', 'Cookie', 'Set-Cookie', 'Proxy-Authorization', 'Forwarded', 'X-Forwarded-For', 'Accept', 'Content-Type', 'Mcp-Session-Id', 'Origin', 'Referer', 'Upgrade', 'TE', 'Trailer']) {
    assert.throws(() => parse(connectionInput, { serverName: 'fixture', url: connection.url, authType: 'headers', headers: { [header]: 'value' } }), GatewayError, header);
  }
  for (const supplied of [{}, { Authorization: 'a', authorization: 'b' }, { 'X-Key': 'line\nbreak' }, Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`X-Key-${index}`, 'value']))]) {
    assert.throws(() => parse(connectionInput, { serverName: 'fixture', url: connection.url, authType: 'headers', headers: supplied }));
  }
  assert.equal(parse(connectionInput, { serverName: 'fixture', url: connection.url, authType: 'headers', headers: { 'X-Api-Key': 'value' } }).authType, 'headers');
  assert.throws(() => parse(connectionPatch, {}));
  assert.throws(() => parse(connectionPatch, { command: 'node' }));
  assert.deepEqual(parse(connectionPatch, { enabled: false }), { enabled: false });
});

test('callable aliases are required, bounded and immutable while display names are optional', () => {
  const { name: _displayName, ...withoutDisplayName } = connection;
  assert.deepEqual(parse(connectionInput, withoutDisplayName), withoutDisplayName);
  for (const alias of ['a', '0', '_', 'sales_prod_2', 'a'.repeat(24)]) {
    assert.equal(parse(connectionInput, { ...connection, serverName: alias }).serverName, alias);
  }
  for (const alias of [undefined, null, '', 'Sales', 'sales-prod', 'sales.prod', 'sales prod', 'sales\nprod', 'sales_prod ', '销售', 'a'.repeat(25)]) {
    assert.throws(() => parse(connectionInput, { ...connection, serverName: alias }), GatewayError);
  }
  for (const name of ['', '   ']) assert.equal(parse(connectionInput, { ...connection, name }).name, '');
  assert.equal(parse(connectionInput, { ...connection, name: ' 销售数据库 ' }).name, '销售数据库');
  for (const name of [null, 'x'.repeat(101), 'sales\nprod', 'sales\0prod']) assert.throws(() => parse(connectionInput, { ...connection, name }), GatewayError);
  assert.deepEqual(parse(connectionPatch, { name: '   ' }), { name: '' });
  assert.deepEqual(parse(connectionPatch, { name: ' New display name ' }), { name: 'New display name' });
  for (const serverName of ['sales_prod', connection.serverName]) assert.throws(() => parse(connectionPatch, { name: 'Renamed', serverName }), GatewayError);
});

test('workspace bindings and run requests reject duplicates, excess entries and unowned input fields', () => {
  assert.deepEqual(parse(bindingInput, { connectionIds: ['mcp_a', 'mcp_b'] }), { connectionIds: ['mcp_a', 'mcp_b'] });
  assert.deepEqual(parse(bindingInput, { connectionIds: [] }), { connectionIds: [] });
  for (const value of [{ connectionIds: ['mcp_a', 'mcp_a'] }, { connectionIds: Array.from({ length: 17 }, (_, index) => `mcp_${index}`) }, { connectionIds: ['../mcp'] }, { connectionIds: [], userId: 'other' }]) assert.throws(() => parse(bindingInput, value));
  assert.deepEqual(parse(runInput, { workspaceId: 'ws_a', sessionId: 'sess_a' }), { workspaceId: 'ws_a', sessionId: 'sess_a' });
  assert.throws(() => parse(runInput, { workspaceId: 'ws_a', sessionId: 'sess_a', token: 'forged' }));
});
