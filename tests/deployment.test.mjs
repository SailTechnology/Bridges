import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createBridge} from '../src/server.mjs';

test('Neo can submit a fixed Windows build and retrieve only its verified artifact',async t=>{
  const root=path.join('H:/Temp/Codex/Bridges/tests',crypto.randomUUID());
  const projects=path.join(root,'projects'),project=path.join(projects,'demo'),builder=path.join(project,'地面站/packaging/macos/build_macos.py');
  fs.mkdirSync(path.dirname(builder),{recursive:true});
  const source=path.join(project,'code.py');fs.writeFileSync(source,'source stays here');
  fs.writeFileSync(builder,`from pathlib import Path
import hashlib,zipfile
PROJECT=Path(__file__).resolve().parents[3]
NAME='Test'; VERSION='test'
def stage():
    STAGE.mkdir(parents=True)
    return {'sources':{'code.py':{'sha256':hashlib.sha256((PROJECT/'code.py').read_bytes()).hexdigest()}}}
def archive(manifest):
    DIST.mkdir(parents=True)
    with zipfile.ZipFile(DIST/'station.zip','w') as bundle: bundle.writestr('app.txt','deployment only')
`);
  const hash=crypto.createHash('sha256').update(fs.readFileSync(builder)).digest('hex');
  const rpc=new EventEmitter();rpc.options={};rpc.requests=new Map();rpc.close=()=>{};
  const config={port:0,profileId:'file-test',projectRoot:projects,allowedProjects:['demo'],dataRoot:path.join(root,'data'),tempRoot:path.join(root,'temp'),
    credentialFile:path.join(root,'credential.json'),rolloutRoots:[root],readOnly:true,enableCodex:false,allowBuilds:true,
    buildPythonExecutable:'H:/Runtimes/MigrationPython/python.exe',buildRecipes:{station:{name:'test',projectName:'demo',builderSha256:hash,enabled:true}}};
  const bridge=await createBridge(config,{rpc,noPolling:true});config.port=bridge.server.address().port;
  t.after(async()=>{await bridge.stop();fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${config.port}`;
  const response=await fetch(base+'/api/builds',{method:'POST',headers:{'X-Bridges-Client':'1','Content-Type':'application/json'},body:'{"recipe":"station"}'});
  assert.equal(response.status,202);const job=await response.json();let status;
  for(let n=0;n<100;n++){
    status=await(await fetch(base+job.statusUrl)).json();if(status.state!=='running')break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(status.state,'ready');assert.equal(status.receipt.sources_verified,true);
  const artifact=await fetch(base+job.statusUrl+'/artifact');assert.equal(artifact.status,200);
  const bytes=Buffer.from(await artifact.arrayBuffer());assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),status.receipt.sha256);
  assert.equal(fs.readFileSync(source,'utf8'),'source stays here');
  assert.equal(bridge.tracker.threads.size,0);assert.equal(bridge.rpc.ready,undefined);
});
