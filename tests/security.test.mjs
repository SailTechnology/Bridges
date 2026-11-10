import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Auth} from '../src/auth.mjs';
import {Projects,parseRange} from '../src/projects.mjs';
import {originCheck} from '../src/util.mjs';
function fixture(t){const root=path.join('H:/Temp/Codex/Bridges/tests',randomUUID());fs.mkdirSync(root,{recursive:true});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('pairing is single-use, HttpOnly, and cannot be forged',t=>{
  const auth=new Auth(path.join(fixture(t),'credential.json'));
  const request={socket:{remoteAddress:'100.64.0.2'},headers:{'x-forwarded-proto':'https'}};
  const pairing=auth.pair();const cookie=auth.login(request,pairing.code);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);
  assert.equal(auth.authenticated({...request,headers:{cookie}},false),true);
  assert.equal(auth.authenticated({...request,headers:{cookie:cookie.replace(/bridges=./,'bridges=X')}},false),false);
  assert.throws(()=>auth.login(request,pairing.code),/无效/);
});
test('pairing expires and rate limits failed attempts',t=>{
  const auth=new Auth(path.join(fixture(t),'credential.json'));const req={socket:{remoteAddress:'remote'},headers:{}};
  const pair=auth.pair();auth.pairing.expires=Date.now()-1;assert.throws(()=>auth.login(req,pair.code),/过期/);
  for(let n=0;n<4;n++)assert.throws(()=>auth.login(req,'no'));
  assert.throws(()=>auth.login(req,'no'),/尝试过多/);
});
test('cross-site requests and forwarded localhost hosts do not gain local access',()=>{
  const socket={remoteAddress:'127.0.0.1'};
  assert.throws(()=>originCheck({method:'POST',headers:{host:'127.0.0.1:8877',origin:'https://evil.example'},socket},8877),/来源/);
  assert.equal(originCheck({method:'GET',headers:{host:'evil.example:8877'},socket},8877),false);
  assert.equal(originCheck({method:'GET',headers:{host:'127.0.0.1:8877','x-forwarded-for':'100.64.0.2'},socket},8877),false);
  assert.equal(originCheck({method:'GET',headers:{host:'127.0.0.1:8877'},socket},8877),true);
});
test('project access prevents traversal, secrets, and escaping directory links',t=>{
  const root=fixture(t),projectsRoot=path.join(root,'projects'),p=path.join(projectsRoot,'demo'),outside=path.join(root,'outside');
  fs.mkdirSync(p,{recursive:true});fs.mkdirSync(outside);fs.writeFileSync(path.join(p,'code.py'),'print(1)');fs.writeFileSync(path.join(p,'.env'),'secret');
  fs.mkdirSync(path.join(p,'runtime'));fs.writeFileSync(path.join(p,'runtime','key.txt'),'private');fs.writeFileSync(path.join(outside,'file.txt'),'outside');
  fs.symlinkSync(outside,path.join(p,'escape'),process.platform==='win32'?'junction':'dir');
  fs.symlinkSync(path.join(p,'runtime'),path.join(p,'alias'),process.platform==='win32'?'junction':'dir');
  const projects=new Projects(projectsRoot),project=projects.list()[0];
  assert.equal(projects.resolve(project.id,'code.py').stat.size,8);
  for(const relative of ['../outside/file.txt','.env','runtime/key.txt','escape/file.txt','alias/key.txt'])assert.throws(()=>projects.resolve(project.id,relative),undefined,relative);
  assert.deepEqual(projects.files(project.id).map(f=>f.name),['code.py']);
});
test('range downloads handle suffixes and reject invalid or empty ranges',()=>{
  assert.deepEqual(parseRange('bytes=2-5',10),{start:2,end:5});assert.deepEqual(parseRange('bytes=-3',10),{start:7,end:9});
  assert.deepEqual(parseRange('bytes=7-',10),{start:7,end:9});
  for(const h of ['bytes=-0','bytes=10-20','bytes=2-1','bytes=0-1,2-3','bytes=-'])assert.throws(()=>parseRange(h,10));
  assert.throws(()=>parseRange('bytes=0-',0));
});
