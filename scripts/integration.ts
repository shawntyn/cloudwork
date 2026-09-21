import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
const stamp = Date.now();
const password = `CloudWork-${crypto.randomUUID()}`;
const results: string[] = [];
const pass = (name: string) => { results.push(name); console.log(`PASS ${name}`); };
async function req(route: string, cookie = '', method = 'GET', data?: unknown, expected = 200) {
  const response = await fetch(base+route,{method,headers:{cookie,origin:base,'content-type':'application/json'},...(data === undefined ? {} : {body:JSON.stringify(data)})});
  const value = await response.json();
  assert.equal(response.status,expected,`${method} ${route}: ${JSON.stringify(value)}`);
  return {value,response};
}
async function signup(label: string) {
  const email = `cloudwork-${label}-${stamp}@example.test`;
  const {value,response} = await req('/api/auth/sign-up/email','','POST',{email,password,name:`Verification ${label}`});
  const cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
  assert.ok(cookie); assert.ok(value.user.id);
  return {email,cookie,id:value.user.id};
}
await req('/api/workspaces','','GET',undefined,401); pass('Unauthenticated access denied');
const a = await signup('A'), b = await signup('B'); pass('Two separate Better Auth accounts registered');
const login = await req('/api/auth/sign-in/email','','POST',{email:a.email,password}); assert.ok(login.value.user.id === a.id); pass('Email/password login');
const create = async (cookie: string,name: string) => (await req('/api/workspaces',cookie,'POST',{name},201)).value.workspace;
const w1 = await create(a.cookie,'Runtime persistence check'), w2 = await create(a.cookie,'Shared runtime check'), other = await create(b.cookie,'Tenant isolation check');
const detail1 = (await req(`/api/workspaces/${w1.id}`,a.cookie)).value;
const detail2 = (await req(`/api/workspaces/${w2.id}`,a.cookie)).value;
const detailB = (await req(`/api/workspaces/${other.id}`,b.cookie)).value;
assert.equal(detail1.runtime.containerId,detail2.runtime.containerId); assert.notEqual(detail1.runtime.containerId,detailB.runtime.containerId); pass('One shared container per user; separate containers across users');
for (const suffix of ['', '/files', '/files/content?path=secret', '/sessions']) await req(`/api/workspaces/${w1.id}${suffix}`,b.cookie,'GET',undefined,404);
await req(`/api/workspaces/${w1.id}`,b.cookie,'DELETE',undefined,404);
await req(`/api/workspaces/${w1.id}/files/content`,b.cookie,'PUT',{path:'secret',content:'overwrite'},404); pass('Cross-tenant Workspace and file operations denied');
await req('/api/workspaces',a.cookie,'POST',{name:'invalid',path:'/etc'},400); pass('Caller supplied Workspace path rejected');
const files = `/api/workspaces/${w1.id}/files`;
await req(files,a.cookie,'POST',{operation:'mkdir',path:'src'});
await req(files+'/content',a.cookie,'PUT',{path:'src/hello.txt',content:'Persistent user files ✓'});
assert.equal((await req(files+'/content?path=src%2Fhello.txt',a.cookie)).value.content,'Persistent user files ✓');
await req(files,a.cookie,'POST',{operation:'rename',path:'src/hello.txt',to:'src/saved.txt'});
assert.equal((await req(files+'?path=src',a.cookie)).value.entries[0].name,'saved.txt'); pass('File mkdir/write/read/rename/list');
for (const bad of ['../home/.dsh','/etc/passwd','src/../../etc/passwd']) {
  const response = await fetch(base+files+'/content?path='+encodeURIComponent(bad),{headers:{cookie:a.cookie}});
  assert.ok(response.status >= 400,`Traversal allowed: ${bad}`);
} pass('Traversal denied through HTTP');
await req('/api/runtime',a.cookie,'POST',{action:'stop'});
assert.equal((await req('/api/runtime',a.cookie)).value.runtime.status,'STOPPED');
await req(`/api/workspaces/${w1.id}`,a.cookie);
assert.equal((await req(files+'/content?path=src%2Fsaved.txt',a.cookie)).value.content,'Persistent user files ✓'); pass('Stop then automatic resume preserves files');
await req('/api/runtime',a.cookie,'POST',{action:'remove'});
assert.equal((await req('/api/runtime',a.cookie)).value.runtime.status,'REMOVED');
await req(`/api/workspaces/${w1.id}`,a.cookie);
assert.equal((await req(files+'/content?path=src%2Fsaved.txt',a.cookie)).value.content,'Persistent user files ✓'); pass('Remove then recreate preserves files');
const session = (await req(`/api/workspaces/${w1.id}/sessions`,a.cookie,'POST',{},201)).value.session;
await req(`/api/sessions/${session.id}/messages`,b.cookie,'POST',{prompt:'unauthorized'},404);
await req(`/api/sessions/${session.id}/cancel`,b.cookie,'POST',{},404);
await req(`/api/sessions/${session.id}/events`,b.cookie,'GET',undefined,404); pass('Session, SSE and cancel ownership enforced');
const controller = new AbortController();
const events: any[] = [];
const readEvents = (async () => {
 const response = await fetch(`${base}/api/sessions/${session.id}/events`,{headers:{cookie:a.cookie},signal:controller.signal});
 assert.equal(response.status,200); assert.ok(response.headers.get('content-type')?.includes('text/event-stream'));
 const reader = response.body!.getReader(); const decoder = new TextDecoder(); let pending = '';
 try { while(true) { const {value,done} = await reader.read(); if(done)break; pending += decoder.decode(value,{stream:true}); let end;
   while((end = pending.indexOf('\n\n')) >= 0) { const frame = pending.slice(0,end); pending=pending.slice(end+2);
    for(const line of frame.split('\n')) if(line.startsWith('data: ')) { const event=JSON.parse(line.slice(6));events.push(event); if(event.type==='status' && ['idle','stopped','error'].includes(event.status)){controller.abort();return;} }
   }
 } } catch(error) { if(!controller.signal.aborted) throw error; }
})();
const timeout = setTimeout(()=>controller.abort(),180000);
await req(`/api/sessions/${session.id}/messages`,a.cookie,'POST',{prompt: process.env.TEST_PROMPT ?? 'Read src/saved.txt, then write agent-proof.txt containing CLOUD_WORK_VERIFIED. Read it back to verify, then respond in three short sentences describing what you read, wrote, and verified.'},202);
await readEvents; clearTimeout(timeout);
assert.ok(events.some(e=>e.type==='user-message')); assert.ok(events.some(e=>e.type==='status' && e.status==='starting'));
assert.ok(events.some(e=>e.type==='status' && ['idle','stopped','error'].includes(e.status)),'Missing terminal event');
if(process.env.EXPECT_LLM_SUCCESS === '1') {
 assert.ok(!events.some(e=>e.type==='error'),JSON.stringify(events.filter(e=>e.type==='error')));
 assert.ok(events.filter(e=>e.type==='text-delta').length > 1,'Expected incremental text chunks for the requested three-sentence answer');
 assert.ok(events.some(e=>e.type==='tool-start'));assert.ok(events.some(e=>e.type==='tool-result'));
 assert.ok((await req(files+'/content?path=agent-proof.txt',a.cookie)).value.content.includes('CLOUD_WORK_VERIFIED'));pass('Real DSH model execution + tool + streaming output');
} else { pass('SSE streamed startup and terminal outcome (LLM success not assumed)'); }
await req(`/api/sessions/${session.id}/cancel`,a.cookie,'POST',{}); pass('Stop endpoint remains callable');
await req(files+'?path=src%2Fsaved.txt',a.cookie,'DELETE'); pass('File deletion');
await mkdir('artifacts',{recursive:true});await mkdir('.cache',{recursive:true});
await writeFile('.cache/integration-account.json',JSON.stringify({email:a.email,password,workspaceId:w1.id,sessionId:session.id}),{mode:0o600});
await writeFile('artifacts/integration.json',JSON.stringify({base,at:new Date().toISOString(),results,events,users:[a.id,b.id],workspaces:[w1.id,w2.id,other.id],sessionId:session.id},null,2));
console.log(`Verified ${results.length} checks. Detailed report: artifacts/integration.json`);
