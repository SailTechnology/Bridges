import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomicJson, readJson, id, HttpError, digest, isInside} from './util.mjs';

export function activityFromRecord(previous, row) {
  if (row.type !== 'event_msg') return previous;
  const p=row.payload || {};
  if (['task_started','turn_started'].includes(p.type)) return {state:'running',turnId:p.turn_id,at:row.timestamp};
  if (['task_complete','turn_completed','turn_aborted','task_failed'].includes(p.type)) {
    return {state:'idle',turnId:p.turn_id,at:row.timestamp};
  }
  return previous;
}

/** Append only complete JSONL records, checkpoint after fsync, and recover interrupted writes. */
export function syncRaw(source, directory, maxBytes = 8*1024*1024) {
  fs.mkdirSync(directory,{recursive:true});
  const checkpoint=path.join(directory,'raw-checkpoint.json');
  const mirror=path.join(directory,'rollout.jsonl');
  let state=readJson(checkpoint,{offset:0,activity:{state:'unknown'}});
  const stat=fs.statSync(source);
  const fd=fs.openSync(source,'r');
  try {
    // Check an immutable prefix as well as file identity; append-only growth keeps the prefix stable.
    const prefixSize=Math.min(state.prefixSize || 512,stat.size);
    const prefix=Buffer.alloc(prefixSize); fs.readSync(fd,prefix,0,prefixSize,0);
    const signature=digest(prefix);
    if (stat.size<state.offset || (state.prefixHash && state.prefixSize===prefixSize && signature!==state.prefixHash)) {
      if (fs.existsSync(mirror)) fs.renameSync(mirror,path.join(directory,`rollout-${Date.now()}-${crypto.randomUUID()}.jsonl`));
      state={offset:0,activity:{state:'unknown'}};
    }
    const mirrorSize=fs.existsSync(mirror)?fs.statSync(mirror).size:0;
    // A crash after append but before the checkpoint leaves an uncommitted suffix.
    if (mirrorSize>state.offset) fs.truncateSync(mirror,state.offset);
    if (mirrorSize<state.offset) state={offset:0,activity:{state:'unknown'}};
    if (!state.offset && fs.existsSync(mirror) && fs.statSync(mirror).size) fs.truncateSync(mirror,0);
    let size=Math.min(stat.size-state.offset,maxBytes);
    let data=Buffer.alloc(size);
    if (size) fs.readSync(fd,data,0,size,state.offset);
    let last=data.lastIndexOf(10);
    // A large item is still one JSONL record. Bound memory; fail visibly above 64 MiB.
    while (size && last<0 && state.offset+size<stat.size && size<64*1024*1024) {
      size=Math.min(stat.size-state.offset,size*2,64*1024*1024);
      data=Buffer.alloc(size); fs.readSync(fd,data,0,size,state.offset); last=data.lastIndexOf(10);
    }
    if (last>=0) {
      const complete=data.subarray(0,last+1);
      for(const line of complete.toString('utf8').split('\n')) {
        if(!line.trim())continue;
        let row; try{row=JSON.parse(line);}catch{throw new HttpError(409,'原始会话含损坏记录，已停止跟踪');}
        state.activity=activityFromRecord(state.activity,row);
        state.records=(state.records||0)+1;
      }
      const out=fs.openSync(mirror,'a',0o600);
      try{fs.writeFileSync(out,complete);fs.fsyncSync(out);}finally{fs.closeSync(out);}
      state.offset+=complete.length;
    }
    if (last<0 && size===64*1024*1024) throw new HttpError(413,'会话单条记录超过 64 MiB，尚未同步完整');
    const actualPrefixSize=Math.min(512,state.offset);
    const actualPrefix=Buffer.alloc(actualPrefixSize);fs.readSync(fd,actualPrefix,0,actualPrefixSize,0);
    state={...state,prefixSize:actualPrefixSize,prefixHash:digest(actualPrefix),sourceBytes:stat.size,
      sourceMtimeMs:stat.mtimeMs,pendingBytes:stat.size-state.offset,syncedAt:new Date().toISOString()};
    atomicJson(checkpoint,state); return state;
  } finally { fs.closeSync(fd); }
}

