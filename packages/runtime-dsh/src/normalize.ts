import type { AgentEvent } from '@cloud-work/protocol';
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Normalize the published 0.1.5-rc.2 session.event envelope at the adapter boundary. */
export class DshEventNormalizer {
  failed = false;
  private streamedSteps = new Set<string>();
  private attempts = new Map<string, { stepKey: string; lastIndex: number }>();

  constructor(private readonly sessionId: string) {}

  normalize(notification: HarnessNotification): AgentEvent[] {
    const p = notification.params;
    // Descendant tool work is useful; child assistant prose must not appear as the root answer.
    const root = p.sessionId === this.sessionId;
    if (notification.method === 'session.status') {
      return root && p.status === 'running' ? [{ type: 'status', status: 'running' }] : [];
    }
    // DSH 0.1.5 emits process-local frames separately from durable session events.
    if (notification.method === 'session.assistant-stream') {
      if (!root) return [];
      const frame = record(p.frame);
      if (typeof frame.attemptId !== 'string') return [];
      if (frame.type === 'start' && Number.isSafeInteger(frame.turn) && Number.isSafeInteger(frame.step)) {
        this.attempts.set(frame.attemptId, { stepKey: `${frame.turn}:${frame.step}`, lastIndex: -1 });
      } else if (frame.type === 'chunk') {
        const attempt = this.attempts.get(frame.attemptId);
        if (!attempt || typeof frame.index !== 'number' || !Number.isSafeInteger(frame.index) || frame.index <= attempt.lastIndex) return [];
        attempt.lastIndex = frame.index;
        const chunk = record(frame.chunk);
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
          this.streamedSteps.add(attempt.stepKey);
          return [{ type: 'text-delta', text: chunk.text }];
        }
      } else if (frame.type === 'end') this.attempts.delete(frame.attemptId);
      return [];
    }
    if (notification.method !== 'session.event') return [];
    const event = record(p.event);
    const data = record(event.data);
    const stepKey = `${data.turn}:${data.step}`;
    if (root && event.type === 'assistant/chunk') {
      const chunk = record(data.chunk);
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        this.streamedSteps.add(stepKey);
        return [{ type: 'text-delta', text: chunk.text }];
      }
    }
    if (root && event.type === 'assistant/message' && !this.streamedSteps.has(stepKey)) {
      const blocks = record(data.message).content;
      const text = Array.isArray(blocks)
        ? blocks.map(record).filter(b => b.type === 'text').map(b => typeof b.text === 'string' ? b.text : '').join('')
        : '';
      return text ? [{ type: 'text-delta', text }] : [];
    }
    if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      let input: unknown = data.arguments;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* preserve invalid model JSON */ } }
      return [{ type: 'tool-start', id: `${p.sessionId}:${data.callId}`, name: data.name, input }];
    }
    if (event.type === 'tool/result') {
      const blocks = record(data.message).content;
      if (!Array.isArray(blocks)) return [];
      return blocks.map(record).filter(b => b.type === 'tool-result' && typeof b.toolCallId === 'string')
        .map(b => ({ type: 'tool-result', id: `${p.sessionId}:${b.toolCallId}`, output: { content: b.content, isError: b.isError ?? false, error: data.error } }));
    }
    if (root && event.type === 'turn/end') {
      const reason = record(data.reason);
      if (reason.kind === 'error' || reason.kind === 'blocked' || reason.kind === 'interrupted') {
        this.failed = true;
        const details = record(reason.error);
        return [{ type: 'error', message: typeof details.message === 'string' ? details.message : `Agent turn ended: ${reason.kind}` }];
      }
    }
    return [];
  }
}
