import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Auth} from '../src/auth.mjs';
import {redact} from '../src/util.mjs';
import {createBridge} from '../src/server.mjs';

function fixture(t){
  const root=path.join('H:/Temp/Codex/Bridges/tests',randomUUID());
  fs.mkdirSync(root,{recursive:true});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}
const request={socket:{remoteAddress:'100.64.0.2'},headers:{'x-forwarded-proto':'https'}};
const bearer=token=>({...request,headers:{...request.headers,authorization:`Bearer ${token}`}});
function pair(auth,name='Neo'){return auth.loginDevice(request,auth.pair().code,name);}

test('device grants survive years of inactivity and restarts without storing the raw token',t=>{
  const file=path.join(fixture(t),'credential.json');let auth=new Auth(file);
  const device=pair(auth),key=auth.key;
  assert.ok(!fs.readFileSync(auth.devicesFile,'utf8').includes(device.deviceToken));
  assert.ok(!JSON.stringify(auth.listDevices()).includes('tokenHash'));
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  t.mock.timers.tick(20*366*86400000);
  auth=new Auth(file);
  const identity=auth.require(bearer(device.deviceToken),false);
  assert.equal(identity.permanent,true);assert.equal(identity.deviceId,device.deviceId);
  assert.ok(auth.key===key,'the existing master credential must be preserved');
  assert.ok(new Auth(file).authenticated(bearer(device.deviceToken),false));
});

test('revoking one device persists across restart and preserves other devices and profiles',t=>{
  const root=fixture(t),file=path.join(root,'one','credential.json');let auth=new Auth(file);
  const first=pair(auth,'Neo'),second=pair(auth,'Other device');
  const altered=first.deviceToken.slice(0,-1)+(first.deviceToken.endsWith('A')?'B':'A');
  assert.equal(auth.authenticated(bearer(altered),false),false);
  assert.equal(new Auth(path.join(root,'two','credential.json')).authenticated(bearer(first.deviceToken),false),false);
  assert.notEqual(auth.claim(bearer(first.deviceToken)).owner,auth.claim(bearer(second.deviceToken)).owner);
  auth.revoke(first.deviceId);auth=new Auth(file);
  assert.equal(auth.authenticated(bearer(first.deviceToken),false),false);
  assert.equal(auth.authenticated({...request,headers:{cookie:`bridges=${first.deviceToken}`}},false),false);
  assert.equal(auth.authenticated(bearer(second.deviceToken),false),true);
  assert.throws(()=>auth.remember(bearer(first.deviceToken)),/首次配对/);
  assert.throws(()=>auth.revoke('toString'),/不存在/);
});

test('an existing valid signed cookie upgrades once without a pairing code',t=>{
  const auth=new Auth(path.join(fixture(t),'credential.json'));
  const expiry=Date.now()+86400000,nonce='old-client',value=`${nonce}.${expiry}`;
  const req={...request,headers:{...request.headers,cookie:`bridges=${value}.${auth.sign(value)}`}};
  const upgrade=auth.remember(req,'Neo migrated');
  assert.equal(upgrade.permanent,true);assert.equal(auth.pairing,null);
  const again=auth.remember(bearer(upgrade.deviceToken));
  assert.ok(again.deviceToken===upgrade.deviceToken,'reuse must keep the original device token');
  assert.equal(auth.listDevices().length,1);
  const expired=`old.${Date.now()-1}`;
  assert.throws(()=>auth.remember({...req,headers:{cookie:`bridges=${expired}.${auth.sign(expired)}`}}),/首次配对/);
});

test('browser cookie retention refreshes on use and device secrets are redacted',t=>{
  const auth=new Auth(path.join(fixture(t),'credential.json')),device=pair(auth),headers=new Map();
  auth.require({...request,headers:{...request.headers,cookie:device.cookie}},false,{setHeader:(k,v)=>headers.set(k,v)});
  const cookie=headers.get('Set-Cookie');
  assert.ok(cookie.includes('HttpOnly')&&cookie.includes('Secure')&&cookie.includes('SameSite=Strict'));
  assert.ok(cookie.includes(`Max-Age=${400*86400}`));
  assert.ok(!redact(JSON.stringify({deviceToken:device.deviceToken})).includes(device.deviceToken));
});

