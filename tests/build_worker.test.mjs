import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

test('isolated build writes only the fresh job, validates inputs, and refuses reuse',t=>{
  const root=path.join('H:/Temp/Codex/Bridges/tests',crypto.randomUUID()),project=path.join(root,'source'),job=path.join(root,'job');
  fs.mkdirSync(path.join(project,'地面站','packaging','macos'),{recursive:true});fs.mkdirSync(job);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(project,'地面站','core.py');fs.writeFileSync(source,'VERSION="test"\n');
  const builder=path.join(project,'地面站','packaging','macos','build_macos.py');
  fs.writeFileSync(builder,`from pathlib import Path
import hashlib, zipfile
PROJECT=Path(__file__).resolve().parents[3]
NAME='Station'; VERSION='test'; COPIED={}
STAGE=PROJECT/'do-not-write-stage'; DIST=PROJECT/'do-not-write-dist'
def stage():
    STAGE.mkdir(parents=True)
    src=PROJECT/'地面站/core.py'
    return {'sources':{'地面站/core.py':{'sha256':hashlib.sha256(src.read_bytes()).hexdigest()}}}
def archive(manifest):
    DIST.mkdir(parents=True)
    with zipfile.ZipFile(DIST/'app.zip','w') as bundle: bundle.writestr('app.txt','ready')
`);
  const hash=crypto.createHash('sha256').update(fs.readFileSync(builder)).digest('hex');
  const worker=path.resolve('tools/build_groundstation.py'),python=process.env.BRIDGES_PYTHON||'H:/Runtimes/MigrationPython/python.exe';
  const before=fs.readFileSync(source);
  const args=['-X','utf8',worker,'--project-root',project,'--job-dir',job,'--builder-sha256',hash];
  const output=execFileSync(python,args,{encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  const receipt=JSON.parse(output);assert.equal(receipt.sources_verified,true);assert.equal(receipt.original_project_written,false);
  assert.deepEqual(fs.readFileSync(source),before);assert.equal(fs.existsSync(path.join(project,'do-not-write-dist')),false);
  assert.ok(fs.existsSync(path.join(job,'dist','app.zip')));
  assert.throws(()=>execFileSync(python,args,{stdio:'pipe',windowsHide:true}));
});
