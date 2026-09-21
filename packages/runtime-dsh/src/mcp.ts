import type { AgentEvent, McpRunSnapshot } from '@cloud-work/protocol';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an object`);
  }
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} contains unsupported fields`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must contain 1 to ${maximum} characters without control characters`);
  }
  return value;
}

/** Only manager-issued gateway grants cross this boundary; never arbitrary DSH plugin config. */
export function parseMcpRunSnapshot(value: unknown): McpRunSnapshot {
  const snapshot = object(value, ['runId', 'revision', 'connections'], 'MCP snapshot');
  const runId = boundedString(snapshot.runId, 128, 'MCP runId');
  const revision = boundedString(snapshot.revision, 128, 'MCP revision');
  if (!Array.isArray(snapshot.connections) || snapshot.connections.length > 16) throw new Error('MCP connections must be an array containing at most 16 entries');
  const ids = new Set<string>();
  const names = new Set<string>();
  const connections = snapshot.connections.map(value => {
    const connection = object(value, ['id', 'serverName', 'url', 'token'], 'MCP connection');
    const id = boundedString(connection.id, 128, 'MCP connection id');
    const serverName = boundedString(connection.serverName, 32, 'MCP serverName');
    if (!/^[A-Za-z0-9_-]+$/.test(serverName)) throw new Error('MCP serverName must contain only letters, digits, underscores, or hyphens');
    const suppliedUrl = boundedString(connection.url, 2048, 'MCP URL');
    let url: URL;
    try { url = new URL(suppliedUrl); } catch { throw new Error('MCP URL must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || suppliedUrl.includes('?') || suppliedUrl.includes('#') || suppliedUrl.trim() !== suppliedUrl) {
      throw new Error('MCP URL must use HTTP(S) without credentials, query, or fragment');
    }
    const token = boundedString(connection.token, 4096, 'MCP token');
    if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('MCP token must contain visible ASCII characters without spaces');
    if (ids.has(id) || names.has(serverName)) throw new Error('MCP connection IDs and server names must be unique');
    ids.add(id); names.add(serverName);
    return { id, serverName, url: url.toString(), token };
  });
  return { runId, revision, connections };
}

export interface McpRunOverlay {
  path: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

/** The directory lives outside workspace and tool TMPDIR, under the trusted runtime HOME. */
export async function prepareMcpRunOverlay(home: string, workspace: string, snapshot: McpRunSnapshot): Promise<McpRunOverlay | undefined> {
  if (!snapshot.connections.length) return undefined;
  const root = resolve(home, '.cloud-work', 'mcp-runs');
  const fromWorkspace = relative(workspace, root);
  if (!fromWorkspace || (!fromWorkspace.startsWith('..' + '/') && fromWorkspace !== '..' && !isAbsolute(fromWorkspace))) {
    throw new Error('MCP configuration directory must be outside the workspace');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw new Error('MCP configuration directory must not contain symlinks');
  const directory = await mkdtemp(join(root, 'run-'));
  const path = join(directory, 'mcp.patch.yml');
  const env: NodeJS.ProcessEnv = {};
  const entries = snapshot.connections.map((connection, index) => {
    const variable = `CLOUD_WORK_MCP_TOKEN_${index}`;
    env[variable] = connection.token;
    return {
      id: `cloud-work-mcp-${index}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        transport: 'streamable-http',
        serverName: connection.serverName,
        url: connection.url,
        // Cordis's !!js tag produces this exact object. The expression is fixed code,
        // never user input; JSON serialization makes every supplied field inert data.
        headers: { Authorization: { __jsExpr: `'Bearer ' + process.env.${variable}` } },
        failOnStartupError: true,
        reconnect: { enabled: false },
        toolCallTimeoutMs: 60_000,
      },
    };
  });
  try { await writeFile(path, JSON.stringify([{ insert: entries }]), { flag: 'wx', mode: 0o600 }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  let cleanup: Promise<void> | undefined;
  return { path, env, cleanup: () => cleanup ??= rm(directory, { recursive: true, force: true }) };
}

export function runRedactor(secrets: string[]): (message: string) => string {
  const values = [...new Set(secrets.filter(Boolean).flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  return message => values.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), message);
}

/** MCP errors or tool output may echo a grant; no event payload may reveal it. */
export function redactAgentEvent(event: AgentEvent, redact: (message: string) => string): AgentEvent {
  function value(input: unknown): unknown {
    if (typeof input === 'string') return redact(input);
    if (Array.isArray(input)) return input.map(value);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [redact(key), value(item)]));
    return input;
  }
  switch (event.type) {
    case 'error': return { ...event, message: redact(event.message) };
    case 'text-delta': case 'user-message': return { ...event, text: redact(event.text) };
    case 'tool-start': return { ...event, name: redact(event.name), input: value(event.input) };
    case 'tool-result': return { ...event, output: value(event.output) };
    default: return event;
  }
}