test('damaged credential and device registry files are preserved and fail closed',t=>{
  const root=fixture(t),file=path.join(root,'credential.json');new Auth(file);
  const original=fs.readFileSync(file),devicesFile=path.join(root,'trusted-devices.json');
  for(const contents of ['invalid JSON','{}','{"version":1,"devices":[]}','{"version":1,"devices":"wrong"}','{"version":1,"devices":{"bad":{}}}']){
    fs.writeFileSync(devicesFile,contents);
    assert.throws(()=>new Auth(file),/设备授权文件损坏/);
    assert.equal(fs.readFileSync(devicesFile,'utf8'),contents);
    assert.ok(fs.readFileSync(file).equals(original));
  }
  for(const contents of ['broken credential','{"key":""}']){
    fs.writeFileSync(file,contents);
    assert.throws(()=>new Auth(file),/配对凭据文件损坏/);
    assert.equal(fs.readFileSync(file,'utf8'),contents);
  }
});

test('HTTP pairing, renewal and local-only revocation work across a service restart',async t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,'projects','demo'),{recursive:true});
  const config={port:0,profileId:'auth-test',projectRoot:path.join(root,'projects'),allowedProjects:['demo'],
    dataRoot:path.join(root,'data'),tempRoot:path.join(root,'temp'),credentialFile:path.join(root,'credentials','credential.json'),
    rolloutRoots:[root],readOnly:true,enableCodex:false};
  let bridge=await createBridge(config,{noPolling:true}),base;
  t.after(()=>bridge.stop());
  const bind=()=>{config.port=bridge.server.address().port;base=`http://127.0.0.1:${config.port}`;};bind();
  const remote={'X-Forwarded-For':'100.64.0.2','X-Forwarded-Proto':'https','X-Bridges-Client':'1','Content-Type':'application/json'};
  const post=(route,data,headers=remote)=>fetch(base+route,{method:'POST',headers,body:JSON.stringify(data)});
  const code=bridge.auth.pair().code;
  const login=await post('/api/login',{code,deviceName:'Browser Neo'});
  assert.equal(login.status,200);assert.ok(login.headers.get('set-cookie').includes('Secure'));
  const browser=await login.json();assert.equal(browser.permanent,true);assert.equal(browser.deviceToken,undefined);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const remembered=await post('/api/device/remember',{}, {...remote,Cookie:cookie});
  assert.equal(remembered.status,200);const first=await remembered.json();
  assert.equal(first.deviceId,browser.deviceId);assert.equal(bridge.auth.listDevices().length,1);
  const cliLogin=await post('/api/login',{code:bridge.auth.pair().code,persistent:true,deviceName:'CLI Neo'});
  assert.equal(cliLogin.status,200);const second=await cliLogin.json();assert.equal(typeof second.deviceToken,'string');
  const firstHeaders={...remote,Authorization:`Bearer ${first.deviceToken}`};
  for(const route of ['/api/devices','/api/pair',`/api/devices/${second.deviceId}/revoke`]){
    const response=route==='/api/devices'?await fetch(base+route,{headers:firstHeaders}):await post(route,{},firstHeaders);
    assert.equal(response.status,403);
  }
  const list=await(await fetch(base+'/api/devices')).json();
  assert.equal(list.data.length,2);assert.ok(!JSON.stringify(list).includes('token'));
  const revoke=await post(`/api/devices/${first.deviceId}/revoke`,{},{'X-Bridges-Client':'1','Content-Type':'application/json'});
  assert.equal(revoke.status,200);
  await bridge.stop();config.port=0;bridge=await createBridge(config,{noPolling:true});bind();
  assert.equal((await fetch(base+'/api/status',{headers:firstHeaders})).status,401);
  assert.equal((await fetch(base+'/api/status',{headers:{...remote,Cookie:cookie}})).status,401);
  const response=await fetch(base+'/api/session',{headers:{...remote,Authorization:`Bearer ${second.deviceToken}`}});
  assert.equal(response.status,200);assert.equal((await response.json()).permanent,true);
  const refreshed=await fetch(base+'/api/session',{headers:{...remote,Cookie:cliLogin.headers.get('set-cookie').split(';')[0]}});
  assert.equal((await refreshed.json()).authenticated,true);
  assert.ok(refreshed.headers.get('set-cookie').includes('Max-Age=34560000'));
});
