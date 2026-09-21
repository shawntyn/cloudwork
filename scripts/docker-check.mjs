import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const report=JSON.parse(await readFile('artifacts/integration.json','utf8'));
const account=JSON.parse(await readFile('.cache/integration-account.json','utf8'));
const docker=(args)=>execFileSync('docker',args,{encoding:'utf8'});
const inspect=(name)=>JSON.parse(docker(['inspect',name]))[0];
const base=report.base;
const login=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({email:account.email.replace('-A-','-B-'),password:account.password})});
assert.equal(login.status,200);
const cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
const [userA,userB]=report.users;
const retained=docker(['compose','exec','-T','-e','VERIFY_USER_ID='+userB,'-e','VERIFY_WORKSPACE_ID='+report.workspaces[2],'runtime-manager','node','-e',"const fs=require('fs'),p=require('path');const root=p.join(process.env.USER_DATA_ROOT,process.env.VERIFY_USER_ID);if(!fs.statSync(p.join(root,'home')).isDirectory()||!fs.statSync(p.join(root,'workspaces',process.env.VERIFY_WORKSPACE_ID)).isDirectory())process.exit(1);console.log('retained')"]);
assert.match(retained,/retained/);
const restored=await fetch(base+`/api/workspaces/${report.workspaces[2]}`,{headers:{cookie}});
assert.equal(restored.status,200);
const a=inspect('cloud-work-runtime-'+userA),b=inspect('cloud-work-runtime-'+userB), manager=inspect('cloud-work-runtime-manager'),web=inspect('cloud-work-web-1');
for(const info of [a,b]) {
 assert.equal(info.Config.User,'1000:1000');assert.equal(info.HostConfig.Privileged,false);
 assert.ok(info.HostConfig.CapDrop.includes('ALL'));assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
 assert.equal(info.HostConfig.NanoCpus,2e9);assert.equal(info.HostConfig.Memory,4096*1024*1024);assert.equal(info.HostConfig.PidsLimit,256);
 assert.ok(!info.Mounts.some(m=>m.Source.includes('docker.sock')));assert.ok(info.Mounts.some(m=>m.Type==='bind'&&m.Destination==='/home/work'));
 assert.ok(info.Mounts.some(m=>m.Type==='bind'&&m.Destination==='/home/work/workspaces'));
 assert.ok(!Object.keys(info.HostConfig.PortBindings??{}).length);
 const keys=info.Config.Env.map(x=>x.split('=')[0]);
 for(const secret of ['DATABASE_URL','REDIS_URL','MANAGER_TOKEN','RUNTIME_TOKEN_SECRET','BETTER_AUTH_SECRET'])assert.ok(!keys.includes(secret));
 assert.ok(!info.NetworkSettings.Networks['cloud-work_platform']);
}
assert.ok(!web.Mounts.some(m=>m.Source.includes('docker.sock')));assert.ok(manager.Mounts.some(m=>m.Source.includes('docker.sock')));
const targets=Object.values(b.NetworkSettings.Networks).map(n=>n.IPAddress);
for(const address of targets) {
 const script=`fetch('http://${address}:3080/health',{signal:AbortSignal.timeout(1500)}).then(r=>{console.error('Cross-tenant service reached:',r.status);process.exit(1)}).catch(()=>console.log('blocked'))`;
 assert.match(docker(['exec',a.Name.slice(1),'node','-e',script]),/blocked/);
}
const managerControl=Object.entries(manager.NetworkSettings.Networks).find(([name])=>name.startsWith('cloud-work-control-')&&a.NetworkSettings.Networks[name])?.[1].IPAddress;
assert.ok(managerControl);
assert.match(docker(['exec',a.Name.slice(1),'node','-e',`fetch('http://${managerControl}:4000/internal/users/${userA}/status').then(r=>{if(r.status!==401)process.exit(1);console.log('denied')})`]),/denied/);
assert.match(docker(['exec',a.Name.slice(1),'node','-e',"fetch('http://127.0.0.1:3080/health').then(r=>{if(r.status!==401)process.exit(1);console.log('denied')})"]),/denied/);
const result={dataRetainedAfterReaper:true,cpuCores:2,memoryMiB:4096,pids:256,nonRoot:true,capabilitiesDropped:true,privileged:false,dockerSocketOnlyManager:true,noPlatformCredentials:true,noRuntimeHostPorts:true,crossTenantNetworksBlocked:targets.length,managerApiRejectsRuntime:true,runtimeApiRequiresToken:true};
await writeFile('artifacts/docker-security.json',JSON.stringify(result,null,2));console.log(result);
