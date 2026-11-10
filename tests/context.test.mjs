import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {syncRaw,activityFromRecord,ContextTracker} from '../src/context.mjs';
import {readJson} from '../src/util.mjs';

const base=path.join(process.env.BRIDGES_TEST_TEMP||'H:/Temp/Codex/Bridges','tests');
function fixture(t){const root=path.join(base,randomUUID());fs.mkdirSync(root,{recursive:true});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const record=(type,text='中文')=>JSON.stringify({type:'event_msg',timestamp:'2026-11-10T00:00:00Z',payload:{type,turn_id:'turn1',text}})+'\n';

test('incremental mirror waits for a complete UTF-8 JSONL record and tracks active turns',t=>{
  const root=fixture(t),source=path.join(root,'source.jsonl'),dest=path.join(root,'copy');
  const start=record('task_started'),end=record('task_complete','中文结束');const bytes=Buffer.from(end);
  fs.writeFileSync(source,start);let status=syncRaw(source,dest);assert.equal(status.activity.state,'running');
  const cut=bytes.indexOf(Buffer.from('中'))+1;fs.appendFileSync(source,bytes.subarray(0,cut));
  status=syncRaw(source,dest);assert.equal(status.offset,Buffer.byteLength(start));assert.ok(status.pendingBytes>0);
  fs.appendFileSync(source,bytes.subarray(cut));status=syncRaw(source,dest);assert.equal(status.activity.state,'idle');assert.equal(status.pendingBytes,0);
  assert.deepEqual(fs.readFileSync(path.join(dest,'rollout.jsonl')),fs.readFileSync(source));
  syncRaw(source,dest);assert.equal(fs.readFileSync(path.join(dest,'rollout.jsonl'),'utf8'),start+end);
});
test('crash between mirror append and checkpoint cannot duplicate records',t=>{
  const root=fixture(t),source=path.join(root,'source'),dest=path.join(root,'copy');fs.writeFileSync(source,record('task_started'));
  syncRaw(source,dest);fs.appendFileSync(source,record('task_complete'));fs.appendFileSync(path.join(dest,'rollout.jsonl'),'uncommitted crash tail');
  syncRaw(source,dest);assert.deepEqual(fs.readFileSync(path.join(dest,'rollout.jsonl')),fs.readFileSync(source));
});
test('source truncation preserves the previous mirror and starts a new generation',t=>{
  const root=fixture(t),source=path.join(root,'source'),dest=path.join(root,'copy');fs.writeFileSync(source,record('task_started','a'.repeat(2000)));syncRaw(source,dest);
  fs.writeFileSync(source,record('task_complete'));const s=syncRaw(source,dest);assert.equal(s.activity.state,'idle');
  assert.ok(fs.readdirSync(dest).some(n=>/^rollout-.*jsonl$/.test(n)));
});
test('records larger than a polling chunk still make progress',t=>{
  const root=fixture(t),source=path.join(root,'source'),dest=path.join(root,'copy');fs.writeFileSync(source,record('task_complete','z'.repeat(50000)));
  const s=syncRaw(source,dest,1024);assert.equal(s.pendingBytes,0);assert.equal(s.records,1);
});
test('an unknown or unfinished source is never eligible for takeover',async t=>{
  const root=fixture(t),source=path.join(root,'source');fs.writeFileSync(source,record('task_started'));
  const thread={id:'test-thread',path:source};
  const rpc={options:{},call:async()=>({thread})};
  const tracker=new ContextTracker(rpc,path.join(root,'contexts'),{rolloutRoots:[root]});
  await assert.rejects(tracker.assertIdle(thread.id),/原会话仍在运行/);
  fs.appendFileSync(source,record('task_complete'));fs.utimesSync(source,new Date(0),new Date(0));
  assert.equal((await tracker.assertIdle(thread.id)).raw.activity.state,'idle');
});