export class ContextTracker {
  constructor(rpc, root, config) {
    this.rpc=rpc;this.root=root;this.config=config;this.threads=new Map();this.watched=new Set(config.watchThreadIds||[]);
    this.busy=false;this.lastError=null;this.lastPoll=null;this.pendingHistory=new Set();
    fs.mkdirSync(root,{recursive:true});
    this.allowedRolloutRoots=(config.rolloutRoots||[path.join(rpc.options?.codexHome || process.env.CODEX_HOME || path.join(process.env.USERPROFILE||'','.codex'),'sessions')])
      .filter(p=>fs.existsSync(p)).map(p=>fs.realpathSync(p));
    this.projectScopes=config.projectRoot?(config.allowedProjects||['Bridges']).map(name=>path.join(config.projectRoot,name))
      .filter(p=>fs.existsSync(p)).map(p=>fs.realpathSync(p)):null;
    for(const entry of readJson(path.join(root,'catalog.json'),[]))if(this.allowed(entry))this.threads.set(entry.id,entry);
  }
  allowed(thread){
    if(!this.projectScopes)return true;
    try{return this.projectScopes.some(p=>isInside(p,fs.realpathSync(thread.cwd)));}catch{return false;}
  }
  directory(threadId){return path.join(this.root,id(threadId));}
  async metadata(threadId) {
    id(threadId);
    const {thread}=await this.rpc.call('thread/read',{threadId,includeTurns:false});
    if(!this.allowed(thread))throw new HttpError(403,'该会话不属于本配置允许的工程');
    this.threads.set(threadId,thread);return thread;
  }
  async poll() {
    if(this.busy)return;this.busy=true;
    try {
      const result=await this.rpc.call('thread/list',{limit:60,sortKey:'updated_at',modelProviders:[],useStateDbOnly:true});
      for(const t of result.data)if(this.allowed(t))this.threads.set(t.id,t);
      for(const threadId of this.watched){
        try{
          const thread=this.threads.get(threadId)||await this.metadata(threadId);
          this.sync(thread);
          const manifest=readJson(path.join(this.directory(threadId),'history.json'));
          if(!manifest||!manifest.complete)await this.historyPage(threadId,manifest?.nextCursor||null,false);
          // Re-read the head with overlap; completed pages alone would miss in-flight updates.
          await this.historyPage(threadId,null,true);
          const errorFile=path.join(this.directory(threadId),'error.json');
          if(fs.existsSync(errorFile))fs.unlinkSync(errorFile);
        }catch(e){atomicJson(path.join(this.directory(threadId),'error.json'),{message:e.message,at:new Date().toISOString()});}
      }
      atomicJson(path.join(this.root,'catalog.json'),[...this.threads.values()]);
      this.lastPoll=new Date().toISOString();this.lastError=null;
    }catch(e){this.lastError=e.message;}finally{this.busy=false;}
  }
  sync(thread) {
    if(!thread.path)throw new HttpError(404,'该会话没有本地记录');
    const source=fs.realpathSync(thread.path);
    if(!this.allowedRolloutRoots.some(root=>isInside(root,source)))throw new HttpError(403,'会话路径不在允许的记录目录');
    const directory=this.directory(thread.id);fs.mkdirSync(directory,{recursive:true});
    atomicJson(path.join(directory,'thread.json'),thread);
    return syncRaw(source,directory);
  }
  async watch(threadId) {
    const thread=await this.metadata(threadId);this.watched.add(threadId);this.sync(thread);
    atomicJson(path.join(this.root,'watched.json'),[...this.watched]);return thread;
  }
  async historyPage(threadId,cursor=null,head=false) {
    id(threadId);
    const thread=this.threads.get(threadId)||await this.metadata(threadId);
    if(!this.allowed(thread))throw new HttpError(403,'会话超出本工程范围');
    const params={threadId,limit:head?2:10,itemsView:'full',sortDirection:'desc'};
    if(cursor)params.cursor=cursor;
    const page=await this.rpc.call('thread/turns/list',params,60000);
    const directory=this.directory(threadId),turns=path.join(directory,'turns');fs.mkdirSync(turns,{recursive:true});
    for(const turn of page.data)atomicJson(path.join(turns,`${id(turn.id)}.json`),turn);
    if(!head){atomicJson(path.join(directory,'history.json'),{nextCursor:page.nextCursor||null,complete:!page.nextCursor,
      updatedAt:new Date().toISOString()});}
    return page;
  }
  status(threadId) {
    const directory=this.directory(threadId);
    const raw=readJson(path.join(directory,'raw-checkpoint.json'));
    const history=readJson(path.join(directory,'history.json'));
    return {watched:this.watched.has(threadId),raw,history,error:readJson(path.join(directory,'error.json'))};
  }
  async assertIdle(threadId) {
    const thread=await this.metadata(threadId),raw=this.sync(thread);
    if(raw.pendingBytes)throw new HttpError(409,'上下文仍在追平，请稍后重试');
    if(raw.activity?.state!=='idle')throw new HttpError(409,'原会话仍在运行或未确认结束，请先在 Windows 结束当前轮次');
    if(Date.now()-raw.sourceMtimeMs<2500)throw new HttpError(409,'原会话刚更新，请等待三秒再接续');
    return {thread,raw};
  }
  async exportManifest(threadId) {
    await this.watch(threadId);const directory=this.directory(threadId);
    const status=this.status(threadId),file=path.join(directory,'rollout.jsonl');
    const sha=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))sha.update(b);
    return {version:1,threadId,createdAt:new Date().toISOString(),rollout:{bytes:fs.statSync(file).size,sha256:sha.digest('hex')},
      rawComplete:status.raw.pendingBytes===0,historyComplete:status.history?.complete===true,
      executionHost:'Windows',portableRestore:false,
      note:'这是原始记录和分页历史的跟踪校验；接续在 Windows 原生会话存储上通过官方接口完成。'};
  }
}
