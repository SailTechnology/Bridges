import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import readline from 'node:readline';
import {HttpError, redact, digest} from './util.mjs';

/** A private stdio connection. No public Codex RPC listener or credentials on the wire. */
export class CodexRpc extends EventEmitter {
  constructor(executable = 'codex', options = {}) {
    super(); this.executable = executable; this.options = options;
    this.pending = new Map(); this.requests = new Map(); this.serial = 0;
    this.process = null; this.ready = false; this.starting = null; this.closed = false;
    this.diagnostic = '';
  }
  async start() {
    if (this.ready) return;
    if (this.closed) throw new HttpError(503,'Codex 连接已关闭');
    if (this.starting) return this.starting;
    this.starting = this.connect().finally(()=>{this.starting=null;});
    return this.starting;
  }
  async connect() {
    const child = spawn(this.executable, ['app-server','--stdio'], {
      cwd:this.options.cwd, env:process.env, windowsHide:true, stdio:['pipe','pipe','pipe']
    });
    this.process = child;
    const lines = readline.createInterface({input:child.stdout});
    lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        this.requests.set(String(message.id), message);
        this.emit('request', message);
      } else if (message.method) {
        if (message.method === 'serverRequest/resolved') this.requests.delete(String(message.params?.requestId));
        this.emit('notification', message);
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) {
          const error = new HttpError(502, message.error.message);
          error.rpcError = message.error; pending.reject(error);
        } else pending.resolve(message.result);
      }
    });
    child.stderr.on('data', b=>{this.diagnostic = redact(b.toString()).slice(-1200);});
    const disconnected = error => {
      if (this.process !== child) return;
      this.ready=false; this.process=null; this.requests.clear();
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer); entry.reject(new HttpError(503,error ? redact(error.message) : 'Codex 服务已断开；请刷新后重试'));
      }
      this.pending.clear(); this.emit('disconnected');
    };
    child.once('error', disconnected); child.once('exit', ()=>disconnected());
    child.stdin.on('error', ()=>{});
    try {
      this.info = await this.request('initialize', {
        clientInfo:{name:'neo_win_bridges',title:'Bridges 工程联动',version:'0.1.0'},
        capabilities:{experimentalApi:true}
      }, 30000);
      this.notify('initialized');
      if(this.options.expectedAccountHash){
        const response=await this.request('account/read',{refreshToken:false});
        const account=response?.account;
        if(!account||account.type!=='chatgpt'||digest(JSON.stringify({type:account.type,email:account.email,workspaceName:account.workspaceName||null}))!==this.options.expectedAccountHash){
          throw new HttpError(403,'当前账号与本配置绑定的账号不匹配，已停止接入');
        }
      }
      this.ready=true; this.emit('ready');
    } catch (error) { child.kill(); throw error; }
  }
  request(method, params, timeout = 30000) {
    if (!this.process || this.process.exitCode !== null) return Promise.reject(new HttpError(503,'Codex 尚未连接'));
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(id); reject(new HttpError(504,`${method} 超时；写入请求不会自动重发，请先核对会话状态`));
      },timeout);
      this.pending.set(id,{resolve,reject,timer});
      this.process.stdin.write(JSON.stringify({id,method,params})+'\n');
    });
  }
  async call(method, params, timeout) { await this.start(); return this.request(method,params,timeout); }
  notify(method,params) { this.process?.stdin.write(JSON.stringify({method,...(params?{params}:{})})+'\n'); }
  respond(requestId, result) {
    const request=this.requests.get(String(requestId));
    if (!request) throw new HttpError(409,'该请求已经结束');
    this.process.stdin.write(JSON.stringify({id:request.id,result})+'\n');
    this.requests.delete(String(requestId));
  }
  close() { this.closed=true; this.process?.kill(); }
}
