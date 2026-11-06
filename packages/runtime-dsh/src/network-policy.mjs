import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';

export const NETWORK_LAUNCHER = '/usr/local/libexec/cloud-work-no-network';

/** A deployment-owned executable must prove enforcement before any command runs. */
export function verifyNetworkSandbox() {
  if (process.platform !== 'linux') throw new Error('NETWORK_SANDBOX_UNAVAILABLE: Linux seccomp is required');
  try {
    for (const path of ['/usr', '/usr/local', '/usr/local/libexec', NETWORK_LAUNCHER]) {
      const info = lstatSync(path);
      if (info.uid !== 0 || (info.mode & 0o022) !== 0 || info.isSymbolicLink()) throw new Error('network launcher is not deployment-owned');
    }
    if (realpathSync(NETWORK_LAUNCHER) !== NETWORK_LAUNCHER) throw new Error('network launcher path is not canonical');
    const result = spawnSync(NETWORK_LAUNCHER, ['--probe'], { timeout: 5000, encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout.includes('"network":"denied"')) throw new Error(result.stderr || result.error?.message || 'network probe failed');
    return { network: 'denied', mechanism: 'seccomp' };
  } catch (error) {
    throw new Error(`NETWORK_SANDBOX_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
  }
}
