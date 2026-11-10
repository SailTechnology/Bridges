import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {HttpError, isInside, digest} from './util.mjs';
const execute=promisify(execFile);
export function privatePart(part) {
  return /^\.(git|ssh|codex|env(?:\..*)?)$/i.test(part)||/^(runtime|node_modules|__pycache__|credentials|secrets)$/i.test(part)
    ||/^(auth\.json|.*(?:token|password|credential|secret).*|.*\.(?:pem|key|pfx|p12)|id_(?:rsa|ed25519).*)$/i.test(part);
}
export class Projects {
  constructor(root,allowedNames=null){this.root=fs.realpathSync(root);this.entries=new Map();this.allowedNames=allowedNames;}
  list(){
    const out=[];
    for(const entry of fs.readdirSync(this.root,{withFileTypes:true})){
      if(this.allowedNames&&!this.allowedNames.includes(entry.name))continue;
      if(!entry.isDirectory()||privatePart(entry.name))continue;
      const root=fs.realpathSync(path.join(this.root,entry.name));
      if(!isInside(this.root,root))continue;
      const project={id:digest(root).slice(0,16),name:entry.name,root};this.entries.set(project.id,project);out.push(project);
    }
    return out.sort((a,b)=>a.name.localeCompare(b.name,'zh'));
  }
  project(projectId){this.list();const p=this.entries.get(projectId);if(!p)throw new HttpError(404,'工程不存在');return p;}
  resolve(projectId,relative='',directory=false){
    const p=this.project(projectId);
    if(typeof relative!=='string'||relative.includes('\0')||path.isAbsolute(relative)||/^[A-Za-z]:/.test(relative))throw new HttpError(400,'无效路径');
    if(relative.split(/[\\/]/).some(privatePart))throw new HttpError(403,'此目录或凭据文件不通过工程入口提供');
    const candidate=path.resolve(p.root,relative);
    if(!isInside(p.root,candidate))throw new HttpError(403,'路径超出工程');
    let real;try{real=fs.realpathSync(candidate);}catch{throw new HttpError(404,'文件不存在');}
    if(!isInside(p.root,real))throw new HttpError(403,'链接目标超出工程');
    // Check the resolved path too, so a benign alias cannot expose runtime or credentials.
    if(path.relative(p.root,real).split(path.sep).some(privatePart))throw new HttpError(403,'链接指向受保护目录');
    const stat=fs.statSync(real);
    if(directory&&!stat.isDirectory())throw new HttpError(400,'需要目录');
    return {path:real,stat,project:p};
  }
  files(projectId,relative=''){
    const target=this.resolve(projectId,relative,true);
    const entries=[];
    for(const f of fs.readdirSync(target.path,{withFileTypes:true})){
      if(privatePart(f.name))continue;
      try{
        const name=relative?`${relative}/${f.name}`:f.name;
        const v=this.resolve(projectId,name);
        entries.push({name:f.name,path:name,directory:v.stat.isDirectory(),bytes:v.stat.size,modifiedAt:v.stat.mtime.toISOString()});
      }catch{}
      if(entries.length>=1000)break;
    }
    return entries.sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name,'zh'));
  }
  async git(projectId){
    const p=this.project(projectId);
    if(!fs.existsSync(path.join(p.root,'.git')))return {available:false};
    const options={cwd:p.root,timeout:15000,maxBuffer:512*1024,windowsHide:true,encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}};
    try{
      const [status,head]=await Promise.allSettled([
        execute('git',['status','--short','--branch','--untracked-files=normal'],options),
        execute('git',['rev-parse','HEAD'],options)
      ]);
      return {available:true,status:status.status==='fulfilled'?status.value.stdout:'读取失败',
        head:head.status==='fulfilled'?head.value.stdout.trim():null};
    }catch(e){return {available:false,error:e.message};}
  }
  async manifest(projectId,relative){
    const target=this.resolve(projectId,relative);if(!target.stat.isFile())throw new HttpError(400,'需要文件');
    const hash=crypto.createHash('sha256');for await(const b of fs.createReadStream(target.path))hash.update(b);
    const after=fs.statSync(target.path);
    if(after.size!==target.stat.size||after.mtimeMs!==target.stat.mtimeMs)throw new HttpError(409,'文件正在更新，请完成写入后重试');
    return {path:relative,bytes:after.size,sha256:hash.digest('hex'),modifiedAt:after.mtime.toISOString()};
  }
}
export function parseRange(header,size){
  if(!header)return null;
  const m=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!m||(!m[1]&&!m[2])||size===0)throw new HttpError(416,'无效的下载范围');
  let start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));
  let end=m[1]?(m[2]?Math.min(Number(m[2]),size-1):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=size)throw new HttpError(416,'下载范围超出文件');
  return {start,end};
}
