import { createHash } from 'node:crypto';
import type Docker from 'dockerode';

export function networkSubnets(name: string, pool: string): string[] {
  const match = /^(10)\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{2})$/.exec(pool);
  if (!match) throw new Error('Network pool must be an aligned private 10.x IPv4 CIDR (/16 through /24)');
  const octets = match.slice(1, 5).map(Number), bits = Number(match[5]);
  if (octets.some(v => v > 255) || bits < 16 || bits > 24) throw new Error('Invalid network pool');
  const base = octets.reduce((v, byte) => v * 256 + byte, 0), size = 2 ** (32 - bits);
  if (base % size) throw new Error('Network pool must be CIDR-aligned');
  const count = size / 16, offset = createHash('sha256').update(name).digest().readUInt32BE() % count;
  return Array.from({ length: Math.min(count, 64) }, (_, index) => {
    const address = base + ((offset + index) % count) * 16;
    return [24, 16, 8, 0].map(shift => (address >>> shift) & 255).join('.') + '/28';
  });
}
export async function createPooledNetwork(docker: Docker, options: Docker.NetworkCreateOptions, pool?: string) {
  if (!pool) return docker.createNetwork(options);
  for (const subnet of networkSubnets(options.Name, pool)) {
    try { return await docker.createNetwork({ ...options, IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] } }); }
    catch (error) { if (!(error instanceof Error) || !/overlap|pool overlaps/i.test(error.message)) throw error; }
  }
  throw new Error('Configured network pool has no available candidate subnets');
}
