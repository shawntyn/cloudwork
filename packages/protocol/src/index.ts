export type RuntimeStatus = 'STARTING' | 'RUNNING' | 'IDLE' | 'STOPPED' | 'REMOVED' | 'ERROR';
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; id: string; name: string; input?: unknown }
  | { type: 'tool-result'; id: string; output?: unknown }
  | { type: 'status'; status: 'starting' | 'running' | 'idle' | 'stopped' | 'error' }
  | { type: 'error'; message: string }
  | { type: 'user-message'; text: string };
export type FileEntry = { name: string; path: string; type: 'file' | 'directory' | 'symlink'; size: number };

export const FILE_TRANSFER_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxBatchBytes: 1024 * 1024 * 1024,
  maxEntries: 5000,
  maxTextBytes: 10 * 1024 * 1024,
  maxImagePreviewBytes: 20 * 1024 * 1024,
  timeoutMs: 15 * 60 * 1000,
} as const;
export type FileUploadManifest = {
  files: Array<{ path: string; size: number }>;
  directories?: string[];
};
export type FileUploadConflict = 'error' | 'replace' | 'rename';

export type McpAuthType = 'none' | 'bearer' | 'headers';
export type McpToolSummary = { name: string; description?: string };
export type McpConnectionSummary = {
  /** name is the optional display label; use serverName when it is empty. */
  id: string; name: string; serverName: string; url: string; transport: 'streamable-http';
  authType: McpAuthType; hasSecret: boolean; enabled: boolean; revision: number;
  tools: McpToolSummary[]; lastTestStatus: 'never' | 'ok' | 'error';
  lastTestError: string | null; lastTestAt: string | null; createdAt: string; updatedAt: string;
};
export type McpConnectionInput = {
  /** Stable callable name (1–24 lowercase letters, digits or underscores). */
  serverName: string;
  /** Optional display label; an empty string falls back to serverName. */
  name?: string; url: string; authType: McpAuthType; token?: string;
  headers?: Record<string, string>; enabled?: boolean;
};
export type McpConnectionList = { connections: McpConnectionSummary[]; policy: { allowedOrigins: string[] } };
export type WorkspaceMcpBindings = { connections: McpConnectionSummary[]; enabledConnectionIds: string[] };
/** Only short-lived gateway grants; upstream credentials never enter a user runtime. */
export type McpRunSnapshot = {
  runId: string; revision: string;
  connections: Array<{ id: string; serverName: string; url: string; token: string }>;
};
