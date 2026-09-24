import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionSummary, type AgentSession } from '../app/api/sessions/summary';

const createdAt = new Date('2026-09-20T00:00:00.000Z');
const legacy: AgentSession = {
  id: 'sess_legacy', userId: 'user_a', workspaceId: 'workspace_a', dshSessionId: 'sess_legacy',
  status: 'idle', title: null, firstMessageAt: null, confirmedBlank: false,
  lastActivityAt: createdAt, pinnedAt: null, archivedAt: null, eventsBackfilledAt: null, createdAt, updatedAt: createdAt,
};

test('ambiguous legacy conversation remains a conversation even with unchanged timestamps', () => {
  const summary = sessionSummary(legacy);
  assert.equal(summary.title, null);
  assert.equal(summary.firstMessageAt, null);
  assert.equal(summary.hasMessages, true);
  assert.equal(summary.confirmedBlank, false);
});

test('only an explicitly confirmed blank draft is summarized as unused', () => {
  const draft = sessionSummary({ ...legacy, id: 'sess_new_draft', confirmedBlank: true });
  assert.equal(draft.hasMessages, false);
  assert.equal(draft.confirmedBlank, true);
  assert.equal(sessionSummary({ ...legacy, id: 'sess_new_used', firstMessageAt: new Date(), confirmedBlank: false }).hasMessages, true);
  assert.equal(sessionSummary({ ...legacy, id: 'sess_inconsistent', firstMessageAt: new Date(), confirmedBlank: true }).hasMessages, true);
});
