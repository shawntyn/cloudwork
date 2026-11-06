import { spawnSync } from 'node:child_process';
import { launcherPath, probe } from '@deepseek-ai/node-addon-system/landlock-run';
// Native helper is deployment-owned and installed by both image builds.
import { verifyNetworkSandbox } from '../../../packages/runtime-dsh/src/network-policy.mjs';

/** Same functional Linux probes and precedence as DSH 0.1.5-rc.2. */
export function verifySandbox(): { backend: 'bwrap' | 'landlock'; enforcement: 'full' | 'partial'; network: 'denied' } {
  if (process.platform !== 'linux') throw new Error('Cloud Work runtime requires a Linux container');
  verifyNetworkSandbox();
  const bwrap = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true'], { timeout: 5_000, stdio: 'ignore' });
  if (bwrap.status === 0) return { backend: 'bwrap', enforcement: 'full', network: 'denied' };
  const enforcement = probe(launcherPath(), { timeoutMs: 5_000 });
  if (enforcement !== 'unusable') return { backend: 'landlock', enforcement, network: 'denied' };
  throw new Error('SANDBOX_UNAVAILABLE: neither bubblewrap nor Landlock can enforce confinement. Use a Linux kernel with Landlock enabled and Docker default seccomp support. Sandbox is never disabled automatically.');
}
