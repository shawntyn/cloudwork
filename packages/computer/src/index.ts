import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const screen = { width: 1280, height: 800 } as const;
export const point = z.tuple([z.number().int().min(0).max(screen.width - 1), z.number().int().min(0).max(screen.height - 1)]);
export const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), coordinate: point, button: z.enum(['left', 'right', 'middle']).default('left'), count: z.number().int().min(1).max(3).default(1) }).strict(),
  z.object({ action: z.literal('move'), coordinate: point }).strict(),
  z.object({ action: z.literal('drag'), from: point, to: point }).strict(),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(4000) }).strict(),
  z.object({ action: z.literal('key'), key: z.string().max(100).regex(/^(?:(?:ctrl|alt|shift|super)\+)*(?:[a-zA-Z0-9]|F(?:[1-9]|1[0-2])|Return|Tab|Escape|BackSpace|Delete|Up|Down|Left|Right|Home|End|Page_Up|Page_Down|space)$/) }).strict(),
  z.object({ action: z.literal('scroll'), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(10), coordinate: point.optional() }).strict(),
  z.object({ action: z.literal('wait'), milliseconds: z.number().int().min(0).max(2000) }).strict(),
]);
export type ComputerAction = z.infer<typeof actionSchema>;
export const planSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('action'), explanation: z.string().max(2000), operation: actionSchema }).strict(),
  z.object({ kind: z.literal('handoff'), reason: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal('done'), result: z.string().min(1).max(12000) }).strict(),
  z.object({ kind: z.literal('confirmation'), reason: z.string().min(1).max(2000), operation: actionSchema }).strict(),
]);
export type ComputerPlan = z.infer<typeof planSchema>;
export type DesktopMode = 'idle' | 'ai' | 'manual' | 'revoking';
export type ComputerTaskState = 'queued' | 'running' | 'confirmation' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export interface DesktopView {
  enabled: boolean; available: boolean; status: 'stopped' | 'starting' | 'ready' | 'error'; mode: DesktopMode;
  owner: string | null; epoch: number; queued: number; task: { id: string; sessionId: string; goal: string; state: ComputerTaskState; actionCount: number; result: string | null; progress: string | null; confirmation: ComputerPlan | null } | null;
}
export interface ComputerGrant { url: string; token: string }
export interface Scope { kind: 'run' | 'task'; userId: string; workspaceId: string; sessionId: string; runId: string; taskId?: string; expires: number }
export function signScope(scope: Scope, key: string): string {
  const payload = Buffer.from(JSON.stringify(scope)).toString('base64url');
  return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
}
export function verifyScope(token: string, key: string, now = Date.now()): Scope {
  if (token.length > 4000) throw new Error('Invalid computer authorization');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new Error('Invalid computer authorization');
  const actual = Buffer.from(signature, 'base64url'), expected = createHmac('sha256', key).update(payload).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid computer authorization');
  const scope = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Scope;
  if (!['run', 'task'].includes(scope.kind) || !Number.isSafeInteger(scope.expires) || scope.expires <= now ||
      ![scope.userId, scope.workspaceId, scope.sessionId, scope.runId].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v)) ||
      (scope.kind === 'task' && !/^[a-zA-Z0-9_-]{1,100}$/.test(scope.taskId ?? ''))) throw new Error('Invalid computer authorization');
  return scope;
}
export function sameSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return b.length >= 32 && a.length === b.length && timingSafeEqual(a, b);
}
export const terminalTask = (state: string) => ['completed', 'cancelled', 'failed', 'interrupted'].includes(state);
