import { agentSessions } from '@cloud-work/database';

export type AgentSession = typeof agentSessions.$inferSelect;

export function sessionSummary(session: AgentSession, workspaceName?: string) {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    status: session.status,
    title: session.title,
    firstMessageAt: session.firstMessageAt,
    lastActivityAt: session.lastActivityAt,
    pinnedAt: session.pinnedAt,
    archivedAt: session.archivedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(workspaceName === undefined ? {} : { workspaceName }),
    // Legacy sessions have no reliable message count. Only sessions created
    // with an explicit blank marker may be shown as unused drafts.
    hasMessages: session.firstMessageAt !== null || !session.confirmedBlank,
    pinned: session.pinnedAt !== null,
    archived: session.archivedAt !== null,
  };
}
