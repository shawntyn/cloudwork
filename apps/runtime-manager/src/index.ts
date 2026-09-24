import { Redis } from 'ioredis';
import { readConfig } from './config.js';
import { Leases } from './leases.js';
import { RuntimeManager } from './lifecycle.js';
import { Runs } from './runs.js';
import { startReaper } from './reaper.js';
import { createServer } from './server.js';
import { startLegacyEventBackfill } from './events.js';

const config = readConfig();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
redis.on('error', error => console.error('Manager Redis connection error:', error.message));
await new Promise<void>((resolve, reject) => { redis.once('ready', resolve); redis.once('error', reject); });
const leases = new Leases(redis, config.leaseMs);
const manager = new RuntimeManager(config, leases, console);
const runs = new Runs(manager, console);
const server = createServer(manager, runs);
await server.app.listen({ host: '0.0.0.0', port: config.port });
let closeReaper: (() => Promise<void>) | undefined;
let closeEventBackfill: (() => Promise<void>) | undefined;
try {
  await manager.initialize();
  await runs.recoverStale();
  closeReaper = await startReaper(manager, runs, console);
  server.setReady();
  closeEventBackfill = startLegacyEventBackfill(redis, console);
} catch (error) { server.setStartupError(error); }

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await closeEventBackfill?.();
  await closeReaper?.();
  await runs.shutdown();
  await server.app.close();
  await redis.quit();
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
