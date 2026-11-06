import test from 'node:test';
import assert from 'node:assert/strict';
import type Docker from 'dockerode';
import { networkSubnets, createPooledNetwork } from '../src/network-pool.ts';
test('network allocation stays within an aligned private pool and resolves collisions', async () => {
  const candidates = networkSubnets('desktop-a', '10.245.0.0/16');
  assert.equal(new Set(candidates).size, 64);
  assert.deepEqual(candidates, networkSubnets('desktop-a', '10.245.0.0/16'));
  assert.ok(candidates.every(c => c.startsWith('10.245.') && c.endsWith('/28')));
  for (const bad of ['0.0.0.0/0', '10.245.1.0/16', '10.300.0.0/16', '10.245.0.0/28', '127.0.0.0/16']) assert.throws(() => networkSubnets('test', bad));
  const attempts: Docker.NetworkCreateOptions[] = [];
  const docker = { createNetwork: async (options: Docker.NetworkCreateOptions) => { attempts.push(options); if (attempts.length===1) throw new Error('Pool overlaps with other one on this address space'); return { id: 'created' }; } } as unknown as Docker;
  await createPooledNetwork(docker, { Name: 'desktop-a', Internal: true, Labels: { owner: 'user-a' } }, '10.245.0.0/16');
  assert.equal(attempts.length, 2); assert.equal(attempts[1]?.IPAM?.Config?.[0]?.Subnet, candidates[1]);
  assert.equal(attempts[1]?.Internal, true); assert.equal(attempts[1]?.Labels?.owner, 'user-a');
});
