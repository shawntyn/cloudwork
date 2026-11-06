// Deterministic OpenAI-compatible fixture. Tests tool transport and GUI execution,
// not a model's ability to understand screenshots. Never use in production.
import http from 'node:http';
const token = process.env.COMPUTER_FIXTURE_TOKEN || 'local-computer-model-fixture-token';
let calls = 0;
const actions = [
  {action:'key',key:'ctrl+l'}, {action:'type',text:'file:///workspace/computer-fixture.html'},
  {action:'key',key:'Return'}, {action:'wait',milliseconds:1000}, {action:'key',key:'Tab'},
  {action:'type',text:'DESKTOP_VERIFIED'}, {action:'key',key:'Tab'}, {action:'click',coordinate:[535,440],button:'left',count:1},
  {action:'wait',milliseconds:1000},
];
const server = http.createServer(async (req,res) => {
  if(req.url==='/health'){res.writeHead(200).end('fixture');return;}
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}
  try {
    let raw='';for await(const part of req){raw+=part;if(raw.length>16000000)throw new Error('Payload too large');}
    const body=JSON.parse(raw); const messages=body.messages || [];
    const text = value => typeof value==='string' ? value : Array.isArray(value) ? value.map(part=>part.text || '').join('\n') : '';
    const users = messages.filter(m=>m.role==='user').map(m=>text(m.content));
    const user = users.findLast(value => /Reply with exactly DESKTOP_NOT_NEEDED|Use the internal computer|TAKEOVER_FIXTURE|INDEPENDENT_RUN_FIXTURE|CONFIRM_FIXTURE|HANDOFF_FIXTURE/.test(value)) ?? users.at(-1) ?? '';
    if(body.model==='fixture-chat') console.log('Fixture request', JSON.stringify({users:users.map(value=>value.slice(0,180)),tools:body.tools?.map(t=>t.function?.name).filter(name=>name?.includes('computer'))}));
    let content,call;
    if(body.model==='fixture-vision'){
      const image=messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(p=>p.type==='image_url');
      if(!image?.image_url?.url?.startsWith('data:image/png;base64,iVBOR'))throw new Error('Missing real screenshot');
      const sequence=Math.max(0,...[...user.matchAll(/"sequence":(\d+)/g)].map(m=>Number(m[1])));
      if(user.includes('HANDOFF_FIXTURE')) content=JSON.stringify({kind:'handoff',reason:'Fixture requires manual takeover.'});
      else if(user.includes('CONFIRM_FIXTURE')) content=JSON.stringify(sequence===0?{kind:'confirmation',reason:'Approve one bounded fixture wait operation.',operation:{action:'wait',milliseconds:500}}:{kind:'done',result:'Approved fixture operation completed.'});
      else {
      const operation=user.includes('TAKEOVER_FIXTURE') ? {action:'wait',milliseconds:500+(sequence%2)*100} : actions[sequence];
      content=JSON.stringify(operation?{kind:'action',explanation:'Deterministic transport fixture step '+(sequence+1),operation}:{kind:'done',result:'Deterministic fixture finished; integration test independently verifies the downloaded file.'});
      }
    }else if(user.includes('DESKTOP_NOT_NEEDED')) content='DESKTOP_NOT_NEEDED';
    else if(user.includes('INDEPENDENT_RUN_FIXTURE')){await new Promise(r=>setTimeout(r,15000));content='INDEPENDENT_RUN_FINISHED';}
    else {
      const toolMessages=messages.filter(m=>m.role==='tool'), prior=toolMessages.map(m=>text(m.content)).join('\n').replaceAll('\\"','"');
      const ids=[...prior.matchAll(/ct_[a-f0-9-]+/g)],taskId=ids.at(-1)?.[0];
      if(/"state"\s*:\s*"completed"/.test(prior))content='Computer fixture completed.';
      else if(/"state"\s*:\s*"(?:failed|cancelled|interrupted)"/.test(prior))content='Computer fixture stopped; no automatic restart.';
      else {
        const cursors=[...prior.matchAll(/"pollCursor"\s*:\s*"([^"]+)"/g)],cursor=cursors.at(-1)?.[1];
        const suffix=taskId?'__status':'__start';const name=body.tools?.map(t=>t.function?.name).find(n=>n?.endsWith(suffix));
        if(!name)throw new Error('Internal computer tools not discovered');
        call={name,arguments:JSON.stringify(taskId?{taskId,waitSeconds:1,...(cursor?{cursor}:{})}:{requestId:'fixture-gui-task',goal:/TAKEOVER_FIXTURE|CONFIRM_FIXTURE|HANDOFF_FIXTURE/.exec(user)?.[0] || 'Open file:///workspace/computer-fixture.html in Chromium, type DESKTOP_VERIFIED, activate Save proof and verify the visible saved status.'})};
      }
    }
    const id='fixture-'+(++calls),usage={prompt_tokens:100,completion_tokens:20,total_tokens:120};
    if(body.stream){
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
      const emit=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
      if(call)emit({role:'assistant',tool_calls:[{index:0,id:'call_'+calls,type:'function',function:call}]});
      else for(const part of content.match(/.{1,12}/g)||[])emit({content:part});
      emit({},call?'tool_calls':'stop');res.write('data: '+JSON.stringify({id,choices:[],usage})+'\n\n');res.end('data: [DONE]\n\n');
    }else{res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage}));}
  }catch(error){console.error('Fixture error:',error.message);res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:error.message,type:'fixture_error'}}));}
});
server.listen(Number(process.env.COMPUTER_FIXTURE_PORT || 4052),'127.0.0.1',()=>console.log('Deterministic computer fixture listening on localhost'));
process.on('SIGTERM',()=>server.close());
