import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { db, users, sessions, accounts, verifications } from '@cloud-work/database';
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema: { user: users, session: sessions, account: accounts, verification: verifications } }),
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'],
  emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128, autoSignIn: true },
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  advanced: { database: { generateId: () => crypto.randomUUID() } },
  rateLimit: { enabled: true, window: 60, max: 100 },
});
