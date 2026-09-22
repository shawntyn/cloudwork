import { createHmac } from 'node:crypto';
import path from 'node:path';
import type Docker from 'dockerode';
import { HttpError, runtimeEnvironment, safeId, type Config } from './config.js';

export const runtimeSpecLabel = 'cloud-work.runtime-spec';

export function runtimeBinds(config: Config, userId: string): string[] {
  const root = path.join(config.dataRoot, safeId(userId));
  return [`${root}/home:/home/work:rw`, `${root}/workspaces:/home/work/workspaces:rw`];
}

/** HMAC prevents the public Docker label from becoming a verifier for low-entropy secrets. */
export function runtimeSpec(config: Config, userId: string): string {
  return createHmac('sha256', config.tokenSecret).update(JSON.stringify({
    revision: 1, env: runtimeEnvironment(config, userId), binds: runtimeBinds(config, userId),
    cpus: config.cpus, memoryMb: config.memoryMb, pids: config.pids, network: config.network,
  })).digest('hex');
}

export function assertRuntimeDataMounts(config: Config, userId: string, info: Docker.ContainerInspectInfo): void {
  // Changing USER_DATA_ROOT is a data migration, not an automatic container update.
  // HostConfig retains the original host paths, including on Docker Desktop.
  const actual = info.HostConfig.Binds ?? [];
  if (!runtimeBinds(config, userId).every(bind => actual.includes(bind))) {
    throw new HttpError(409, 'Runtime data mounts differ from USER_DATA_ROOT. Restore the original data root or migrate the data before updating.');
  }
}
