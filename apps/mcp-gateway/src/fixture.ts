import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { secureEqual } from './crypto.js';

export const fixtureToken = 'local-mcp-fixture-test-token';

function toolServer() {
  const server = new McpServer({ name: 'cloud-work-mcp-fixture', version: '0.1.0' });
  server.registerTool('cloudwork_add', {
    description: 'Add two numbers and return their sum.',
    inputSchema: { a: z.number().describe('First number to add.'), b: z.number().describe('Second number to add.') },
    outputSchema: { sum: z.number().describe('The sum of a and b.') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }], structuredContent: { sum: a + b } }));
  server.registerTool('cloudwork_echo', {
    description: 'Return the provided text unchanged.',
    inputSchema: { text: z.string().max(16_384).describe('Text to echo in the tool result.') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
  return server;
}

/** Deliberately stateless; the optional Compose test profile never publishes this port. */
export function createFixtureServer(token = process.env.MCP_FIXTURE_TOKEN || fixtureToken): Server {
  const server = createServer(async (request, response) => {
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    if (!secureEqual(request.headers.authorization ?? '', `Bearer ${token}`)) { response.writeHead(401).end('Unauthorized'); return; }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    const mcp = toolServer(), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const cleanup = async () => { await Promise.allSettled([transport.close(), mcp.close()]); };
    response.once('close', () => { void cleanup(); });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 256 * 1024) { response.writeHead(413).end('Request too large'); return; }
        chunks.push(bytes);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(400).end('Invalid MCP request');
      else response.end();
      await cleanup();
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createFixtureServer();
  const port = Number(process.env.PORT || 4100);
  server.listen(port, '0.0.0.0', () => { console.log(`MCP fixture listening on port ${port}`); });
  const shutdown = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
