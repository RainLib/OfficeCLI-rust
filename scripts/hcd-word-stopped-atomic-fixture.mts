/** Visible two-window acceptance of the production stopped-device stores.
 * Reviews come from the actual local service. Preparation never dispatches an
 * apply/save; ordinary recovery UI resolves whichever complete intent wins. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,basename} from 'node:path'
const root=resolve(process.argv[2]),c=JSON.parse(await readFile(root+'/private.json','utf8'))
assert.equal(c.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
const session={documentId:c.documentId,token:c.alice,scope:'write',format:'docx',userId:'alice',displayName:'Alice 王',apiUrl:'/v1/documents',collabUrl:`ws://127.0.0.1:${c.browserCollabPort??c.collabPort}`,collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2'}
const urls:Record<string,string>={}
for(const role of ['controller','draft','topology']){
 const html=`<!doctype html><meta charset="utf-8"><title>停房设备事务竞争 · ${role}</title><style>body{font:15px/1.7 system-ui;max-width:850px;margin:40px auto;padding:20px;color:#24334c}button,a{margin:8px;padding:8px}pre{white-space:pre-wrap;background:#f0f4fb;padding:18px;border-radius:8px}</style><h1>停房设备事务竞争 · ${role}</h1><p>使用真实服务的比较参数与当前产品设备存储，在两个窗口同时准备；准备阶段不提交文档。</p><nav><a href="atomic-draft.html">草稿窗口</a><a href="atomic-topology.html">页脚窗口</a><a href="layout-alice.html">打开普通恢复页</a></nav><button id="start" disabled>同时准备草稿和页脚</button><button id="download" disabled>下载本窗口原请求</button><button id="results" disabled>下载竞态结果</button><pre id="state">正在准备…</pre><script type="module">
import {WordDraftAttempts} from '/src/wordDraftAttempt.ts';import {WordLayoutAttempts} from '/src/wordLayoutAttempt.ts';import {previewStoppedStory} from '/src/wordStoppedStoryClient.ts';import {negotiationURL} from '/src/protocolClient.ts';
const role=${JSON.stringify(role)},session=${JSON.stringify(session)},channel=new BroadcastChannel(${JSON.stringify('atomic-'+basename(root))}),state=document.getElementById('state'),start=document.getElementById('start'),download=document.getElementById('download'),results=document.getElementById('results'),ready=new Set(),outcomes={};let journal,action,review,started=false;
const show=value=>{state.textContent=typeof value==='string'?value:JSON.stringify(value,null,2)},file=(name,value)=>{const url=URL.createObjectURL(new Blob([value],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
channel.onmessage=async({data})=>{
 if(role==='controller'){
  if(data.type==='ready'){ready.add(data.role);show('已就绪：'+[...ready].join('、'));start.disabled=ready.size!==2}
  if(data.type==='result'){outcomes[data.role]=data;show(outcomes);results.disabled=Object.keys(outcomes).length!==2;if(!results.disabled){const accepted=Object.values(outcomes).filter(value=>value.accepted).length;state.textContent+='\\n'+(accepted===1?'通过：仅一类完整原请求获准':'失败：获准数量 '+accepted)}}
 }else if(data.type==='start'&&!started){started=true;try{if(role==='draft')await journal.beginSave(review.reviewHash,review.revision);else await journal.prepare(action,true);download.disabled=false;const result={type:'result',role,accepted:true,id:journal.attemptId};show(result);channel.postMessage(result)}catch(error){const result={type:'result',role,accepted:false,code:error instanceof Error&&error.message.startsWith('word-')?error.message:'fixture-unavailable'};show(result);channel.postMessage(result)}}
};
start.onclick=()=>{start.disabled=true;channel.postMessage({type:'start'})};download.onclick=()=>{if(journal?.backup)file('atomic-'+role+'-request.json',journal.backup)};results.onclick=()=>file('atomic-results.json',JSON.stringify(outcomes,null,2));
try{
 if(role==='controller')show('请分别打开草稿窗口和页脚窗口，等待两者就绪。');else{
  if(role==='draft'){
   journal=await WordDraftAttempts.open(session,location.href);const response=await fetch(negotiationURL(session).replace(/\\/negotiate$/,'/word-stopped-draft'),{method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify({epoch:1,operation:'inspect',offset:0})});if(!response.ok)throw Error('fixture-unavailable');review=await response.json();
  }else{
   journal=await WordLayoutAttempts.open(session,location.href);const selection={sectionId:${JSON.stringify(c.initialProjection.flowLayout.sections[0].id)},kind:'footer',variant:'even',transactionId:crypto.randomUUID().replaceAll('-','')};review=await previewStoppedStory(session,selection,new AbortController().signal);action={kind:'story',section:review.section,baseRevision:review.revision,body:{epoch:1,operation:'apply',...selection,reviewHash:review.reviewHash}};
  }
  if(journal.phase!=='idle')throw Error('word-fixture-request-pending');show('准备就绪，等待控制窗口同时发起。');channel.postMessage({type:'ready',role});
 }
}catch{show('夹具无法准备；请保留原请求并检查服务。')}
addEventListener('beforeunload',()=>{journal?.dispose();channel.close()});
</script>`
 await writeFile(root+`/editor/atomic-${role}.html`,html,{mode:0o600});urls[role]=`http://127.0.0.1:${c.vitePort}/atomic-${role}.html`
}
const bob={...session,token:c.bob,userId:'bob',displayName:'Bob 李'}
const legacyHtml=`<!doctype html><meta charset="utf-8"><title>旧设备队列迁移验证</title><style>body{font:15px/1.7 system-ui;max-width:850px;margin:40px auto;padding:20px}button,a{margin:8px;padding:8px}pre{white-space:pre-wrap;background:#eef3fb;padding:18px}</style><h1>旧设备队列迁移验证</h1><p>在另一成员的隔离设备范围内保留旧版两类完整原请求，再使用当前产品迁移；不发送保存或结构提交。</p><button id="seed">保留旧版草稿与页脚请求</button><button id="migrate" disabled>在新存储中打开两类请求</button><button id="download" disabled>下载迁移证据</button><a href="layout-bob.html">打开普通恢复页</a><pre id="state">尚未创建旧请求。</pre><script type="module">
import {draftNamespace} from '/src/localDrafts.ts';import {openWordStoryRequestStore} from '/src/wordStoryRequestStore.ts';import {deviceRequestQueueJson} from '/src/wordDeviceRequestQueue.ts';import {stoppedDraftQueueOptions,stoppedTopologyQueueOptions} from '/src/wordStoppedRequestStore.ts';import {WordDraftAttempts} from '/src/wordDraftAttempt.ts';import {WordLayoutAttempts} from '/src/wordLayoutAttempt.ts';import {previewStoppedStory} from '/src/wordStoppedStoryClient.ts';import {negotiationURL} from '/src/protocolClient.ts';
const session=${JSON.stringify(bob)},seed=document.getElementById('seed'),migrate=document.getElementById('migrate'),download=document.getElementById('download'),state=document.getElementById('state'),olds=[];let originals,proof,d,t;
seed.onclick=async()=>{seed.disabled=true;try{
 const scope=await draftNamespace(session,session.userId,location.href),prefix=scope.prefix+'wordregions2',response=await fetch(negotiationURL(session).replace(/\\/negotiate$/,'/word-stopped-draft'),{method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify({epoch:1,operation:'inspect',offset:0})});if(!response.ok)throw Error('review');const review=await response.json(),checkpointId=crypto.randomUUID().replaceAll('-',''),selection={sectionId:${JSON.stringify(c.initialProjection.flowLayout.sections[1].id)},kind:'footer',variant:'even',transactionId:crypto.randomUUID().replaceAll('-','')},story=await previewStoppedStory(session,selection,new AbortController().signal),actor={userId:session.userId,displayName:session.displayName};
 originals=[{schemaVersion:'hcd-word-draft-attempt/2',epoch:1,checkpointId,actor,actions:[{kind:'save',baseRevision:review.revision,body:{epoch:1,operation:'save',checkpointId,reviewHash:review.reviewHash}}]},{schemaVersion:'hcd-word-stopped-topology/2',epoch:1,transactionId:selection.transactionId,actor,actions:[{kind:'story',section:story.section,baseRevision:story.revision,body:{epoch:1,operation:'apply',...selection,reviewHash:story.reviewHash}}]}].map(value=>JSON.stringify(value));
 for(let i=0;i<2;i++){const old=await openWordStoryRequestStore((i===0?'hcd-word-draft-attempt-v2-':'hcd-word-stopped-topology-v2-')+prefix);await old.replace(null,deviceRequestQueueJson([originals[i]],i===0?stoppedDraftQueueOptions:stoppedTopologyQueueOptions));olds.push(old)}state.textContent='已保留两类旧请求，两个旧连接保持打开。';migrate.disabled=false;
}catch{state.textContent='旧请求创建失败；保留设备数据，未提交文档。'}};
migrate.onclick=async()=>{migrate.disabled=true;try{
 [d,t]=await Promise.all([WordDraftAttempts.open(session,location.href),WordLayoutAttempts.open(session,location.href)]);const imported=[d.backup,t.backup],fenced=[];for(const old of olds){try{await old.read();fenced.push(false)}catch{fenced.push(true)}}proof={scope:'actual browser migration of service-reviewed old requests; old production client not tested',originals,imported,oldConnectionsFenced:fenced,completeRequestsExact:originals.every((value,index)=>value===imported[index]),bothPending:d.pendingCount===1&&t.pendingCount===1};state.textContent=JSON.stringify({completeRequestsExact:proof.completeRequestsExact,bothPending:proof.bothPending,oldConnectionsFenced:fenced},null,2);download.disabled=false;
}catch{state.textContent='迁移未完成；旧请求保留，未提交文档。'}};
download.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(proof,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='legacy-device-migration.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
addEventListener('beforeunload',()=>{d?.dispose();t?.dispose();olds.forEach(old=>old.close())});
</script>`
await writeFile(root+'/editor/atomic-legacy.html',legacyHtml,{mode:0o600});urls.legacy=`http://127.0.0.1:${c.vitePort}/atomic-legacy.html`
console.log(JSON.stringify({...urls,scope:'actual IndexedDB in browser windows; service-reviewed preparation only, no apply/save dispatch'}))
