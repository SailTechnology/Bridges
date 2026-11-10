import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {CodexRpc} from './rpc.mjs';
import {ContextTracker} from './context.mjs';
import {Controller,neoTask} from './control.mjs';
import {Auth} from './auth.mjs';
import {Projects,parseRange} from './projects.mjs';
import {Builds} from './builds.mjs';
import {HttpError,readJson,atomicJson,bodyJson,jsonResponse,originCheck,redact,id} from './util.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function loadConfig(argv=process.argv.slice(2)) {
  const at=argv.indexOf('--config');
  const supplied=at>=0?readJson(path.resolve(argv[at+1])):null;
  if(at>=0&&!supplied)throw new Error('配置文件不存在或 JSON 无效');
  const defaults=readJson(path.join(repo,'config.example.json'));
  const config={...defaults,...supplied};
  config.credentialFile ||= path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'bridges',id(config.profileId),'credential.json');
  for(const key of ['dataRoot','tempRoot','projectRoot']){
    if(!path.isAbsolute(config[key]))throw new Error(`${key} 必须是绝对路径`);
    if(process.platform==='win32'&&!/^H:[\\/]/i.test(config[key]))throw new Error(`${key} 必须位于 AI Workshop H:，不会回退 C:`);
  }
  config.port=Number(config.port);
  if(!Number.isInteger(config.port)||config.port<1024||config.port>65535)throw new Error('端口无效');
  id(config.profileId);
  if(config.enableCodex&&(!/^[a-f0-9]{64}$/.test(config.expectedAccountHash)||config.profileId==='local-preview')){
    throw new Error('接入 Codex 前需要独立账号配置和已核对的账号绑定；预览配置不能连接账号');
  }
  return config;
}

