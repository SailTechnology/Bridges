import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomicJson,readJson,HttpError,id,isInside,digest,redact} from './util.mjs';
const worker=fileURLToPath(new URL('../tools/build_groundstation.py',import.meta.url));

/** Only configured recipes can run. Source trees are inputs; every output has a fresh job directory. */
export class Builds {
  constructor(config,profileRoot){
    this.config=config;this.root=path.join(profileRoot,'builds');this.active=new Map();
    this.jobRoot=path.join(config.tempRoot,'builds',id(config.profileId||'local-preview'));
  }
  recipes(){return Object.entries(this.config.buildRecipes||{}).map(([key,r])=>({id:key,name:r.name,project:r.projectName,
    target:'macOS arm64',enabled:this.config.allowBuilds===true&&r.enabled===true}));}
  start(recipeId){
    id(recipeId);const recipe=this.config.buildRecipes?.[recipeId];
    if(!this.config.allowBuilds||!recipe?.enabled)throw new HttpError(403,'此构建任务尚未启用；不会执行原工程中的程序');
    if(this.active.size)throw new HttpError(409,'已有一个独立构建正在执行，请完成后再提交');
    if(!(this.config.allowedProjects||['Bridges']).includes(recipe.projectName))throw new HttpError(403,'工程未加入本配置允许清单');
    const projectsRoot=fs.realpathSync(this.config.projectRoot),projectRoot=fs.realpathSync(path.join(projectsRoot,recipe.projectName));
    if(!isInside(projectsRoot,projectRoot))throw new HttpError(403,'工程路径超出允许范围');
    const builder=fs.realpathSync(path.join(projectRoot,'地面站','packaging','macos','build_macos.py'));
    if(!isInside(projectRoot,builder))throw new HttpError(403,'构建入口链接到工程外部');
    if(!recipe.builderSha256||digest(fs.readFileSync(builder))!==recipe.builderSha256)throw new HttpError(409,'构建脚本已变化，请先核对新脚本再更新绑定');
    const jobId=crypto.randomUUID(),directory=path.join(this.jobRoot,jobId);
    fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(this.root,{recursive:true});
    const statusFile=path.join(this.root,`${jobId}.json`);
    const status={id:jobId,recipe:recipeId,name:recipe.name,state:'running',startedAt:new Date().toISOString(),directory};
    atomicJson(statusFile,status);
    const child=spawn(this.config.buildPythonExecutable||'H:/Runtimes/MigrationPython/python.exe',[
      '-X','utf8',worker,'--project-root',projectRoot,'--job-dir',directory,'--builder-sha256',recipe.builderSha256
    ],{cwd:directory,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',TEMP:directory,TMP:directory},windowsHide:true,stdio:['ignore','pipe','pipe']});
    this.active.set(jobId,child);const log=fs.createWriteStream(path.join(directory,'worker.log'),{flags:'a',mode:0o600});
    child.stdout.on('data',b=>log.write(redact(b.toString())));child.stderr.on('data',b=>log.write(redact(b.toString())));
    let finished=false;
    const finish=(code,error)=>{
      if(finished)return;finished=true;this.active.delete(jobId);log.end();
      const receipt=readJson(path.join(directory,'receipt.json'));
      atomicJson(statusFile,{...status,state:code===0&&receipt?'ready':'failed',finishedAt:new Date().toISOString(),
        receipt,error:error?redact(error.message):code===0&&receipt?null:'构建失败；日志保留在此任务目录'});
    };
    child.once('error',e=>finish(null,e));child.once('close',code=>finish(code));
    return {id:jobId,state:'running',statusUrl:`/api/builds/${jobId}`};
  }
  status(jobId){
    id(jobId);const status=readJson(path.join(this.root,`${jobId}.json`));
    if(!status)throw new HttpError(404,'构建任务不存在');
    if(status.state==='running'&&!this.active.has(jobId))return {...status,state:'interrupted',error:'服务已重新启动；不会自动重跑构建'};
    return status;
  }
  artifact(jobId){
    const status=this.status(jobId);if(status.state!=='ready')throw new HttpError(409,'部署包尚未就绪');
    const directory=fs.realpathSync(status.directory),file=fs.realpathSync(path.join(directory,status.receipt.artifact));
    if(!isInside(fs.realpathSync(this.jobRoot),directory)||!isInside(directory,file)||!file.endsWith('.zip'))throw new HttpError(403,'部署包路径无效');
    const stat=fs.statSync(file);
    if(stat.size!==status.receipt.bytes)throw new HttpError(409,'部署包大小变化，需要重新校验');
    return {path:file,stat,sha256:status.receipt.sha256};
  }
  stop(){for(const p of this.active.values())p.kill();}
}
