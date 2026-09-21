import type { AgentEvent } from '@cloud-work/protocol';
import type { Redis } from 'ioredis';

export async function publish(redis: Redis, sessionId: string, event: AgentEvent): Promise<void> {
  const key = `session:${sessionId}:events`;
  const result = await redis.multi().xadd(key, 'MAXLEN', '~', 10000, '*', 'event', JSON.stringify(event)).expire(key, 7 * 24 * 3600).exec();
  if (!result || result.some(([error]) => error)) throw new Error('Event journal unavailable');
}

export function parseEvent(value: unknown): AgentEvent {
  if (!value || typeof value !== 'object' || !('type' in value)) throw new Error('Invalid runtime event');
  const e = value as Record<string, unknown>;
  if (e.type === 'text-delta' && typeof e.text === 'string') return { type: 'text-delta', text: e.text };
  if (e.type === 'tool-start' && typeof e.id === 'string' && typeof e.name === 'string') return { type: 'tool-start', id: e.id, name: e.name, input: e.input };
  if (e.type === 'tool-result' && typeof e.id === 'string') return { type: 'tool-result', id: e.id, output: e.output };
  if (e.type === 'error' && typeof e.message === 'string') return { type: 'error', message: e.message };
  if (e.type === 'status' && ['starting', 'running', 'idle', 'stopped', 'error'].includes(String(e.status))) return { type: 'status', status: e.status as 'starting' | 'running' | 'idle' | 'stopped' | 'error' };
  throw new Error('Unknown runtime event');
}

/** Read arbitrary UTF-8 chunks, including CRLF and multi-line SSE data. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data: string[] = [], dataSize = 0;
  const pushData = (line: string) => {
    dataSize += Buffer.byteLength(line);
    if (dataSize > 8 * 1024 * 1024) throw new Error('Runtime event exceeds size limit');
    data.push(line);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Runtime event exceeds size limit');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '' && data.length) { yield parseEvent(JSON.parse(data.join('\n'))); data = []; dataSize = 0; }
        else if (line.startsWith('data:')) pushData(line.slice(5).replace(/^ /, ''));
      }
      if (done) {
        if (buffer.startsWith('data:')) pushData(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
        if (data.length) yield parseEvent(JSON.parse(data.join('\n')));
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export const terminal = (event: AgentEvent) => event.type === 'status' && ['idle', 'stopped', 'error'].includes(event.status);
