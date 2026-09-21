import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local';
import { NETWORK_LAUNCHER, verifyNetworkSandbox } from './network-policy.mjs';

/** Extend the official file sandbox; never replace its backend/probe/fail-closed logic. */
export default class OfflineSandboxProvider extends LocalSandboxProvider {
  networkVerified = false;

  confine(argv, policy) {
    if (!this.networkVerified) {
      verifyNetworkSandbox();
      this.networkVerified = true;
    }
    const confined = super.confine([NETWORK_LAUNCHER, '--', ...argv], policy);
    return {
      ...confined,
      denialSignatures: [...confined.denialSignatures, 'operation not permitted'],
      runnerFailureRules: [...confined.runnerFailureRules, { allowedExitCodes: [126], fatalSignatures: ['cloud-work-no-network:'] }],
    };
  }
}
