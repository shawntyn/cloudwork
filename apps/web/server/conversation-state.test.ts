import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyConversation, reduceConversation } from '../components/conversation-state';

test('a queued user message reconciles with the durable event without doubling', () => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const pending = reduceConversation(emptyConversation(), { type: 'optimistic', requestId, text: 'Explain this file' });
  const event = { type: 'user-message' as const, text: 'Explain this file', requestId };
  const received = reduceConversation(pending, { type: 'event', id: '1800000000000000-0', event });
  assert.equal(received.blocks.length, 1);
  assert.equal(received.blocks[0]?.type, 'user');
  assert.equal(received.blocks[0]?.pending, undefined);
  assert.equal(reduceConversation(received, { type: 'event', id: '1800000000000000-0', event }), received);
});

test('repeating a failed send with the same request ID retains one bubble', () => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const queued = reduceConversation(emptyConversation(), { type: 'optimistic', requestId, text: 'hello' });
  const failed = reduceConversation(queued, { type: 'pending', requestId, pending: 'failed', sendError: 'Network unavailable' });
  const retried = reduceConversation(failed, { type: 'optimistic', requestId, text: 'hello' });
  assert.equal(retried.blocks.length, 1);
  assert.equal(retried.blocks[0]?.type, 'user');
  assert.equal(retried.blocks[0]?.pending, 'sending');
});

test('run errors stay with their question and a later turn retains earlier output', () => {
  let state = emptyConversation();
  state = reduceConversation(state, { type: 'event', id: '10-0', event: { type: 'user-message', text: 'first' } });
  state = reduceConversation(state, { type: 'event', id: '11-0', event: { type: 'text-delta', text: 'partial answer' } });
  state = reduceConversation(state, { type: 'event', id: '12-0', event: { type: 'error', message: 'timeout', code: 'RUN_TIMEOUT' } });
  state = reduceConversation(state, { type: 'event', id: '13-0', event: { type: 'status', status: 'error' } });
  state = reduceConversation(state, { type: 'event', id: '14-0', event: { type: 'user-message', text: 'second' } });
  state = reduceConversation(state, { type: 'event', id: '15-0', event: { type: 'status', status: 'stopped' } });
  assert.deepEqual(state.blocks.map(block => block.type), ['user', 'assistant', 'error', 'user']);
  assert.equal(state.blocks[1]?.type === 'assistant' && state.blocks[1].text, 'partial answer');
  assert.equal(state.blocks[2]?.turnId, state.blocks[0]?.turnId);
  assert.notEqual(state.blocks[2]?.turnId, state.blocks[3]?.turnId);
  assert.equal(state.status, 'stopped');
});
