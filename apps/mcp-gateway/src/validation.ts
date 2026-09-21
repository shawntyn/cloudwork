import { z } from 'zod';
import { GatewayError } from './policy.ts';

export const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const displayName = z.string().trim().max(100).regex(/^[^\x00-\x1f\x7f]*$/);
const serverName = z.string().regex(/^[a-z0-9_]{1,24}$/);
const credential = z.string().min(1).max(4096).regex(/^[\x20-\x7e]+$/);
const headers = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/), credential).superRefine((value, context) => {
  const names = Object.keys(value).map(name => name.toLowerCase());
  if (!names.length || names.length > 16 || new Set(names).size !== names.length || names.some(name => /^(host|connection|content-length|transfer-encoding|cookie|set-cookie|proxy-.*|forwarded|x-forwarded-.*|accept|content-type|mcp-.*|origin|referer|upgrade|te|trailer)$/i.test(name))) context.addIssue({ code: 'custom', message: 'Use at most 16 authentication headers; transport, proxy and cookie headers are reserved' });
});
export const connectionInput = z.object({ serverName, name: displayName.optional(), url: z.string().trim().min(1).max(2048), authType: z.enum(['none', 'bearer', 'headers']), token: credential.optional(), headers: headers.optional(), enabled: z.boolean().optional() }).strict();
export const connectionPatch = connectionInput.omit({ serverName: true }).partial().refine(value => Object.keys(value).length > 0, 'Provide a change');
export const bindingInput = z.object({ connectionIds: z.array(safeId).max(16).refine(value => new Set(value).size === value.length) }).strict();
export const runInput = z.object({ workspaceId: safeId, sessionId: safeId }).strict();
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GatewayError(400, 'Invalid MCP configuration');
  return result.data;
}
