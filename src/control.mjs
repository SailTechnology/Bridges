import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {HttpError, id, redact} from './util.mjs';
const execute=promisify(execFile);

/** Bridge clients share one Windows execution host. No automatic retry of writes. */
export class Controller {
  constructor(rpc,tracker){
    this.rpc=rpc;this.tracker=tracker;this.leases=new Map();this.locks=new Set();this.events=[];this.sequence=0;
    rpc.on('notification',m=>this.push({kind:'notification',method:m.method,
      params:{threadId:m.params?.threadId,turnId:m.params?.turnId,requestId:m.params?.requestId}}));
    rpc.on('request',m=>this.push({kind:'request',...m}));
    rpc.on('disconnected',()=>{this.leases.clear();this.push({kind:'disconnected'});});
  }
  push(event){this.events.push({seq:++this.sequence,at:new Date().toISOString(),...event});if(this.events.length>2000)this.events.shift();}
  async exclusive(threadId,fn){
    id(threadId);if(this.locks.has(threadId))throw new HttpError(409,'该会话的操作正在执行');
    this.locks.add(threadId);try{return await fn();}finally{this.locks.delete(threadId);}
  }
  async takeOver(threadId,owner,confirmed){
    if(confirmed!==true)throw new HttpError(400,'请先确认 Windows 已停止向此会话发送消息');
    return this.exclusive(threadId,async()=>{
      const lease=this.leases.get(threadId);
      if(lease&&lease.owner!==owner)throw new HttpError(409,'另一端持有该会话，请先释放');
      const {thread}=await this.tracker.assertIdle(threadId);
      // Preserve provider, model, tools, original cwd and instructions. No reconstruction from a summary.
      const result=await this.rpc.call('thread/resume',{threadId,excludeTurns:true,modelProvider:thread.modelProvider},60000);
      const raw=this.tracker.sync(thread);
      if(raw.activity?.state!=='idle'||raw.pendingBytes)throw new HttpError(409,'接续期间原会话已更新，请先停止 Windows 当前轮次');
      this.leases.set(threadId,{owner,model:thread.model,acquiredAt:new Date().toISOString()});
      await this.tracker.watch(threadId);return result;
    });
  }
  async send(threadId,owner,text,messageId){
    if(typeof text!=='string'||!text.trim()||text.length>50000)throw new HttpError(400,'消息为空或过长');
    id(messageId);
    return this.exclusive(threadId,async()=>{
      const lease=this.leases.get(threadId);
      if(!lease||lease.owner!==owner)throw new HttpError(409,'请先在此设备接续该会话');
      const {thread}=await this.tracker.assertIdle(threadId);
      return this.rpc.call('turn/start',{threadId,input:[{type:'text',text,text_elements:[]}],clientUserMessageId:messageId},60000);
    });
  }
  async release(threadId,owner){
    return this.exclusive(threadId,async()=>{
      const lease=this.leases.get(threadId);
      if(lease&&lease.owner!==owner)throw new HttpError(409,'会话属于另一设备');
      if(lease){await this.tracker.assertIdle(threadId);this.leases.delete(threadId);}
      return {released:true};
    });
  }
  async interrupt(threadId,owner){
    const lease=this.leases.get(threadId);
    if(!lease||lease.owner!==owner)throw new HttpError(409,'只能停止本端接续的会话');
    const thread=await this.tracker.metadata(threadId),raw=this.tracker.sync(thread);
    if(raw.activity?.state!=='running'||!raw.activity.turnId)throw new HttpError(409,'没有可停止的运行轮次');
    return this.rpc.call('turn/interrupt',{threadId,turnId:raw.activity.turnId});
  }
  approve(requestId,owner,answer){
    const request=this.rpc.requests.get(String(requestId));
    if(!request)throw new HttpError(409,'请求已结束');
    const lease=this.leases.get(request.params?.threadId);
    if(!lease||lease.owner!==owner)throw new HttpError(403,'此请求由接续设备处理');
    const method=request.method;let result;
    if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)){
      if(!['accept','decline','cancel'].includes(answer))throw new HttpError(400,'无效的审批结果');
      result={decision:answer};
    }else if(method==='item/tool/requestUserInput'){
      if(!answer||typeof answer!=='object'||Array.isArray(answer))throw new HttpError(400,'需要按问题提交答案');
      result={answers:answer};
    }else if(method==='item/permissions/requestApproval'){
      // Extended permission objects are not silently granted by this client.
      if(answer!=='decline')throw new HttpError(400,'此类扩展权限请在 Windows 客户端处理');
      result={permissions:{},scope:'turn'};
    }else throw new HttpError(409,'该交互请在 Windows 处理；不会自动批准');
    this.rpc.respond(requestId,result);return {resolved:true};
  }
}

export async function neoTask(config,action){
  if(!config?.enabled)throw new HttpError(409,'Neo 尚未接入；请按 Neo 接入说明配置');
  if(!['health','ports','ground-station-status'].includes(action))throw new HttpError(400,'未配置该现场操作');
  if(!/^[a-zA-Z0-9._-]+$/.test(config.sshAlias)||!/^~?\/[a-zA-Z0-9_./-]+$/.test(config.agentPath))throw new HttpError(400,'Neo SSH 配置格式错误');
  const remotePath=config.agentPath.startsWith('~/')?'"$HOME"/'+config.agentPath.slice(2):config.agentPath;
  try{
    const r=await execute('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',config.sshAlias,`/bin/sh ${remotePath} ${action}`],
      {timeout:20000,maxBuffer:256*1024,encoding:'utf8',windowsHide:true});
    return {host:'Neo',action,output:redact(r.stdout),stderr:redact(r.stderr)};
  }catch(e){throw new HttpError(502,`Neo 调用失败：${redact(e.stderr||e.message).slice(0,800)}`);}
}
