import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.ts';
export * from './schema.ts';
export { schema };
export const sql = postgres(process.env.DATABASE_URL ?? 'postgres://cloudwork:cloudwork@localhost:5432/cloudwork', { max: 10, idle_timeout: 20, connect_timeout: 10 });
export const db = drizzle(sql, { schema });
