const $=s=>document.querySelector(s);
const state={selected:null,threads:[],turns:new Map(),cursor:null,leases:[],project:null,directory:'',eventCursor:0,requests:[],loading:false,historyBusy:false};
const show=(el,visible=true)=>el.classList.toggle('hidden',!visible);
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
function toast(text){$('#toast').textContent=text;show($('#toast'));clearTimeout(toast.timer);toast.timer=setTimeout(()=>show($('#toast'),false),6500);}
async function api(url,data){
  const options={credentials:'same-origin',cache:'no-store'};
  if(data!==undefined){options.method='POST';options.headers={'Content-Type':'application/json','X-Bridges-Client':'1'};options.body=JSON.stringify(data);}
  const response=await fetch(url,options);const json=await response.json();
  if(!response.ok){if(response.status===401){show($('#workspace'),false);show($('#login'));}throw new Error(json.error||`请求失败 ${response.status}`);}
  return json;
}
function busy(button,fn){return async()=>{button.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{button.disabled=false;}};}
function size(n){if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;return`${(n/1048576).toFixed(1)} MB`;}
function time(n){return n?new Date(n*1000).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'}):'';}
function renderThreads(){
  $('#threads').replaceChildren();
  for(const thread of state.threads){
    const el=node('button',undefined,`thread-item${thread.id===state.selected?' active':''}`);
    el.append(node('strong',thread.name));const meta=node('small');
    const base=(thread.cwd||'').split(/[\\/]/).filter(Boolean).pop()||'工程';
    meta.append(node('span',base),node('span',thread.status==='running'?'运行中':time(thread.updatedAt),thread.status==='running'?'running':''));
    el.append(meta);el.title=thread.name;el.addEventListener('click',()=>selectThread(thread.id).catch(e=>toast(e.message)));$('#threads').append(el);
  }
  if(!state.threads.length)$('#threads').append(node('p','没有找到对话','hint'));
}
async function loadThreads(q=''){
  const data=await api('/api/threads'+(q?`?q=${encodeURIComponent(q)}`:''));state.threads=data.data;renderThreads();
}
async function selectThread(threadId){
  state.selected=threadId;state.turns.clear();state.cursor=null;state.requests=[];location.hash=threadId;
  renderThreads();show($('#conversation-empty'),false);show($('#conversation-content'));$('#messages').replaceChildren();$('#approvals').replaceChildren();
  show($('#sync-detail'),false);$('#message').value='';
  const t=state.threads.find(t=>t.id===threadId);$('#thread-title').textContent=t?.name||threadId;
  $('#thread-location').textContent=[t?.cwd,t?.modelProvider,t?.model].filter(Boolean).join(' · ');
  await api(`/api/threads/${threadId}/watch`,{});await loadHistory(false);await refreshStatus();
}
async function loadHistory(older=false){
  const selected=state.selected;if(!selected||state.historyBusy)return;
  state.historyBusy=true;
  try{
    const data=await api(`/api/threads/${selected}/history`+(older&&state.cursor?`?cursor=${encodeURIComponent(state.cursor)}`:''));
    if(selected!==state.selected)return;
    for(const turn of data.data)state.turns.set(turn.id,turn);
    if(older||state.cursor===null)state.cursor=data.nextCursor||null;
    show($('#older'),Boolean(state.cursor));renderMessages(!older);
  }finally{state.historyBusy=false;}
}
function renderMessages(scroll){
  const box=$('#messages'),atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;
  const oldHeight=box.scrollHeight,oldTop=box.scrollTop,fragment=document.createDocumentFragment();
  const turns=[...state.turns.values()].sort((a,b)=>(a.startedAt||0)-(b.startedAt||0));
  for(const turn of turns){
    if(turn.startedAt)fragment.append(node('div',new Date(turn.startedAt*1000).toLocaleString('zh-CN'),'turn-divider'));
    for(const item of turn.items||[]){
      if(item.type==='userMessage'){
        const text=(item.content||[]).map(c=>c.text||(['image','localImage'].includes(c.type)?'[图片附件]':'')).filter(Boolean).join('\n');
        if(text){const el=node('article',undefined,'message user');el.append(node('div','你','message-label'),node('div',text,'message-text'));fragment.append(el);}
      }else if(item.type==='agentMessage'){
        if(item.text){const el=node('article',undefined,'message');el.append(node('div',item.phase==='commentary'?'Codex · 进度':'Codex','message-label'),node('div',item.text,'message-text'));fragment.append(el);}
      }else if(['commandExecution','mcpToolCall','fileChange','webSearch'].includes(item.type)){
        const details=node('details',undefined,'message tool-summary');
        const titles={commandExecution:'命令',mcpToolCall:'工具',fileChange:'文件修改',webSearch:'资料检索'};
        const name=item.command||item.tool||item.query||'';
        details.append(node('summary',`${titles[item.type]} · ${String(name).slice(0,110)}${item.status?` · ${item.status}`:''}`));
        let text=item.aggregatedOutput||item.output||item.result||item.changes||'';
        if(typeof text!=='string')text=JSON.stringify(text,null,2);
        details.append(node('pre',text.slice(0,50000)||'该操作没有文本输出'));fragment.append(details);
      }
    }
  }
  box.replaceChildren(fragment);
  if(scroll&&atBottom)box.scrollTop=box.scrollHeight;
  else if(!scroll)box.scrollTop=oldTop+(box.scrollHeight-oldHeight);
}
async function refreshStatus(){
  const s=await api('/api/status');state.leases=s.leases;
  $('#host').textContent=s.host;$('#connection-dot').classList.toggle('online',s.codexReady);
  $('#connection-text').textContent=s.fileBridge?'工程文件工具就绪':!s.accountConnected?'离线只读预览':s.codexReady?'工作站已连接':'正在重连工作站';
  $('#connection-dot').classList.toggle('online',s.fileBridge||s.codexReady);
  $('#status-text').textContent=s.fileBridge?'源工程只读访问 · 在 Windows 构建部署包 · 两端账号各自保留':!s.accountConnected?'离线只读预览 · 账号未连接 · 工程目录按允许清单隔离':s.error?`重连中：${s.error}`:s.codexReady?'原始上下文持续跟踪 · 按需访问工程文件':'正在连接 Codex 服务';
  $('#last-poll').textContent=s.lastPoll?`更新于 ${new Date(s.lastPoll).toLocaleTimeString('zh-CN')}`:'';
  show($('#pair-button'),s.local);
  $('#neo-status').textContent=s.neo.configured?'Neo SSH 已配置，可以检查现场设备。':'Neo 尚未接入。按接入说明开启 SSH，并安装随包提供的现场助手。';
  document.querySelectorAll('[data-neo]').forEach(b=>{b.disabled=!s.neo.configured;});
  if(state.selected){
    const lease=s.leases.find(l=>l.threadId===state.selected),mine=Boolean(lease?.mine);
    const watched=s.watched.find(w=>w.threadId===state.selected);const activity=watched?.raw?.activity?.state||'unknown';
    $('#thread-state').textContent=activity==='running'?'正在运行':activity==='idle'?'本轮已结束':'状态待确认';
    show($('#takeover'),!mine&&!s.readOnly);show($('#release'),mine&&!s.readOnly);show($('#interrupt'),mine&&activity==='running'&&!s.readOnly);
    const canSend=mine&&activity==='idle'&&s.codexReady&&!state.loading&&!s.readOnly;
    $('#message').disabled=!mine;$('#send').disabled=!canSend;
    $('#message').placeholder=mine?'继续这个工程…':'先点击「在这台继续」接续会话';
    $('#composer-hint').textContent=mine?(activity==='running'?'Codex 正在执行；完成后可以继续发送':'本页持有会话 · 执行位置 Windows'):'先结束 Windows 上的当前轮次，再接续';
  }
}
function renderApprovals(){
  const box=$('#approvals');box.replaceChildren();
  for(const request of state.requests.filter(r=>r.params?.threadId===state.selected)){
    const el=node('div',undefined,'approval');el.append(node('strong','Codex 需要你的处理'));
    const p=request.params||{},method=request.method;
    el.append(node('p',p.reason||p.message||method));
    if(p.command)el.append(node('pre',p.command));
    if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)){
      for(const [label,answer]of [['允许本次','accept'],['拒绝','decline']]){
        const b=node('button',label,answer==='decline'?'secondary':'');b.onclick=busy(b,async()=>{await api('/api/approval',{requestId:request.id,answer});await pollEvents();});el.append(b);
      }
    }else if(method==='item/tool/requestUserInput'){
      const controls=[];
      for(const q of p.questions||[]){
        const label=node('label',q.question||q.header);let input;
        if(q.options?.length){input=node('select');input.append(new Option('请选择',''));for(const o of q.options)input.append(new Option(o.label,o.label));}
        else{input=node('input');input.type='text';}
        label.append(input);el.append(label);controls.push({id:q.id,input});
      }
      const b=node('button','提交回答');b.onclick=busy(b,async()=>{
        if(controls.some(c=>!c.input.value.trim()))throw new Error('请回答所有问题');
        await api('/api/approval',{requestId:request.id,answer:Object.fromEntries(controls.map(c=>[c.id,{answers:[c.input.value]}]))});await pollEvents();
      });el.append(b);
    }else{el.append(node('p','此交互类型请回到 Windows 处理。可以停止本轮，再交回 Windows。'));}
    box.append(el);
  }
}
async function pollEvents(){
  const data=await api(`/api/events?after=${state.eventCursor}`);state.eventCursor=data.cursor;
  if(JSON.stringify(state.requests)!==JSON.stringify(data.requests)){state.requests=data.requests;renderApprovals();}
  if(data.lost)await loadHistory();
}
async function listProjects(){
  const {data}=await api('/api/projects');$('#project-list').replaceChildren();
  for(const project of data){const b=node('button',project.name,'project-item');b.onclick=()=>openProject(project).catch(e=>toast(e.message));b.dataset.id=project.id;$('#project-list').append(b);}
}
async function openProject(project){
  state.project=project;state.directory='';$('#project-title').textContent=project.name;$('#project-location').textContent=project.root;
  document.querySelectorAll('.project-item').forEach(b=>b.classList.toggle('active',b.dataset.id===project.id));show($('#git-button'));await listFiles('');
}
async function listFiles(directory){
  if(!state.project)return;state.directory=directory;show($('#file-preview'),false);
  const p=state.project.id,{data}=await api(`/api/projects/${p}/files?path=${encodeURIComponent(directory)}`);
  $('#breadcrumbs').replaceChildren();const parts=directory.split('/').filter(Boolean);
  ['工程根目录',...parts].forEach((text,index)=>{const b=node('button',text);b.onclick=()=>listFiles(parts.slice(0,index).join('/')).catch(e=>toast(e.message));$('#breadcrumbs').append(b);});
  $('#files').replaceChildren();
  for(const file of data){
    const row=node('div',undefined,'file-row'),name=node('button',`${file.directory?'▸  ':''}${file.name}`,'file-name');
    name.onclick=async()=>{try{if(file.directory)await listFiles(file.path);else{const r=await api(`/api/projects/${p}/preview?path=${encodeURIComponent(file.path)}`);$('#file-preview').textContent=r.text;show($('#file-preview'));}}catch(e){toast(e.message);}};
    row.append(name);const info=node('div',undefined,'file-info');if(!file.directory){info.append(node('span',size(file.bytes)));const a=node('a','下载','download');a.href=`/api/projects/${p}/download?path=${encodeURIComponent(file.path)}`;info.append(a);}row.append(info);$('#files').append(row);
  }
  if(!data.length)$('#files').append(node('p','此目录没有可显示的文件','hint'));
}
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{
  document.querySelectorAll('.view').forEach(el=>show(el,el.id===button.dataset.view));
  document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b===button));$('#page-title').textContent=button.textContent;
  if(button.dataset.view==='projects')listProjects().catch(e=>toast(e.message));
});
$('#login-form').onsubmit=async event=>{event.preventDefault();try{await api('/api/login',{code:$('#pair-code').value});await init();}catch(e){$('#login-error').textContent=e.message;}};
$('#refresh').onclick=busy($('#refresh'),()=>loadThreads($('#search').value.trim()));
$('#search').oninput=()=>{clearTimeout(state.searchTimer);state.searchTimer=setTimeout(()=>loadThreads($('#search').value.trim()).catch(e=>toast(e.message)),400);};
$('#older').onclick=busy($('#older'),()=>loadHistory(true));
$('#takeover').onclick=()=>{$('#takeover-confirm').checked=false;$('#confirm-takeover').disabled=true;$('#takeover-dialog').showModal();};
$('#takeover-confirm').onchange=()=>{$('#confirm-takeover').disabled=!$('#takeover-confirm').checked;};
$('#takeover-dialog').addEventListener('close',async()=>{
  if($('#takeover-dialog').returnValue!=='continue')return;
  try{await api(`/api/threads/${state.selected}/takeover`,{confirmed:$('#takeover-confirm').checked});await refreshStatus();toast('已接续原会话，计算和工程操作继续在 Windows 执行');}catch(e){toast(e.message);}
});
$('#release').onclick=busy($('#release'),async()=>{await api(`/api/threads/${state.selected}/release`,{});await refreshStatus();});
$('#interrupt').onclick=busy($('#interrupt'),async()=>{await api(`/api/threads/${state.selected}/interrupt`,{});toast('已请求停止，等待当前轮次结束');});
$('#manifest').onclick=busy($('#manifest'),async()=>{
  const m=await api(`/api/threads/${state.selected}/manifest`);$('#sync-detail').textContent=`原始记录：${size(m.rollout.bytes)} · ${m.rawComplete?'已追平':'正在追平'}\n分页历史：${m.historyComplete?'已完整跟踪':'正在后台补齐'}\nSHA-256：${m.rollout.sha256}\n接续位置：Windows 原生会话存储`;show($('#sync-detail'));
});
$('#composer').onsubmit=async event=>{
  event.preventDefault();if(state.loading||$('#send').disabled)return;const selected=state.selected,text=$('#message').value.trim();if(!text)return;
  state.loading=true;$('#send').disabled=true;
  try{await api(`/api/threads/${selected}/send`,{text,messageId:crypto.randomUUID()});if(state.selected===selected)$('#message').value='';await loadHistory();}
  catch(e){toast(`${e.message}。消息不会自动重发，请先检查最新记录。`);}
  finally{state.loading=false;await refreshStatus().catch(()=>{});}
};
$('#pair-button').onclick=busy($('#pair-button'),async()=>{const pair=await api('/api/pair',{});$('#pair-value').textContent=pair.code;$('#pair-dialog').showModal();});
$('#git-button').onclick=busy($('#git-button'),async()=>{const g=await api(`/api/projects/${state.project.id}/git`);$('#file-preview').textContent=g.available?`HEAD: ${g.head||'尚无提交'}\n\n${g.status}`:'此目录没有可用的 Git 仓库';show($('#file-preview'));});
document.querySelectorAll('[data-neo]').forEach(b=>b.onclick=busy(b,async()=>{const r=await api('/api/neo',{action:b.dataset.neo});$('#neo-result').textContent=r.output+(r.stderr?'\n'+r.stderr:'');show($('#neo-result'));}));
async function init(){
  const session=await api('/api/session');show($('#login'),!session.authenticated);show($('#workspace'),session.authenticated);
  if(!session.authenticated)return;
  await loadThreads();await refreshStatus();const previous=location.hash.slice(1);if(state.threads.some(t=>t.id===previous))await selectThread(previous);
  clearInterval(state.timer);state.timer=setInterval(async()=>{
    if(document.hidden||state.polling)return;state.polling=true;
    try{await refreshStatus();await pollEvents();await loadHistory();}catch(e){$('#connection-text').textContent='连接中断，正在重试';$('#connection-dot').classList.remove('online');}
    finally{state.polling=false;}
  },4000);
}
init().catch(e=>toast(e.message));
