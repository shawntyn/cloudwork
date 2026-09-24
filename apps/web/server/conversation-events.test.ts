import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eventCursorAfter, parseEventCursor } from './conversation-events';

test('SSE cursors accept old Redis IDs and new durable IDs, rejecting unsafe values', () => {
  assert.deepEqual(parseEventCursor('1790000000000-42'), { ms: 1790000000000, seq: 42 });
  assert.deepEqual(parseEventCursor('1800000000000000-0'), { ms: 1800000000000000, seq: 0 });
  for (const value of ['-1', '1', 'NaN-0', '9007199254740992-0', '1--1']) assert.equal(parseEventCursor(value), null);
});

test('SSE resume query advances by both stream ID components', () => {
  const query = new PgDialect().sqlToQuery(eventCursorAfter({ ms: 1790000000000, seq: 42 })!);
  assert.match(query.sql, /stream_ms.*>.*or.*stream_ms.*=.*stream_seq.*>/i);
  assert.deepEqual(query.params, [1790000000000, 1790000000000, 42]);
});
