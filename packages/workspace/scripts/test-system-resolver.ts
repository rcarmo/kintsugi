import { mkdtemp, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
// Disposable privileged namespaces; never changes host DNS or live installations.
const root = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const image = process.argv[2];
if (!image || process.argv.length !== 3) throw new Error("Pass a local image containing Bun, ip, nft and openssl; System/proxy source is bundled from this checkout");
const directory = await mkdtemp(join(tmpdir(), "system-dns-integration-"));
const name = `kintsugi-system-dns-${crypto.randomUUID()}`;
async function docker(args: string[]) {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  assert.equal(code, 0, error || out);
  return out;
}
const upstream = `import{createSocket}from'node:dgram';import{readFileSync}from'node:fs';
for(const [address,code]of[['10.250.0.53',3],['10.250.0.54',0]]){
  const s=createSocket('udp4');
  s.on('message',(q,r)=>{
    const address=readFileSync('/tmp/dns-answer.txt','utf8').trim();
    const responseCode=address==='missing'?3:code;
    const h=Buffer.from(q.subarray(0,12));const positive=responseCode===0&&q.readUInt16BE(q.length-4)===1;
    h.writeUInt16BE(0x8180|responseCode,2);h.writeUInt16BE(positive?1:0,6);
    const a=positive?Buffer.from(address.split('.').map(Number)):undefined;
    const rr=a?Buffer.from([0xc0,12,0,1,0,1,0,0,0,60,0,4,...a]):Buffer.alloc(0);
    s.send(Buffer.concat([h,q.subarray(12),rr]),r.port,r.address);
  });
  await new Promise((resolve,reject)=>{s.once('error',reject);s.bind(53,address,resolve)});
}
for(const address of ['192.168.10.20','192.168.10.21'])for(const port of [4545,4546]){
  Bun.serve({hostname:address,port,fetch:()=>new Response(address+':'+port)});
}
console.log('fixture-ready');`;
const probe = `import assert from'node:assert/strict';import dns from'node:dns/promises';import{connect}from'node:net';
const [address,expected,port]=process.argv.slice(2);const allowed=expected==='yes';
if(port){await new Promise(resolve=>{const s=connect({host:address,port:Number(port)});s.setTimeout(250);s.once('connect',()=>{s.destroy();assert.equal(allowed,true);resolve()});s.once('error',()=>{assert.equal(allowed,false);resolve()});s.once('timeout',()=>{s.destroy();assert.equal(allowed,false);resolve()})})}
else{const r=new dns.Resolver({timeout:100,tries:1});r.setServers([address]);let a;try{a=await r.resolve4('printer.local')}catch(e){if(allowed)throw e;}if(allowed)assert.deepEqual(a,['192.168.10.20']);else assert.equal(a,undefined)};`;
const control = `import assert from'node:assert/strict';import{readFile,writeFile,mkdir}from'node:fs/promises';import{lookupNetworkHost}from'${root}/packages/shared/src/network-lookup.ts';import{createWorkspaceMetadataState}from'${root}/packages/workspace/src/metadata-state.ts';import{createWorkspaceSecretContext}from'${root}/packages/proxy-egress/src/secrets/workspace-secrets.ts';import{lookupWorkspaceHost}from'${root}/packages/proxy-egress/src/egress/workspace-dns.ts';import{startWorkspaceEgressProxy}from'${root}/packages/proxy-egress/src/egress/egress-proxy.ts';import{ensureMitmCa}from'${root}/packages/proxy-egress/src/egress/mitm-ca.ts';import{request as httpRequest}from'node:http';import{createWorkspaceNetworkControl,workspaceNetworkBridge}from'${root}/images/system/src/workspace-network.ts';import{command}from'${root}/images/system/src/process.ts';
await mkdir('/sys/fs/cgroup/system/build-clients',{recursive:true});const config={cidrs:['192.168.10.0/24'],dns:['10.250.0.53','10.250.0.54'],search:[]};const path='/tmp/policies.json';
async function probe(client,address,expected,port){await command(['ip','netns','exec',client,'bun','/fixtures/probe.js',address,expected,...(port?[String(port)]:[])])}
if(process.argv[2]==='restore'){const before=JSON.parse(await readFile(path,'utf8'));await createWorkspaceNetworkControl('/system/build-clients',path);await probe('one',before.one.resolver,'yes');assert.deepEqual(before.one.destinations[0].addresses,['192.168.10.21']);assert.deepEqual((await lookupNetworkHost('db.internal',before.one)).map(answer=>answer.address),['192.168.10.20']);await probe('one','192.168.10.21','yes',4545);await probe('one','192.168.10.20','no',4545);console.log('PASS saved System resolver and pinned grants restore without re-resolving before Docker startup');process.exit(0)}
await command(['ip','netns','add','lan']);await command(['ip','link','add','uplink','type','veth','peer','name','endpoint']);await command(['ip','link','set','endpoint','netns','lan']);await command(['ip','link','set','uplink','up']);await command(['ip','addr','add','10.250.0.1/24','dev','uplink']);await command(['ip','-n','lan','link','set','lo','up']);await command(['ip','-n','lan','link','set','endpoint','up']);for(const ip of ['10.250.0.53','10.250.0.54'])await command(['ip','-n','lan','addr','add',ip+'/24','dev','endpoint']);
await command(['ip','addr','add','192.168.10.1/24','dev','uplink']);for(const address of ['192.168.10.20','192.168.10.21'])await command(['ip','-n','lan','addr','add',address+'/24','dev','endpoint']);await command(['ip','-n','lan','route','add','default','via','10.250.0.1']);
for(const [i,id]of ['one','two','off'].entries()){const bridge=workspaceNetworkBridge(id);await command(['ip','link','add',bridge,'type','bridge']);await command(['ip','addr','add','172.29.'+(i+1)+'.1/24','dev',bridge]);await command(['ip','link','set',bridge,'up']);await command(['ip','netns','add',id]);await command(['ip','link','add','p'+i,'type','veth','peer','name','c'+i]);await command(['ip','link','set','p'+i,'master',bridge]);await command(['ip','link','set','p'+i,'up']);await command(['ip','link','set','c'+i,'netns',id]);await command(['ip','-n',id,'link','set','lo','up']);await command(['ip','-n',id,'link','set','c'+i,'up']);await command(['ip','-n',id,'addr','add','172.29.'+(i+1)+'.2/24','dev','c'+i]);await command(['ip','-n',id,'route','add','default','via','172.29.'+(i+1)+'.1'])}
await writeFile('/tmp/dns-answer.txt','192.168.10.20');const child=Bun.spawn(['ip','netns','exec','lan','bun','/fixtures/upstream.js'],{stdout:'pipe',stderr:'inherit'});const reader=child.stdout.getReader();const ready=await Promise.race([reader.read(),Bun.sleep(5000).then(()=>{throw new Error('DNS/service fixture did not start')})]);assert.ok(new TextDecoder().decode(ready.value).includes('fixture-ready'));reader.releaseLock();
const request=await createWorkspaceNetworkControl('/system/build-clients',path);assert.equal((await command(['ip','-j','link','show'])).includes('kintsugi-dns'),false);await request({workspaceId:'one',mode:'lan',configuration:{...config,dns:[]}});assert.equal((await command(['ip','-j','link','show'])).includes('kintsugi-dns'),false);console.log('PASS default/empty configuration opens no System DNS listener, including LAN mode');
const one=await request({workspaceId:'one',mode:'lan',configuration:config});const two=await request({workspaceId:'two',mode:'lan',configuration:{...config,dns:['10.250.0.53']}});await probe('one',one.resolver,'yes');await probe('one',one.resolver,'yes',53);await probe('two',two.resolver,'no');await probe('two',one.resolver,'no');await probe('two',one.resolver,'no',53);await probe('off',one.resolver,'no');console.log('PASS native DNS NXDOMAIN fallback, separate snapshot views, TCP/UDP ownership and Off isolation');
await command(['mount','--bind',path,path]);await assert.rejects(request({workspaceId:'one',mode:'off',configuration:{cidrs:[],dns:[],search:[]}}));await command(['umount',path]);await probe('one',one.resolver,'yes');console.log('PASS failed persistence restores the prior DNS view and firewall policy');
const management=Bun.serve({hostname:one.resolver,port:8080,fetch:()=>new Response('management')});await probe('one',one.resolver,'no',8080);management.stop(true);console.log('PASS resolver address grants no management-port access');

// Real System application resolves through its DNS view and installs the pinned TCP tuple.
await probe('one','192.168.10.20','yes',4545);await probe('one','192.168.10.21','yes',4545);await probe('one','192.168.10.20','yes',4546);
const hostsRequest={workspaceId:'one',mode:'hosts',configuration:config,destinations:[{host:'db.internal',port:4545}]};
const pinned=await request(hostsRequest);assert.deepEqual(pinned.cidrs,[]);assert.deepEqual(pinned.destinations,[{host:'db.internal',port:4545,addresses:['192.168.10.20']}]);
await probe('one','192.168.10.20','yes',4545);await probe('one','192.168.10.20','no',4546);await probe('one','192.168.10.21','no',4545);await probe('off','192.168.10.20','no',4545);
console.log('PASS listed host resolves through System fallback and grants only its owning workspace TCP tuple');
// Real app-owned policy, proxy lookup, policy hooks and HTTP forwarding. No mock DNS or upstream fetch.
process.env.KINTSUGI_DATA_DIR='/tmp/proxy-app';
const metadata=createWorkspaceMetadataState('network.json',value=>value,()=>({mode:'hosts',applied:pinned}));metadata.write('one',{mode:'hosts',applied:pinned});
const secretContext=await createWorkspaceSecretContext('one');
const proxy=await startWorkspaceEgressProxy({socketPath:'/tmp/egress.sock',ca:await ensureMitmCa(),getContext:async()=>secretContext,upstreamDnsLookup:hostname=>lookupWorkspaceHost('one',hostname),upstreamProxyForUrl:()=>''});
async function proxied(target){return await new Promise((resolve,reject)=>{const req=httpRequest({socketPath:'/tmp/egress.sock',path:target,headers:{host:new URL(target).host}},response=>{let body='';response.setEncoding('utf8');response.on('data',data=>body+=data);response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode,body}))});req.setTimeout(5000,()=>req.destroy(new Error('Proxy fixture timed out')));req.on('error',reject);req.end()})}
assert.deepEqual(await proxied('http://db.internal:4545/'),{status:200,body:'192.168.10.20:4545'});
for(const target of ['http://db.internal:4546/','http://alias.internal:4545/','http://192.168.10.20:4545/'])assert.equal((await proxied(target)).status,403);
console.log('PASS live egress proxy admits only the listed hostname and port, blocking same-IP aliases and literal-IP bypass');

await writeFile('/tmp/dns-answer.txt','192.168.10.21');assert.deepEqual((await lookupNetworkHost('db.internal',pinned)).map(answer=>answer.address),['192.168.10.21']);
await probe('one','192.168.10.20','yes',4545);await probe('one','192.168.10.21','no',4545);
assert.deepEqual(await lookupWorkspaceHost('one','DB.INTERNAL.'),[{address:'192.168.10.20',family:4}]);assert.deepEqual(await proxied('http://db.internal:4545/'),{status:200,body:'192.168.10.20:4545'});await proxy.close();console.log('PASS later DNS answers cannot widen native or live proxy permissions');
const reapplied=await request(hostsRequest);assert.deepEqual(reapplied.destinations[0].addresses,['192.168.10.21']);await probe('one','192.168.10.21','yes',4545);await probe('one','192.168.10.20','no',4545);
console.log('PASS explicit reapplication replaces the pinned address and revokes the previous one');
const saved=await readFile(path,'utf8');
await writeFile('/tmp/dns-answer.txt','missing');await assert.rejects(request(hostsRequest));assert.equal(await readFile(path,'utf8'),saved);await probe('one','192.168.10.21','yes',4545);
console.log('PASS DNS failure restores the previous live grant and leaves persisted policy unchanged');
await writeFile('/tmp/dns-answer.txt','10.250.0.1');await assert.rejects(request(hostsRequest),/no permitted private addresses/);assert.equal(await readFile(path,'utf8'),saved);await probe('one','192.168.10.21','yes',4545);
await assert.rejects(request({...hostsRequest,destinations:[{host:'172.29.3.2',port:4545}]}),/no permitted private addresses/);assert.equal(await readFile(path,'utf8'),saved);
console.log('PASS control-address DNS answers and literal peer destinations are rejected before granting');
await writeFile('/tmp/dns-answer.txt','192.168.10.20');await command(['mount','--bind',path,path]);try{await assert.rejects(request(hostsRequest))}finally{await command(['umount',path])};assert.equal(await readFile(path,'utf8'),saved);await probe('one','192.168.10.21','yes',4545);await probe('one','192.168.10.20','no',4545);
console.log('PASS failed host-policy persistence rolls back both the installed tuple and the saved snapshot');
await request({workspaceId:'one',mode:'off',configuration:{cidrs:[],dns:[],search:[]}});await probe('one',one.resolver,'no');await probe('one','192.168.10.21','no',4545);await request({workspaceId:'two',mode:'off',configuration:{cidrs:[],dns:[],search:[]}});assert.equal((await command(['ip','-j','link','show'])).includes('kintsugi-dns'),false);console.log('PASS Off revokes DNS and removes all listeners and the internal interface');await writeFile('/tmp/dns-answer.txt','192.168.10.21');await request(hostsRequest);await writeFile('/tmp/dns-answer.txt','192.168.10.20');process.exit(0);`;
try {
  // The bundled workspace reader also resolves terminal assets during module initialisation.
  // Copy their locked owning package into the fixture; never mount host app data or credentials.
  const terminalAssets = dirname(Bun.resolveSync("@gespenst/core/package.json", `${root}/packages/observable-terminal/src/server`));
  await cp(terminalAssets, join(directory, "node_modules/@gespenst/core"), { recursive: true });
  await writeFile(join(directory, "control.ts"), control);
  await writeFile(join(directory, "upstream.js"), upstream);
  await writeFile(join(directory, "probe.js"), probe);
  const result = await Bun.build({ entrypoints: [join(directory, "control.ts")], target: "bun", outdir: directory });
  assert.equal(result.success, true, String(result.logs));
  await docker(["run", "--name", name, "--network", "none", "--sysctl", "net.ipv4.ip_forward=1", "--cgroupns", "private", "--privileged", "--security-opt", "writable-cgroups=true", "--mount", `type=bind,src=${directory},dst=/fixtures,readonly`, "--entrypoint", "sh", image, "-ec", "bun /fixtures/control.js init; bun /fixtures/control.js restore"]);
  console.log(await docker(["logs", name]));
} finally {
  const p = Bun.spawn(["docker", "rm", "-f", name], { stdout: "pipe", stderr: "pipe" });
  console.log((await new Response(p.stdout).text()).trim());
  await p.exited;
  await rm(directory, { recursive: true, force: true });
}
