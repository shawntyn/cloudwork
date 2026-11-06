import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
const web = new URL(process.env.WEB_UPSTREAM || 'http://web:3000');
const publicOrigin = new URL(process.env.BETTER_AUTH_URL || 'http://localhost:3000').origin;
const secret = process.env.DESKTOP_GATEWAY_TOKEN ?? '';
if (secret.length < 32) throw new Error('Desktop gateway token is required');
const assets = process.env.NOVNC_ROOT || '/usr/share/novnc';
const connections = new Map<string, number>();
interface Target { host: string; port: number; epoch: number; userId: string }
async function authorize(req: http.IncomingMessage, workspace: string, clientId: string, control: boolean): Promise<Target> {
  const response = await fetch(new URL('/api/desktop/authorize', web), { method: 'POST', headers: { 'content-type': 'application/json', 'x-desktop-gateway-token': secret, cookie: req.headers.cookie ?? '', origin: publicOrigin }, body: JSON.stringify({ workspaceId: workspace, clientId, control }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Unauthorized desktop connection'); }
  const target = await response.json() as Target;
  if (!/^cloud-desktop-[a-f0-9]{24}-control$/.test(target.host) || ![5900, 5901].includes(target.port) || typeof target.userId !== 'string') throw new Error('Invalid desktop destination');
  return target;
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', publicOrigin);
    if (url.pathname === '/gateway-health') { res.writeHead(200).end('ok'); return; }
    if (url.pathname.startsWith('/desktop/')) {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      let file: string;
      if (url.pathname === '/desktop/viewer') {
        const workspace = url.searchParams.get('workspace') || '', client = url.searchParams.get('clientId') || '';
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(workspace) || !/^[A-Za-z0-9_-]{1,100}$/.test(client)) throw new Error('Invalid workspace');
        await authorize(req, workspace, client, false);
        file = '/app/apps/desktop-gateway/viewer.html';
      } else {
        const relative = decodeURIComponent(url.pathname.slice('/desktop/'.length));
        file = path.resolve(assets, relative);
        if (!file.startsWith(path.resolve(assets) + path.sep) || !['.js', '.css', '.svg', '.png'].includes(path.extname(file))) throw new Error('Invalid asset');
      }
      const content = await readFile(file);
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'" });
      res.end(content); return;
    }
    const headers = { ...req.headers };
    delete headers['x-desktop-gateway-token']; delete headers['x-forwarded-host']; delete headers['x-forwarded-proto'];
    headers['x-forwarded-proto'] = new URL(publicOrigin).protocol.slice(0, -1);
    const upstream = http.request({ hostname: web.hostname, port: web.port || 80, method: req.method, path: req.url, headers, timeout: 900000 }, response => { res.writeHead(response.statusCode || 502, response.headers); response.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.on('timeout', () => upstream.destroy()); req.on('aborted', () => upstream.destroy()); res.on('close', () => { if (!res.writableFinished) upstream.destroy(); }); req.pipe(upstream);
  } catch { if (!res.headersSent) res.writeHead(403, { 'cache-control': 'no-store' }); res.end('Desktop unavailable or access denied'); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
server.on('upgrade', async (req, socket, head) => {
  try {
    if (req.headers.origin !== publicOrigin) throw new Error('Origin rejected');
    const url = new URL(req.url ?? '/', publicOrigin), workspace = url.searchParams.get('workspace') || '', client = url.searchParams.get('clientId') || '', control = url.searchParams.get('control') === '1';
    if (url.pathname !== '/desktop/socket' || !/^[A-Za-z0-9_-]{1,100}$/.test(workspace) || !/^[A-Za-z0-9_-]{1,100}$/.test(client)) throw new Error('Invalid desktop connection');
    const target = await authorize(req, workspace, client, control);
    if ((connections.get(target.userId) ?? 0) >= 8) throw new Error('Connection limit');
    connections.set(target.userId, (connections.get(target.userId) ?? 0) + 1);
    let released = false;
    const release = () => { if (!released) { released = true; connections.set(target.userId, Math.max(0, (connections.get(target.userId) ?? 1) - 1)); } };
    socket.once('close', release);
    wss.handleUpgrade(req, socket, head, ws => {
      const remote = net.createConnection({ host: target.host, port: target.port });
      let checking = false;
      const close = () => { clearInterval(timer); remote.destroy(); ws.terminate(); release(); };
      const timer = setInterval(() => { if (checking) return; checking = true; void authorize(req, workspace, client, control).then(next => { if (next.epoch !== target.epoch || next.port !== target.port || next.host !== target.host || next.userId !== target.userId) close(); }).catch(close).finally(() => { checking = false; }); }, 2000);
      remote.on('data', chunk => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 8 * 1024 * 1024) close(); else ws.send(chunk); } });
      ws.on('message', (data, binary) => { if (!binary || remote.writableLength > 1024 * 1024) { close(); return; } remote.write(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)); });
      remote.on('error', close); remote.on('close', close); ws.on('error', close); ws.on('close', close);
    });
  } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
});
server.requestTimeout = 900000;
server.listen(Number(process.env.PORT || 3000), '0.0.0.0');
process.on('SIGTERM', () => { for (const client of wss.clients) client.terminate(); server.close(); });
