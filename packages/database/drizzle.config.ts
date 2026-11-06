import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'postgresql', schema: './src/schema.ts', out: './migrations', dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://cloudwork:cloudwork@localhost:5432/cloudwork' } });
