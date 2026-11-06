import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { HttpError, safeId } from './config.js';

export const leaseKinds = ['active-agent-tasks', 'active-connections', 'foreground-commands', 'keepalive-jobs'] as const;
export type LeaseKind = typeof leaseKinds[number];
const RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const RENEW = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";
export const busyKey = (user: string, kind: LeaseKind) => `runtime:${safeId(user)}:${kind}`;

export class Leases {
  constructor(public redis: Redis, public ttlMs = 120_000) {}
  async acquire(key: string): Promise<string> {
    const token = randomUUID();
    if (await this.redis.set(key, token, 'PX', this.ttlMs, 'NX') !== 'OK') throw new HttpError(409, 'This operation is already active');
    return token;
  }
  async release(key: string, token: string) { await this.redis.eval(RELEASE, 1, key, token); }
  async renew(key: string, token: string) {
    if (Number(await this.redis.eval(RENEW, 1, key, token, this.ttlMs)) !== 1) throw new Error('Operation lock lost');
  }
  async setBusy(userId: string, kind: LeaseKind, id: string, ttlMs = this.ttlMs) {
    const key = busyKey(userId, kind);
    const result = await this.redis.multi().zadd(key, Date.now() + ttlMs, safeId(id)).pexpire(key, Math.max(ttlMs * 2, 86_400_000)).exec();
    if (!result || result.some(([error]) => error)) throw new Error('Failed to maintain runtime busy lease');
  }
  async clearBusy(userId: string, kind: LeaseKind, id: string) { await this.redis.zrem(busyKey(userId, kind), safeId(id)); }
  async isBusy(userId: string): Promise<boolean> {
    const now = Date.now();
    const pipeline = this.redis.multi();
    for (const kind of leaseKinds) pipeline.zremrangebyscore(busyKey(userId, kind), '-inf', now).zcard(busyKey(userId, kind));
    const result = await pipeline.exec();
    if (!result || result.some(([error]) => error)) throw new Error('Cannot determine runtime busy state');
    return result.some(([, count], index) => index % 2 === 1 && Number(count) > 0);
  }
  async withUserLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    return this.withLock(`runtime:${safeId(userId)}:lifecycle-lock`, operation);
  }
  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 180_000;
    let token: string;
    for (;;) {
      try { token = await this.acquire(key); break; }
      catch (error) {
        if (!(error instanceof HttpError) || Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    let lost: unknown;
    const heartbeat = setInterval(() => { void this.renew(key, token).catch(error => { lost = error; }); }, this.ttlMs / 4);
    heartbeat.unref();
    try {
      const result = await operation();
      if (lost) throw lost;
      await this.renew(key, token);
      return result;
    } finally {
      clearInterval(heartbeat);
      await this.release(key, token);
    }
  }
}
