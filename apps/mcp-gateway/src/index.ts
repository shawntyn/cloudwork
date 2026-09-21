import { encryptionKey } from './crypto.ts';
import { DestinationPolicy } from './policy.ts';
import { createServer } from './server.ts';
const app = createServer(new DestinationPolicy(), encryptionKey(), process.env.MCP_GATEWAY_ADMIN_TOKEN ?? '');
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4100) });
console.log('MCP gateway listening on port 4100');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close().finally(() => process.exit(0)); });
