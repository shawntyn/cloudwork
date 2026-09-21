import type { AgentEvent, McpRunSnapshot } from '@cloud-work/protocol';
export type { AgentEvent } from '@cloud-work/protocol';
export interface AgentRuntime {
  createSession(input: { sessionId: string; workspacePath: string }): Promise<void>;
  run(input: { sessionId: string; prompt: string; mcp?: McpRunSnapshot }): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;
  destroySession(sessionId: string): Promise<void>;
}
