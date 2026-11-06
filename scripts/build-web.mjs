import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
// Better Auth initializes while Next collects route metadata. Supply an ephemeral
// build-only secret; production still receives its real secret at container start.
const result = spawnSync(process.execPath, ['node_modules/next/dist/bin/next', 'build', '--webpack'], {
  stdio: 'inherit',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || randomBytes(32).toString('hex') },
});
process.exit(result.status ?? 1);
