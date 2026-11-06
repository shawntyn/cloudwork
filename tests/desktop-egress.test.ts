import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
// @ts-expect-error runtime module is shared with the dependency-free egress image
const { destination } = await import('../docker/desktop/egress.mjs');

test('desktop proxy pins public DNS answers and rejects private, mixed and non-HTTP targets', async () => {
  const resolver = (addresses: string[]) => async () => addresses.map(address => ({ address, family: 4 }));
  assert.equal(await destination('example.org', 443, resolver(['93.184.216.34'])), '93.184.216.34');
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.17.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1']) await assert.rejects(destination('blocked.example', 443, resolver([ip])));
  await assert.rejects(destination('mixed.example', 80, resolver(['93.184.216.34', '127.0.0.1'])));
  await assert.rejects(destination('public.example', 22, resolver(['93.184.216.34'])));
});

test('intranet exception requires both exact origin and exact IP, never platform or loopback', async () => {
  const previous = { origins: process.env.DESKTOP_ALLOWED_ORIGINS, ips: process.env.DESKTOP_ALLOWED_PRIVATE_IPS, blocked: process.env.DESKTOP_BLOCKED_NETWORKS };
  process.env.DESKTOP_ALLOWED_ORIGINS = 'https://intranet.example:8443';
  process.env.DESKTOP_ALLOWED_PRIVATE_IPS = '192.168.20.10,127.0.0.1,172.18.0.5';
  process.env.DESKTOP_BLOCKED_NETWORKS = '172.18.0.0/16';
  try {
    const { destination } = await import('../docker/desktop/egress.mjs?intranet-test');
    const resolver = (address: string) => async () => [{ address, family: 4 }];
    assert.equal(await destination('intranet.example', 8443, resolver('192.168.20.10')), '192.168.20.10');
    await assert.rejects(destination('wrong.example', 8443, resolver('192.168.20.10')));
    await assert.rejects(destination('intranet.example', 8443, resolver('192.168.20.11')));
    await assert.rejects(destination('intranet.example', 8443, resolver('127.0.0.1')));
    await assert.rejects(destination('intranet.example', 8443, resolver('172.18.0.5')));
  } finally {
    for (const [key, value] of Object.entries({ DESKTOP_ALLOWED_ORIGINS: previous.origins, DESKTOP_ALLOWED_PRIVATE_IPS: previous.ips, DESKTOP_BLOCKED_NETWORKS: previous.blocked })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
