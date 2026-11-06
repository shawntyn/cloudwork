import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
const client = postgres(process.env.DATABASE_URL!, { max: 1 });
try {
  await client`SELECT pg_advisory_lock(39481123)`;
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  console.log('Database migrations applied');
} finally {
  await client`SELECT pg_advisory_unlock(39481123)`;
  await client.end();
}