export async function createBridge(config,dependencies={}){
  fs.mkdirSync(config.dataRoot,{recursive:true});fs.mkdirSync(config.tempRoot,{recursive:true});
  // Each profile has its own history cache and pairing credentials. Default mode has no account connection.
  const profile=id(config.profileId||'local-preview');
  const profileRoot=path.join(config.dataRoot,'profiles',profile);
  const binding={projectRoot:path.resolve(config.projectRoot),allowedProjects:[...(config.allowedProjects||['Bridges'])].sort(),
    account:config.enableCodex?config.expectedAccountHash:'no-model-account'};
  const bindingFile=path.join(profileRoot,'profile-binding.json'),previousBinding=readJson(bindingFile);
  if(previousBinding&&JSON.stringify(previousBinding)!==JSON.stringify(binding))throw new Error('此配置已绑定其他工程范围或账号；请创建独立配置，不能混用历史数据');
  atomicJson(bindingFile,binding);
  const rpc=dependencies.rpc||new CodexRpc(config.codexExecutable,{cwd:repo,expectedAccountHash:config.expectedAccountHash});
  if(!config.enableCodex&&!dependencies.rpc)rpc.call=async()=>{throw new HttpError(403,'当前是离线只读预览，未接入任何账号');};
  const tracker=dependencies.tracker||new ContextTracker(rpc,path.join(profileRoot,'contexts'),config);
  for(const threadId of readJson(path.join(tracker.root,'watched.json'),[]))tracker.watched.add(threadId);
  const control=new Controller(rpc,tracker),auth=new Auth(config.credentialFile),projects=new Projects(config.projectRoot,config.allowedProjects||['Bridges']);
  const builds=new Builds(config,profileRoot);
  const web=path.join(repo,'web');let timer,stopping=false;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    let local=false;
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/health'&&req.method==='GET')return jsonResponse(res,200,{service:'neo-win-bridges',version:'0.1.0'});
      local=originCheck(req,config.port);
      if(!url.pathname.startsWith('/api/')){
        if(!['GET','HEAD'].includes(req.method))throw new HttpError(405,'方法不支持');
        const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
        const filename=files[url.pathname];if(!filename)throw new HttpError(404,'页面不存在');
        const mime=filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html';
        res.writeHead(200,{'Content-Type':`${mime}; charset=utf-8`,'Cache-Control':'no-store'});
        return req.method==='HEAD'?res.end():fs.createReadStream(path.join(web,filename)).pipe(res);
      }
      if(url.pathname==='/api/session'&&req.method==='GET')return jsonResponse(res,200,{authenticated:auth.authenticated(req,local),local});
      if(url.pathname==='/api/login'&&req.method==='POST'){
        const data=await bodyJson(req);res.setHeader('Set-Cookie',auth.login(req,data.code));return jsonResponse(res,200,{connected:true});
      }
      auth.require(req,local);
      const owner=local?'windows-local':req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('bridges='))?.split('=')[1]?.split('.')[0]||'api-client';
      if(url.pathname==='/api/pair'&&req.method==='POST'){
        if(!local)throw new HttpError(403,'请在 Windows 本机生成配对码');
        return jsonResponse(res,200,auth.pair());
      }
      if(url.pathname==='/api/logout'&&req.method==='POST'){
        res.setHeader('Set-Cookie','bridges=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return jsonResponse(res,200,{loggedOut:true});
      }
      if(url.pathname==='/api/status'&&req.method==='GET')return jsonResponse(res,200,{
        version:'0.1.0',host:os.hostname(),executionHost:'Windows',codexReady:rpc.ready,codec:rpc.info?.userAgent,
        lastPoll:tracker.lastPoll,error:tracker.lastError,watched:[...tracker.watched].map(threadId=>({threadId,...tracker.status(threadId)})),
        neo:{configured:config.neo?.enabled===true},
        fileBridge:config.allowBuilds===true,
        leases:[...control.leases].map(([threadId,l])=>({threadId,mine:l.owner===owner,acquiredAt:l.acquiredAt})),
        local,readOnly:config.readOnly!==false,accountConnected:config.enableCodex===true,profileId:profile,
        contextMode:config.enableCodex?'Windows 原生存储 + 增量跟踪；Neo 远程接续':'离线只读预览；未连接账号',dataRoot:profileRoot
      });
      if(url.pathname==='/api/threads'&&req.method==='GET'){
        let threads;
        if(url.searchParams.get('cursor')||url.searchParams.get('q')){
          const result=await rpc.call('thread/list',{limit:60,sortKey:'updated_at',modelProviders:[],useStateDbOnly:true,
            ...(url.searchParams.get('cursor')?{cursor:url.searchParams.get('cursor')}:{}),
            ...(url.searchParams.get('q')?{searchTerm:url.searchParams.get('q')}:{} )});
          for(const t of result.data)if(tracker.allowed(t))tracker.threads.set(t.id,t);
          threads={...result,data:result.data.filter(t=>tracker.allowed(t))};
        }else threads={data:[...tracker.threads.values()].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,120),nextCursor:null};
        return jsonResponse(res,200,{...threads,data:threads.data.map(t=>({id:t.id,name:t.name||t.preview?.slice(0,50)||t.id,
          preview:t.preview,cwd:t.cwd,modelProvider:t.modelProvider,model:t.model,historyMode:t.historyMode,updatedAt:t.updatedAt,
          status:tracker.status(t.id).raw?.activity?.state||'unknown'}))});
      }
      if(url.pathname==='/api/events'&&req.method==='GET'){
        const after=Number(url.searchParams.get('after')||0);
        return jsonResponse(res,200,{events:control.events.filter(e=>e.seq>after),cursor:control.sequence,
          lost:after>0&&control.events.length>0&&after<control.events[0].seq-1,requests:[...rpc.requests.values()]});
      }
      const threadRoute=/^\/api\/threads\/([^/]+)\/(watch|history|takeover|send|release|interrupt|manifest)$/.exec(url.pathname);
      if(threadRoute){
        const threadId=id(threadRoute[1]),action=threadRoute[2];let result;
        if(config.readOnly!==false&&['takeover','send','release','interrupt'].includes(action))throw new HttpError(403,'只读模式禁止会话接管和写入');
        if(req.method==='GET'&&action==='history')result=await tracker.historyPage(threadId,url.searchParams.get('cursor')||null,true);
        else if(req.method==='GET'&&action==='manifest')result=await tracker.exportManifest(threadId);
        else if(req.method==='POST'){
          const data=await bodyJson(req);
          if(action==='watch')result=await tracker.watch(threadId);
          else if(action==='takeover')result=await control.takeOver(threadId,owner,data.confirmed);
          else if(action==='send')result=await control.send(threadId,owner,data.text,data.messageId);
          else if(action==='release')result=await control.release(threadId,owner);
          else if(action==='interrupt')result=await control.interrupt(threadId,owner);
          else throw new HttpError(405,'方法不支持');
        }else throw new HttpError(405,'方法不支持');
        return jsonResponse(res,200,result);
      }
      if(url.pathname==='/api/approval'&&req.method==='POST'){
        if(config.readOnly!==false)throw new HttpError(403,'只读模式禁止处理执行审批');
        const data=await bodyJson(req);return jsonResponse(res,200,control.approve(data.requestId,owner,data.answer));
      }
      if(url.pathname==='/api/projects'&&req.method==='GET')return jsonResponse(res,200,{data:projects.list()});
      if(url.pathname==='/api/deployables'&&req.method==='GET')return jsonResponse(res,200,{data:builds.recipes()});
      if(url.pathname==='/api/builds'&&req.method==='POST'){
        const data=await bodyJson(req);return jsonResponse(res,202,builds.start(data.recipe));
      }
      const buildRoute=/^\/api\/builds\/([^/]+)(\/artifact)?$/.exec(url.pathname);
      if(buildRoute&&['GET','HEAD'].includes(req.method)){
        const jobId=id(buildRoute[1]);
        if(!buildRoute[2])return jsonResponse(res,200,builds.status(jobId));
        const artifact=builds.artifact(jobId),range=parseRange(req.headers.range,artifact.stat.size);
        res.setHeader('Content-Type','application/zip');res.setHeader('Cache-Control','no-store');res.setHeader('Accept-Ranges','bytes');
        res.setHeader('ETag',`"${artifact.sha256}"`);res.setHeader('X-Artifact-SHA256',artifact.sha256);
        res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(artifact.path))}`);
        res.writeHead(range?206:200,range?{'Content-Range':`bytes ${range.start}-${range.end}/${artifact.stat.size}`,'Content-Length':range.end-range.start+1}:{'Content-Length':artifact.stat.size});
        if(req.method==='HEAD')return res.end();
        const stream=fs.createReadStream(artifact.path,range||{});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());return stream.pipe(res);
      }
      const projectRoute=/^\/api\/projects\/([^/]+)\/(files|git|preview|download|manifest)$/.exec(url.pathname);
      if(projectRoute&&['GET','HEAD'].includes(req.method)){
        const [,projectId,action]=projectRoute,relative=url.searchParams.get('path')||'';
        if(action==='files')return jsonResponse(res,200,{data:projects.files(projectId,relative)});
        if(action==='git')return jsonResponse(res,200,await projects.git(projectId));
        if(action==='manifest')return jsonResponse(res,200,await projects.manifest(projectId,relative));
        const target=projects.resolve(projectId,relative);if(!target.stat.isFile())throw new HttpError(400,'需要文件');
        if(action==='preview'){
          if(target.stat.size>256*1024)throw new HttpError(413,'文件较大，请按需下载');
          const data=fs.readFileSync(target.path);if(data.includes(0))throw new HttpError(415,'二进制文件请下载后打开');
          return jsonResponse(res,200,{text:data.toString('utf8'),bytes:data.length,path:relative});
        }
        const etag=`"${target.stat.size.toString(16)}-${Math.trunc(target.stat.mtimeMs).toString(16)}"`;
        const range=req.headers['if-range']&&req.headers['if-range']!==etag?null:parseRange(req.headers.range,target.stat.size);
        res.setHeader('Content-Type','application/octet-stream');res.setHeader('Cache-Control','no-store');
        res.setHeader('Accept-Ranges','bytes');res.setHeader('ETag',etag);
        res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target.path))}`);
        if(range){res.writeHead(206,{'Content-Range':`bytes ${range.start}-${range.end}/${target.stat.size}`,'Content-Length':range.end-range.start+1});}
        else res.writeHead(200,{'Content-Length':target.stat.size});
        if(req.method==='HEAD')return res.end();
        const stream=fs.createReadStream(target.path,range||{});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());return stream.pipe(res);
      }
      if(url.pathname==='/api/neo'&&req.method==='POST'){
        if(config.readOnly!==false)throw new HttpError(403,'只读模式未启用现场执行');
        const data=await bodyJson(req);return jsonResponse(res,200,await neoTask(config.neo,data.action));
      }
      if(url.pathname==='/api/admin/shutdown'&&req.method==='POST'){
        if(!local)throw new HttpError(403,'只能在 Windows 本机停止');
        jsonResponse(res,200,{stopping:true});setTimeout(()=>stop(),150);return;
      }
      throw new HttpError(404,'接口不存在');
    }catch(e){
      if(!res.headersSent)jsonResponse(res,e.status||500,{error:redact(e.message),...(e.rpcError?.data?.type?{type:e.rpcError.data.type}:{})});
      else res.destroy();
    }
  });
  server.requestTimeout=65000;server.headersTimeout=10000;
  async function stop(){if(stopping)return;stopping=true;clearInterval(timer);builds.stop();rpc.close();server.close();server.closeAllConnections();}
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});
  atomicJson(path.join(config.dataRoot,'host.json'),{pid:process.pid,port:config.port,startedAt:new Date().toISOString()});
  if(!dependencies.noPolling&&config.enableCodex){tracker.poll();timer=setInterval(()=>tracker.poll(),Math.max(1000,config.pollMs||5000));}
  return {server,rpc,tracker,control,auth,projects,builds,stop};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const config=loadConfig(),bridge=await createBridge(config);
    process.on('SIGTERM',()=>bridge.stop());process.on('SIGINT',()=>bridge.stop());
    console.log(`Bridges v0.1.0 已启动：http://127.0.0.1:${config.port}；工作数据：${config.dataRoot}`);
  }catch(e){console.error(redact(e.message));process.exitCode=1;}
}
