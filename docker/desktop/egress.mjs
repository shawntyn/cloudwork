import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
const denied = ip => {
  if (net.isIP(ip) !== 4) return true;
  const [a,b,c] = ip.split('.').map(Number);
  return a===0 || a===10 || a===127 || a>=224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&(b===168 || b===0 || (b===88&&c===99))) || (a===100&&b>=64&&b<=127) || (a===198&&(b===18||b===19||b===51)) || (a===203&&b===0&&c===113);
};
const allowedOrigins = new Set((process.env.DESKTOP_ALLOWED_ORIGINS || '').split(',').filter(Boolean).map(value => {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.trim() || url.username || url.password) throw new Error('Invalid desktop origin');
  return url.origin;
}));
const allowedIPs = new Set((process.env.DESKTOP_ALLOWED_PRIVATE_IPS || '').split(',').filter(Boolean).map(value => {
  value = value.trim(); if (net.isIP(value) !== 4) throw new Error('Desktop private allowlist requires explicit IPv4 addresses'); return value;
}));
const number = ip => ip.split('.').reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
const blockedNetworks = (process.env.DESKTOP_BLOCKED_NETWORKS || '').split(',').filter(Boolean).map(cidr => {
  const [ip, size] = cidr.split('/'); if (net.isIP(ip) !== 4 || !/^\d+$/.test(size) || Number(size)>32) throw new Error('Invalid blocked network');
  return { address: number(ip), mask: Number(size) === 0 ? 0 : (0xffffffff << (32-Number(size))) >>> 0 };
});
export async function destination(host, port, resolver=lookup, protocol='https:') {
  if (host.length>253 || !Number.isInteger(Number(port)) || Number(port)<1 || Number(port)>65535) throw new Error('Blocked destination');
  const origin = new URL(`${protocol}//${host}:${port}`).origin, explicitlyAllowed = allowedOrigins.has(origin);
  if (![80,443].includes(Number(port)) && !explicitlyAllowed) throw new Error('Blocked destination');
  const addresses=await resolver(host,{all:true,family:4});
  if (!addresses.length || addresses.some(({address: ip}) => {
    if (net.isIP(ip)!==4) return true;
    const [a,b] = ip.split('.').map(Number);
    if (a===0 || a===127 || a>=224 || (a===169&&b===254) || blockedNetworks.some(({address,mask}) => (number(ip)&mask)===(address&mask))) return true;
    return denied(ip) && !(explicitlyAllowed && allowedIPs.has(ip));
  })) throw new Error('Blocked destination');
  return addresses[0].address;
}
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url); if(url.protocol!=='http:'||url.username||url.password)throw new Error('Blocked protocol');
    const port=Number(url.port||80),host=await destination(url.hostname,port,lookup,'http:'),headers={...req.headers,host:url.host};
    delete headers['proxy-authorization'];delete headers['proxy-connection'];
    const remote=http.request({host,port,method:req.method,path:url.pathname+url.search,headers,timeout:60000},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});
    remote.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()});remote.on('timeout',()=>remote.destroy());req.on('aborted',()=>remote.destroy());res.on('close',()=>{if(!res.writableFinished)remote.destroy()});req.pipe(remote);
  }catch{res.writeHead(403).end('Destination blocked')}
});
server.on('connect',async(req,socket,head)=>{
  try{
    const url=new URL('https://'+req.url);if(url.username||url.password||url.pathname!=='/')throw new Error('Blocked destination');
    const port=Number(url.port||443),host=await destination(url.hostname,port),remote=net.connect({host,port});
    remote.setTimeout(60000,()=>remote.destroy());socket.setTimeout(60000,()=>socket.destroy());
    remote.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);socket.pipe(remote).pipe(socket)});
    remote.on('error',()=>socket.destroy());remote.on('close',()=>socket.destroy());socket.on('error',()=>remote.destroy());socket.on('close',()=>remote.destroy());
  }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')}
});
server.maxConnections=128;server.requestTimeout=60000;server.headersTimeout=10000;
if(process.env.NODE_ENV!=='test')server.listen(Number(process.env.PORT||3128),'0.0.0.0');
