import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function encryptionKey(value = process.env.MCP_ENCRYPTION_KEY ?? ''): Buffer {
  if (!/^[a-f\d]{64}$/i.test(value)) throw new Error('MCP_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hexadecimal characters');
  return Buffer.from(value, 'hex');
}
export const secretContext = (userId: string, connectionId: string, revision: number) => `${userId}:${connectionId}:${revision}`;
export function encryptSecret(headers: Record<string, string>, context: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(headers), 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
export function decryptSecret(value: string | null, context: string, key: Buffer): Record<string, string> {
  if (!value) return {};
  const parts = value.split('.');
  const [version, nonce, tag, encrypted] = parts;
  if (parts.length !== 4 || version !== 'v1' || !nonce || !tag || !encrypted || ![nonce, tag, encrypted].every(part => /^[A-Za-z0-9_-]+$/.test(part) && Buffer.from(part, 'base64url').toString('base64url') === part) || Buffer.from(nonce, 'base64url').length !== 12 || Buffer.from(tag, 'base64url').length !== 16) throw new Error('Invalid encrypted MCP credential');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64url')), cipher.final()]).toString('utf8'));
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function redactSecrets<T>(value: T, headers: Record<string, string>): T {
  const secrets = Object.values(headers).flatMap(value => [value, value.replace(/^Bearer\s+/i, '')]).flatMap(value => [value, JSON.stringify(value).slice(1, -1)]).filter(Boolean).sort((a, b) => b.length - a.length);
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') return secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), input);
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [walk(key), walk(item)]));
    return input;
  };
  return walk(value) as T;
}
