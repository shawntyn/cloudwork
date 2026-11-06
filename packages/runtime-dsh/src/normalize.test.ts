import test from 'node:test';
import assert from 'node:assert/strict';
import { DshEventNormalizer } from './normalize.ts';

const event = (type: string, data: unknown, sessionId = 'sess_root') => ({ method: 'session.event', params: { sessionId, event: { type, data } } });

test('text chunks stream immediately and assembled message is not duplicated', () => {
  const normalizer = new DshEventNormalizer('sess_root');
  assert.deepEqual(normalizer.normalize(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello' } })), [{ type: 'text-delta', text: 'Hello' }]);
  assert.deepEqual(normalizer.normalize(event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello' }] } })), []);
  assert.deepEqual(normalizer.normalize(event('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Result' }] } })), [{ type: 'text-delta', text: 'Result' }]);
});

test('official live frames stream root text once and suppress the matching durable message', () => {
  const normalizer = new DshEventNormalizer('sess_root');
  const live = (frame: unknown, sessionId = 'sess_root') => ({ method: 'session.assistant-stream', params: { sessionId, frame } });
  const start = { type: 'start', attemptId: 'sess_root:1', revision: 1, turn: 1, step: 1 };
  const chunk = { type: 'chunk', attemptId: start.attemptId, revision: 2, index: 0, time: 123, chunk: { type: 'text-delta', index: 0, text: 'Hello ' } };
  assert.deepEqual(normalizer.normalize(live(start)), []);
  assert.deepEqual(normalizer.normalize(live(chunk)), [{ type: 'text-delta', text: 'Hello ' }]);
  assert.deepEqual(normalizer.normalize(live(chunk)), []);
  assert.deepEqual(normalizer.normalize(live({ ...chunk, index: 1, chunk: { type: 'text-delta', index: 0, text: 'world' } })), [{ type: 'text-delta', text: 'world' }]);
  assert.deepEqual(normalizer.normalize(event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello world' }] } })), []);
  assert.deepEqual(normalizer.normalize(live({ type: 'end', attemptId: start.attemptId, revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } })), []);
  assert.deepEqual(normalizer.normalize(live({ ...chunk, index: 2 })), []);
  assert.deepEqual(normalizer.normalize(live(start, 'child')), []);
  assert.deepEqual(normalizer.normalize(live(chunk, 'child')), []);
  assert.deepEqual(normalizer.normalize(event('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Unstreamed fallback' }] } })), [{ type: 'text-delta', text: 'Unstreamed fallback' }]);
});

test('tool results pair with namespaced calls, including subagent calls', () => {
  const normalizer = new DshEventNormalizer('sess_root');
  assert.deepEqual(normalizer.normalize(event('tool/call', { callId: 'call_1', name: 'bash', arguments: '{"command":"pwd"}' }, 'child')), [{ type: 'tool-start', id: 'child:call_1', name: 'bash', input: { command: 'pwd' } }]);
  const result = normalizer.normalize(event('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '/workspace' }] }] } }, 'child'));
  assert.equal(result[0]?.type, 'tool-result');
  assert.equal(result[0]?.type === 'tool-result' && result[0].id, 'child:call_1');
  assert.deepEqual(normalizer.normalize(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'child answer' } }, 'child')), []);
});

test('provider turn failures become error events; idle is deferred until process cleanup', () => {
  const normalizer = new DshEventNormalizer('sess_root');
  assert.deepEqual(normalizer.normalize(event('turn/end', { reason: { kind: 'error', error: { message: 'Missing API credential' } } })), [{ type: 'error', message: 'Missing API credential' }]);
  assert.equal(normalizer.failed, true);
  assert.deepEqual(normalizer.normalize({ method: 'session.status', params: { sessionId: 'sess_root', status: 'idle' } }), []);
});

test('malformed notifications are ignored and invalid tool arguments remain inspectable', () => {
  const normalizer = new DshEventNormalizer('sess_root');
  assert.deepEqual(normalizer.normalize({ method: 'session.event', params: { event: null } }), []);
  assert.deepEqual(normalizer.normalize(event('tool/result', { message: { content: null } })), []);
  assert.deepEqual(normalizer.normalize(event('tool/call', { callId: 'broken', name: 'bash', arguments: '{' })), [{ type: 'tool-start', id: 'sess_root:broken', name: 'bash', input: '{' }]);
});
