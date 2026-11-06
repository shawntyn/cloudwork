import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { actionSchema, sameSecret, type ComputerAction } from '@cloud-work/computer';

const secret = process.env.DESKTOP_CONTROL_TOKEN ?? '';
if (secret.length < 32) throw new Error('Desktop controller requires an independent token');
let epoch = -1, owner = '', expires = 0, mode = 'idle', revoking = false;
let active: ChildProcess | undefined;
let line: Promise<unknown> = Promise.resolve();
let controlLine: Promise<unknown> = Promise.resolve();
let expiryQueued = false;
const actions = new Map<number, string>();
let lastSequence = 0;
let writable: ChildProcess | undefined;
const children = new Set<ChildProcess>();
function processRun(command: string, args: string[], timeout = 15000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { PATH: '/usr/bin:/bin', DISPLAY: ':99', HOME: '/tmp' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    active = child; children.add(child);
    const chunks: Buffer[] = []; let length = 0;
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, timeout);
    child.stdout!.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 8 * 1024 * 1024) kill(); else chunks.push(chunk); });
    child.stderr!.resume();
    child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('close', code => { clearTimeout(timer); children.delete(child); if (active === child) active = undefined; code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('Desktop action interrupted or failed')); });
  });
}
function vnc(port: number, readonly: boolean) {
  const child = spawn('x11vnc', ['-display', ':99', '-rfbport', String(port), '-forever', '-shared', '-nopw', '-noxdamage', '-noshm', '-norc', '-noclipboard', '-nosetclipboard', '-noprimary', '-nosetprimary', ...(readonly ? ['-viewonly'] : [])], { stdio: 'ignore' });
  child.on('error', () => {});
  return child;
}
async function revoke() {
  revoking = true; expires = 0; owner = ''; mode = 'idle';
  writable?.kill('SIGKILL'); writable = undefined;
  for (const child of children) { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }
  await line.catch(() => {});
  await processRun('xdotool', ['mouseup', '1', 'mouseup', '2', 'mouseup', '3', 'keyup', 'Control_L', 'Shift_L', 'Alt_L', 'Super_L']).catch(() => {});
  revoking = false;
}
function allowed(value: Record<string, unknown>) {
  if (revoking || expires <= performance.now() || value.epoch !== epoch || value.owner !== owner || mode !== 'ai') throw new Error('Desktop control was revoked');
}
async function execute(action: ComputerAction) {
  const xdo = (...args: string[]) => processRun('xdotool', args);
  switch (action.action) {
    case 'click': await xdo('mousemove', ...action.coordinate.map(String), 'click', '--repeat', String(action.count), String({ left: 1, middle: 2, right: 3 }[action.button])); break;
    case 'move': await xdo('mousemove', ...action.coordinate.map(String)); break;
    case 'drag': await xdo('mousemove', ...action.from.map(String), 'mousedown', '1', 'mousemove', ...action.to.map(String), 'mouseup', '1'); break;
    case 'type': await xdo('type', '--clearmodifiers', '--delay', '1', '--', action.text); break;
    case 'key': await xdo('key', '--clearmodifiers', action.key.replace(/ctrl/g, 'Control_L').replace(/alt/g, 'Alt_L').replace(/shift/g, 'Shift_L').replace(/super/g, 'Super_L')); break;
    case 'scroll': if (action.coordinate) await xdo('mousemove', ...action.coordinate.map(String)); await xdo('click', '--repeat', String(action.amount), String({ up: 4, down: 5, left: 6, right: 7 }[action.direction])); break;
    case 'wait': await new Promise(resolve => setTimeout(resolve, action.milliseconds)); break;
  }
}
async function body(req: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 128000) throw new Error('Request too large'); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}
for (let attempt = 0; ; attempt++) { try { await processRun('xdpyinfo', []); break; } catch (error) { if (attempt >= 100) throw error; await new Promise(resolve => setTimeout(resolve, 200)); } }
const readonly = vnc(5901, true);
setInterval(() => { if (expires && expires <= performance.now() && !revoking && !expiryQueued) { expiryQueued = true; controlLine = controlLine.then(async () => { if (expires && expires <= performance.now()) await revoke(); }).finally(() => { expiryQueued = false; }); } }, 500).unref();
const server = createServer(async (req, res) => {
  const json = (code: number, value: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value)); };
  if (!sameSecret(req.headers.authorization ?? '', 'Bearer ' + secret)) return json(401, { error: 'Unauthorized' });
  try {
    if (req.method === 'GET' && req.url === '/health') {
      await access('/tmp/.X11-unix/cloud-work-ready');
      if (readonly.exitCode !== null || readonly.signalCode !== null) throw new Error('VNC unavailable');
      await processRun('xdpyinfo', []); return json(200, { ok: true, epoch, mode, busy: Boolean(active) });
    }
    if (req.method === 'POST' && req.url === '/lease') {
      const value = await body(req);
      const renewal = controlLine.then(async () => {
      if (!Number.isSafeInteger(value.epoch) || Number(value.epoch) < epoch || typeof value.owner !== 'string' || !['idle', 'manual', 'ai'].includes(String(value.mode))) throw new Error('Invalid control lease');
      if (value.epoch === epoch && (value.owner !== owner || value.mode !== mode)) throw new Error('Epoch conflict');
      if (Number(value.epoch) > epoch) {
        await revoke(); epoch = Number(value.epoch); owner = value.owner; mode = String(value.mode); actions.clear(); lastSequence = 0;
        if (mode === 'manual') writable = vnc(5900, false);
      }
      expires = performance.now() + 10000;
      });
      controlLine = renewal.catch(() => {}); await renewal;
      return json(200, { ok: true, epoch });
    }
    if (req.method === 'POST' && req.url === '/screenshot') {
      const value = await body(req); allowed(value);
      const png = await processRun('import', ['-window', 'root', '-strip', 'png:-']); allowed(value);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(png); return;
    }
    if (req.method === 'POST' && req.url === '/manual-clipboard') {
      const value = await body(req);
      if (revoking || expires <= performance.now() || value.epoch !== epoch || value.owner !== owner || mode !== 'manual') throw new Error('Manual control revoked');
      const text = await processRun('xclip', ['-o', '-selection', 'clipboard'], 3000);
      if (revoking || expires <= performance.now() || value.epoch !== epoch || value.owner !== owner || mode !== 'manual') throw new Error('Manual control revoked');
      return json(200, { text: text.toString('utf8').slice(0, 16000) });
    }
    if (req.method === 'POST' && req.url === '/manual-input') {
      const value = await body(req);
      const text = actionSchema.parse({ action: 'type', text: value.text });
      const pending = line.then(async () => {
        if (revoking || expires <= performance.now() || value.epoch !== epoch || value.owner !== owner || mode !== 'manual') throw new Error('Manual control revoked');
        await execute(text);
      });
      line = pending.catch(() => {}); await pending;
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/action') {
      const value = await body(req), operation = actionSchema.parse(value.operation);
      if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) throw new Error('Invalid sequence');
      const fingerprint = JSON.stringify(operation), sequence = Number(value.sequence);
      const pending = line.then(async () => {
        allowed(value);
        if (actions.has(sequence)) { if (actions.get(sequence) !== fingerprint) throw new Error('Action conflict'); throw new Error('Action already attempted; observe instead of retrying'); }
        if (sequence <= lastSequence) throw new Error('Stale action');
        actions.set(sequence, fingerprint); lastSequence = sequence;
        await execute(operation); allowed(value);
      });
      line = pending.catch(() => {}); await pending;
      return json(200, { ok: true });
    }
    json(404, { error: 'Not found' });
  } catch { if (!res.headersSent) json(409, { error: 'Desktop operation rejected or interrupted' }); else res.destroy(); }
});
server.requestTimeout = 20000;
server.listen(8080, '0.0.0.0');
const close = () => { void revoke().finally(() => { readonly.kill(); server.close(); process.exit(0); }); };
process.on('SIGTERM', close); process.on('SIGINT', close);
