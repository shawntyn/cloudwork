import { z } from 'zod';
import { ApiError, idSchema } from './api';

const authType = z.enum(['none', 'bearer', 'headers']);
const connectionUrl = z.string().trim().max(2048).url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
});
const credential = z.string().min(1).max(4096).regex(/^[\x20-\x7e]+$/);
const headerName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/);
const headers = z.record(headerName, credential).refine(value => {
  const names = Object.keys(value).map(name => name.toLowerCase());
  return names.length > 0 && names.length <= 16 && new Set(names).size === names.length
    && names.every(name => !/^(host|connection|content-length|transfer-encoding|cookie|set-cookie|proxy-.*|forwarded|x-forwarded-.*|accept|content-type|mcp-.*|origin|referer|upgrade|te|trailer)$/i.test(name));
});
const secret = z.preprocess(value => typeof value === 'string' && !value.trim() ? undefined : value, credential.optional());
const fields = {
  name: z.string().trim().max(100).regex(/^[^\x00-\x1f\x7f]*$/).optional(),
  url: connectionUrl,
  authType,
  token: secret,
  headers: headers.optional(),
  enabled: z.boolean().optional(),
};
export const createConnectionSchema = z.object({
  ...fields,
  serverName: z.string().trim().regex(/^[a-z0-9_]{1,24}$/, 'Name must use 1–24 lowercase letters, digits or underscores'),
}).strict().superRefine((value, context) => {
  if (value.authType === 'bearer' && !value.token) context.addIssue({ code: 'custom', message: 'Bearer token is required', path: ['token'] });
  if (value.authType === 'headers' && !value.headers) context.addIssue({ code: 'custom', message: 'Headers are required', path: ['headers'] });
});
export const updateConnectionSchema = z.object(fields).partial().strict().refine(value => Object.values(value).some(item => item !== undefined));
export const workspaceMcpSchema = z.object({ connectionIds: z.array(idSchema).max(16).refine(ids => new Set(ids).size === ids.length) }).strict();

// Parse into an explicit public shape, so upstream additions cannot expose credentials.
export const publicConnectionSchema = z.object({
  id: idSchema,
  name: z.string(),
  serverName: z.string(),
  url: z.string(),
  transport: z.literal('streamable-http'),
  authType,
  hasSecret: z.boolean(),
  enabled: z.boolean(),
  revision: z.number().int(),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
  lastTestStatus: z.enum(['never', 'ok', 'error']),
  lastTestError: z.string().nullable(),
  lastTestAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const connectionResponseSchema = z.object({ connection: publicConnectionSchema });
export const connectionsResponseSchema = z.object({
  connections: z.array(publicConnectionSchema),
  policy: z.object({ allowedOrigins: z.array(z.string()) }),
});
export const workspaceMcpResponseSchema = z.object({
  connections: z.array(publicConnectionSchema),
  enabledConnectionIds: z.array(idSchema),
});

export function publicMcpResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(503, 'The connection service returned an invalid response. Please try again.');
  return result.data;
}
