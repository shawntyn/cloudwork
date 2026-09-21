/** Real provider + real DSH bash execution: offline tools still produce useful artifacts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DshRuntime } from '@cloud-work/runtime-dsh';
import type { AgentEvent } from '@cloud-work/runtime-core';
import { verifySandbox } from './sandbox.ts';

const workspace = `/home/work/workspaces/ws_offline_${randomUUID()}`;
const sessionId = `sess_${randomUUID()}`;
await mkdir(workspace, { mode: 0o700 });
await writeFile(join(workspace, 'verify.py'), `import errno, json, socket, subprocess
import numpy as np
import pandas as pd
import yaml
import docx
from docx import Document

blocked = []
for family in (socket.AF_INET, socket.AF_INET6):
    for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        try:
            connection = socket.socket(family, kind)
        except OSError as error:
            assert error.errno in (errno.EPERM, errno.EACCES), repr(error)
            blocked.append([int(family), int(kind), error.errno])
        else:
            connection.close()
            raise AssertionError('Workspace unexpectedly permits an IP socket')

data = pd.DataFrame({'value': np.arange(1, 4)})
total = int(data['value'].sum())
assert total == 6
data.to_csv('values.csv', index=False)
document = Document()
document.add_paragraph('Offline document: ' + str(total))
document.save('result.docx')
assert Document('result.docx').paragraphs[0].text == 'Offline document: 6'
with open('result.yaml', 'w') as stream:
    yaml.safe_dump({'total': total}, stream)
with open('result.yaml') as stream:
    assert yaml.safe_load(stream) == {'total': 6}
node = subprocess.run(['node', 'verify-node.cjs'], text=True, capture_output=True, check=True)
report = {'python': {'numpy': np.__version__, 'pandas': pd.__version__, 'python-docx': docx.__version__, 'PyYAML': yaml.__version__}, 'total': total, 'blockedSockets': blocked, 'node': json.loads(node.stdout)}
with open('sandbox-proof.json', 'w') as stream:
    json.dump(report, stream)
print('OFFLINE_WORKSPACE_VERIFIED')
`);
await writeFile(join(workspace, 'verify-node.cjs'), `const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
(async () => {
  const blocked = [];
  for (const host of ['127.0.0.1', '1.1.1.1', '::1']) {
    await new Promise((resolve, reject) => {
      const socket = net.connect({host, port: 80});
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Network timed out instead of being denied')); });
      socket.on('connect', () => { socket.destroy(); reject(new Error('Network allowed')); });
      socket.on('error', error => { try { assert.ok(['EPERM','EACCES'].includes(error.code), error.code); blocked.push(error.code); resolve(); } catch (failure) { reject(failure); } });
    });
  }
  await new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', error => { try { assert.ok(['EPERM','EACCES'].includes(error.code), error.code); blocked.push(error.code); socket.close(); resolve(); } catch (failure) { reject(failure); } });
    socket.bind(0, () => { socket.close(); reject(new Error('UDP allowed')); });
  });
  const hash = crypto.createHash('sha256').update(fs.readFileSync('values.csv')).digest('hex');
  console.log(JSON.stringify({version: process.version, blocked, csvSha256: hash}));
})().catch(error => { console.error(error); process.exitCode = 1; });
`);

const scriptInputs = await Promise.all(['verify.py', 'verify-node.cjs'].map(file => readFile(join(workspace, file))));
const runtime = new DshRuntime();
await runtime.createSession({ sessionId, workspacePath: workspace });
const events: AgentEvent[] = [];
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; void runtime.cancel(sessionId).catch(() => {}); }, 180_000);
try {
  for await (const event of runtime.run({ sessionId, prompt: 'Use your bash tool to run exactly `python verify.py` in the current workspace. Do not edit either verification script. If the command fails, report the error without modifying any file. If it succeeds, read sandbox-proof.json and briefly confirm the offline Python and Node results.' })) {
    events.push(event);
    if (event.type === 'tool-start') console.log(JSON.stringify({ progress: event.type, name: event.name }));
    if (event.type === 'error') console.log(JSON.stringify(event));
  }
  assert.equal(timedOut, false, 'Offline workspace smoke timed out');
  assert.ok(!events.some(event => event.type === 'error'), 'Provider or DSH failed');
  assert.ok(events.some(event => event.type === 'tool-start' && /bash/.test(event.name)), 'Expected actual bash execution');
  assert.deepEqual(events.at(-1), { type: 'status', status: 'idle' });
  for (const [index, file] of ['verify.py', 'verify-node.cjs'].entries()) {
    assert.deepEqual(await readFile(join(workspace, file)), scriptInputs[index], `Agent changed ${file}`);
  }
  const proof = JSON.parse(await readFile(join(workspace, 'sandbox-proof.json'), 'utf8'));
  assert.equal(proof.total, 6);
  assert.equal(proof.blockedSockets.length, 4);
  assert.equal(proof.node.blocked.length, 4);
  assert.equal((await readFile(join(workspace, 'result.docx'))).subarray(0, 2).toString(), 'PK');
  console.log(JSON.stringify({ workspace, sessionId, sandbox: verifySandbox(), proof,
    textChunks: events.filter(event => event.type === 'text-delta').length,
    tools: events.filter(event => event.type === 'tool-start').map(event => event.name),
    provider: process.env.DSH_PROVIDER, model: process.env.DSH_MODEL,
  }));
} finally {
  clearTimeout(timeout);
  await runtime.destroySession(sessionId);
}
