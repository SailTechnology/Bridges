import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBridge} from '../src/server.mjs';

test('HTTP integration authenticates, serves project bytes, and honors ranges',async t=>{
  const root=path.join('H:/Temp/Codex/Bridges/tests',randomUUID());fs.mkdirSync(path.join(root,'projects','demo'),{recursive:true});
  fs.writeFileSync(path.join(root,'projects','demo','test.txt'),'0123456789');
  const rpc=new EventEmitter();rpc.options={};rpc.ready=true;rpc.requests=new Map();rpc.close=()=>{};
  const config={port:0,projectRoot:path.join(root,'projects'),dataRoot:path.join(root,'data'),tempRoot:path.join(root,'temp'),credentialFile:path.join(root,'credential.json'),rolloutRoots:[root],allowedProjects:['demo']};
  const bridge=await createBridge(config,{rpc,noPolling:true});config.port=bridge.server.address().port;
  t.after(async()=>{await bridge.stop();fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${config.port}`;
  const local=await fetch(base+'/api/projects');assert.equal(local.status,200);const project=(await local.json()).data[0];
  const foreign=await fetch(base+'/api/projects',{headers:{'X-Forwarded-For':'100.64.0.2'}});assert.equal(foreign.status,401);
  const pair=bridge.auth.pair();const login=await fetch(base+'/api/login',{method:'POST',headers:{'X-Forwarded-For':'100.64.0.2','X-Bridges-Client':'1','Content-Type':'application/json'},body:JSON.stringify({code:pair.code})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const download=await fetch(`${base}/api/projects/${project.id}/download?path=test.txt`,{headers:{'X-Forwarded-For':'100.64.0.2',Cookie:cookie,Range:'bytes=3-6'}});
  assert.equal(download.status,206);assert.equal(await download.text(),'3456');assert.equal(download.headers.get('content-range'),'bytes 3-6/10');
  const csrf=await fetch(base+'/api/pair',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});assert.equal(csrf.status,403);
  const unavailable=await fetch(base+'/api/neo',{method:'POST',headers:{'X-Bridges-Client':'1','Content-Type':'application/json'},body:'{"action":"ports"}'});assert.equal(unavailable.status,403);
  const write=await fetch(base+'/api/threads/example/send',{method:'POST',headers:{'X-Bridges-Client':'1','Content-Type':'application/json'},body:'{"text":"test","messageId":"one"}'});assert.equal(write.status,403);
  await assert.rejects(createBridge({...config,allowedProjects:['another-project']},{rpc,noPolling:true}),/不能混用/);
});
