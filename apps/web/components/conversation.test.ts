import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { ApiClientError } from './client';

// The repository's tsx test runner uses the classic JSX transform for this
// import graph, while the Next build uses the automatic transform.
Object.assign(globalThis, { React });
const { clearAcceptedDrafts, isIdempotencyKeyConflict, isDefinitiveSendRejection, isAcceptedRequestActive } = await import('./conversation');

test('a confirmed send clears the original draft and the newly created session copy', () => {
  const draftKey = 'draft:workspace-a';
  const sessionId = 'session-a';
  const draft = '  Explain this file  ';
  const current = { [draftKey]: draft, [sessionId]: draft };

  assert.deepEqual(clearAcceptedDrafts(current, { key: draftKey, value: draft }, sessionId, 'Explain this file'), {
    [draftKey]: '',
    [sessionId]: '',
  });
  assert.equal(current[draftKey], draft);
});

test('confirmation preserves a draft edited while the request was in flight', () => {
  const sessionId = 'session-a';
  const current = { [sessionId]: 'Explain this file and add tests' };

  assert.equal(clearAcceptedDrafts(current, { key: sessionId, value: 'Explain this file' }, sessionId, 'Explain this file'), current);
  assert.equal(clearAcceptedDrafts({ [sessionId]: 'Explain this file ' }, { key: sessionId, value: 'Explain this file' }, sessionId, 'Explain this file')[sessionId], 'Explain this file ');
});

test('a retry of an Agent run does not clear an unrelated composer draft', () => {
  const current = { 'session-a': 'My next question' };
  assert.equal(clearAcceptedDrafts(current, undefined, 'session-a', 'Earlier question'), current);
});

test('only a reused identifier with different text is a definitive idempotency conflict', () => {
  assert.equal(isIdempotencyKeyConflict(new ApiClientError('different text', 'IDEMPOTENCY_KEY_CONFLICT', 409)), true);
  assert.equal(isIdempotencyKeyConflict(new ApiClientError('still being confirmed', 'CONFLICT', 409)), false);
  assert.equal(isIdempotencyKeyConflict(new ApiClientError('service unavailable', 'SERVICE_UNAVAILABLE', 503)), false);
});

test('rate limiting is uncertain until the same request ID is checked', () => {
  assert.equal(isDefinitiveSendRejection(new ApiClientError('rate limited', 'RATE_LIMITED', 429)), false);
  assert.equal(isDefinitiveSendRejection(new ApiClientError('invalid prompt', 'INVALID_REQUEST', 400)), true);
});

test('durable request status takes precedence over a stale session status', () => {
  assert.equal(isAcceptedRequestActive({ requestStatus: 'queued', sessionStatus: 'idle' }), true);
  assert.equal(isAcceptedRequestActive({ requestStatus: 'running', sessionStatus: 'error' }), true);
  assert.equal(isAcceptedRequestActive({ requestStatus: 'completed', sessionStatus: 'running' }), false);
  assert.equal(isAcceptedRequestActive({ requestStatus: 'failed', sessionStatus: 'running' }), false);
  assert.equal(isAcceptedRequestActive({ sessionStatus: 'running' }), true);
});
