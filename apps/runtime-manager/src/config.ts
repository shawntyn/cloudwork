import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new HttpError(400, 'Invalid identifier');
  return value;
}

export function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function runtimeToken(userId: string, secret: string): string {
  return createHmac('sha256', secret).update(`cloud-work-runtime-v1:${safeId(userId)}`).digest('hex');
}

export function runtimeName(userId: string): string { return `cloud-work-runtime-${safeId(userId)}`; }
export function networkNames(userId: string) {
  const hash = createHash('sha256').update(safeId(userId)).digest('hex').slice(0, 24);
  return { control: `cloud-work-control-${hash}`, egress: `cloud-work-egress-${hash}` };
}
// A separate namespace avoids collisions with automatic container-name aliases
// on the shared runtime bridge. The hash preserves case-sensitive user identity.
export function runtimeControlAlias(userId: string): string { return networkNames(userId).control; }
export function mcpControlAlias(userId: string): string { return networkNames(userId).control.replace('cloud-work-control-', 'cloud-work-mcp-'); }

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0.01): number {
  const n = Number(env[name] ?? fallback);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number >= ${min}`);
  return n;
}

function optionalTokenLimit(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`${name} must be an integer between 1 and 2147483647`);
  }
  return value;
}

function optionalBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('DSH_BASE_URL must be an HTTP(S) URL without credentials, query or fragment'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || value.includes('?') || value.includes('#')) {
    throw new Error('DSH_BASE_URL must be an HTTP(S) URL without credentials, query or fragment');
  }
  return url.toString();
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  for (const key of ['DATABASE_URL', 'REDIS_URL', 'MANAGER_TOKEN', 'RUNTIME_TOKEN_SECRET']) {
    if (!env[key]) throw new Error(`${key} is required`);
  }
  if (env.MANAGER_TOKEN === env.RUNTIME_TOKEN_SECRET) throw new Error('MANAGER_TOKEN and RUNTIME_TOKEN_SECRET must differ');
  const dataRoot = env.USER_DATA_ROOT ?? '/data/cloud-work/users';
  if (!path.isAbsolute(dataRoot)) throw new Error('USER_DATA_ROOT must be an absolute host path, mounted at the same manager path');
  const baseUrl = optionalBaseUrl(env.DSH_BASE_URL);
  const contextWindow = optionalTokenLimit(env, 'DSH_CONTEXT_WINDOW');
  const maxTokens = optionalTokenLimit(env, 'DSH_MAX_TOKENS');
  if (contextWindow !== undefined && maxTokens !== undefined && maxTokens > contextWindow) {
    throw new Error('DSH_MAX_TOKENS must not exceed DSH_CONTEXT_WINDOW');
  }
  const mcpGatewayUrl = env.MCP_GATEWAY_URL?.trim() || 'http://mcp-gateway:4100';
  const gatewayUrl = new URL(mcpGatewayUrl);
  if (!['http:', 'https:'].includes(gatewayUrl.protocol) || gatewayUrl.username || gatewayUrl.password || gatewayUrl.pathname !== '/' || mcpGatewayUrl.includes('?') || mcpGatewayUrl.includes('#')) {
    throw new Error('MCP_GATEWAY_URL must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  const mcpGatewayAdminToken = env.MCP_GATEWAY_ADMIN_TOKEN ?? '';
  if (mcpGatewayAdminToken && (mcpGatewayAdminToken.length < 32 || [env.MANAGER_TOKEN, env.RUNTIME_TOKEN_SECRET].includes(mcpGatewayAdminToken))) {
    throw new Error('MCP_GATEWAY_ADMIN_TOKEN must contain at least 32 characters and differ from other service secrets');
  }
  return {
    port: numberEnv(env, 'PORT', 4000, 1),
    redisUrl: env.REDIS_URL!, managerToken: env.MANAGER_TOKEN!, tokenSecret: env.RUNTIME_TOKEN_SECRET!,
    dataRoot: path.resolve(dataRoot), dockerSocket: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    managerContainer: env.MANAGER_CONTAINER_NAME ?? 'cloud-work-runtime-manager',
    mcpGatewayUrl: gatewayUrl.origin, mcpGatewayAdminToken,
    mcpGatewayContainer: env.MCP_GATEWAY_CONTAINER_NAME ?? 'cloud-work-mcp-gateway',
    image: env.RUNTIME_IMAGE ?? 'cloud-work-runtime:latest', network: env.RUNTIME_NETWORK ?? 'cloud-runtime',
    cpus: numberEnv(env, 'RUNTIME_CPUS', 2), memoryMb: numberEnv(env, 'RUNTIME_MEMORY_MB', 4096, 128),
    pids: Math.floor(numberEnv(env, 'RUNTIME_PIDS_LIMIT', 256, 32)),
    idleMs: numberEnv(env, 'RUNTIME_IDLE_MINUTES', 30) * 60_000,
    removeMs: numberEnv(env, 'RUNTIME_REMOVE_HOURS', 24) * 3_600_000,
    reaperMs: numberEnv(env, 'RUNTIME_REAPER_INTERVAL_MS', 60_000, 1000),
    leaseMs: 120_000, heartbeatMs: 20_000,
    provider: env.DSH_PROVIDER ?? 'deepseek-official', model: env.DSH_MODEL ?? 'deepseek-v4-flash',
    baseUrl, contextWindow, maxTokens,
    apiKey: env.DSH_API_KEY ?? '', hostId: env.RUNTIME_HOST_ID ?? 'local-docker',
  };
}
export type Config = ReturnType<typeof readConfig>;

/** Explicit allowlist: never forward the manager's process environment to a tenant. */
export function runtimeEnvironment(config: Config, userId: string): string[] {
  return [
    'NODE_ENV=production', 'HOME=/home/work', 'PORT=3080',
    `RUNTIME_TOKEN=${runtimeToken(userId, config.tokenSecret)}`,
    `DSH_PROVIDER=${config.provider}`, `DSH_MODEL=${config.model}`, `DSH_API_KEY=${config.apiKey}`,
    ...(config.baseUrl === undefined ? [] : [`DSH_BASE_URL=${config.baseUrl}`]),
    ...(config.contextWindow === undefined ? [] : [`DSH_CONTEXT_WINDOW=${config.contextWindow}`]),
    ...(config.maxTokens === undefined ? [] : [`DSH_MAX_TOKENS=${config.maxTokens}`]),
  ];
}
