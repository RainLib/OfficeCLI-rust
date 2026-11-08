/** Verify large recovery attachments through explicit association, save and reopen. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
const restore=true
if(!rootArg||!outArg)throw Error('usage: node hcd-recovery-large-attach-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
const root=resolve(rootArg),out=resolve(outArg),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
if(config.root!==root||!root.includes('/target/hcd-preview-runtime/hcd-inline-editor-')||!/^http:\/\/127\.0\.0\.1:\d+\/inline-writer\.html$/.test(config.pages.writer))throw Error('not an owned inline editor fixture')
await mkdir(out,{recursive:true})
const profile=await mkdtemp(join(tmpdir(),'hcd-crash-browser-')),url=config.pages.writer,base=`http://127.0.0.1:${config.ports[0]}/v1/documents/inline-native`,headers={Authorization:`Bearer ${config.tokens.reader}`}
let instance
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function start(){
 await rm(join(profile,'DevToolsActivePort'),{force:true})
 const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run','--user-data-dir='+profile,'--remote-debugging-port=0','about:blank'],{stdio:'ignore',detached:true})
 let port
 for(let n=0;n<120;n++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}await sleep(100)}
 if(!port)throw Error('owned Chrome did not start')
 const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json(),ws=new WebSocket(version.webSocketDebuggerUrl)
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
 let seq=0;const pending=new Map()
 ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);message.error?reject(Error(message.error.message)):resolve(message.result)}}
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})
 const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true})
 await call('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false},sessionId);await call('Page.enable',{},sessionId);await call('Runtime.enable',{},sessionId);await call('Page.navigate',{url},sessionId)
 const evaluate=async(expression,awaitPromise=false)=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise},sessionId);if(result.exceptionDetails)throw Error('browser evaluation failed');return result.result.value}
 return{chrome,ws,call,sessionId,evaluate}
}
async function waitFor(test,label,timeout=20000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await test())return;await sleep(100)}throw Error(label+' timed out')}
async function killBrowser(browser){const exit=new Promise(resolve=>browser.chrome.once('exit',(code,signal)=>resolve({code,signal})));process.kill(-browser.chrome.pid,'SIGKILL');const result=await exit;browser.ws.close();assert.equal(result.signal,'SIGKILL');await sleep(300)}
async function snapshot(browser,name){const data=await browser.call('Page.captureScreenshot',{format:'png'},browser.sessionId);await writeFile(join(out,name),Buffer.from(data.data,'base64'))}
async function serverHead(){const response=await fetch(base,{headers});assert.equal(response.status,200);return(await response.json()).revision}
const body=browser=>browser.evaluate('document.body?.innerText||""')
const click=async(browser,label)=>{const ok=await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(label)})&&!b.disabled);if(!b)return false;b.click();return true})()`);assert.equal(ok,true,`missing button ${label}`)}
try{
 instance=await start();await instance.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:out},undefined);await waitFor(async()=>(await body(instance)).includes('修订'),'editor load',30000);await sleep(1000)
 assert.equal(await instance.evaluate(`(async()=>{const target=document.querySelector('[data-hcd-inline-container]')?.pmViewDesc?.node?.attrs?.extension;if(!target)throw Error('missing actual node payload');const name=(await indexedDB.databases()).map(x=>x.name).find(x=>x&&x.endsWith('-nodefiles1'));const db=await new Promise(resolve=>{const q=indexedDB.open(name);q.onsuccess=()=>resolve(q.result)});for(let i=1;i<=2;i++){const id='00000000-0000-4000-8000-'+String(i).padStart(12,'0'),bytes=new Uint8Array(6*1024*1024);bytes.fill(i);const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');const file={version:1,id,regionId:'body',phase:'chosen',expected:target,resource:{key:'large_'+i,hash,byteLength:bytes.length,name:'large-'+i+'.bin',mediaType:'application/octet-stream'},bytes};await new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put(file,'node-resource:'+id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}db.close();return true})()`,true),true)
 const head=await serverHead();await click(instance,'修订');await waitFor(async()=>(await body(instance)).includes('草稿恢复副本'),'recovery control');await click(instance,'草稿恢复副本');await waitFor(async()=>await instance.evaluate("!!document.querySelector('.recovery-archive-panel')"),'portable panel',30000)
 await instance.evaluate(`(()=>{window.__hcdExportPerf={start:performance.now(),long:[]};window.__hcdExportObserver=new PerformanceObserver(list=>{for(const e of list.getEntries())window.__hcdExportPerf.long.push({start:e.startTime,duration:e.duration})});window.__hcdExportObserver.observe({entryTypes:['longtask']})})()`)
 const exportStart=Date.now();await click(instance,'导出恢复包');const packet=join(out,'inline-native.hcd-recovery');await waitFor(async()=>{try{return(await readFile(packet)).length>0}catch{return false}},'large packet export',120000);const exportMs=Date.now()-exportStart
 const bytes=await readFile(packet),archive=JSON.parse(bytes.toString());for(let i=1;i<=2;i++){const file=archive.pendingFiles.find(x=>x.resource.name===`large-${i}.bin`),asset=archive.resources.find(x=>x.sha256===file?.resource.hash);assert.ok(asset);const content=Buffer.from(asset.base64,'base64');assert.equal(content.length,6*1024*1024);assert.ok(content.every(byte=>byte===i))}
 await waitFor(async()=>(await body(instance)).includes('恢复包已导出'),'export complete',30000)
 const exportLongTasks=await instance.evaluate(`(()=>{window.__hcdExportObserver.disconnect();return window.__hcdExportPerf.long.filter(e=>e.start>=window.__hcdExportPerf.start)})()`)
 if(restore)await instance.evaluate(`(async()=>{const name=(await indexedDB.databases()).map(x=>x.name).find(x=>x&&x.endsWith('-nodefiles1'));const db=await new Promise(resolve=>{const q=indexedDB.open(name);q.onsuccess=()=>resolve(q.result)});await new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite');for(let i=1;i<=2;i++)tx.objectStore('meta').delete('node-resource:00000000-0000-4000-8000-'+String(i).padStart(12,'0'));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close()})()`,true)
 await instance.evaluate(`(()=>{window.__hcdPerf={long:[],start:performance.now(),end:null};window.__hcdObserver=new PerformanceObserver(list=>{for(const e of list.getEntries())window.__hcdPerf.long.push({start:e.startTime,duration:e.duration})});window.__hcdObserver.observe({entryTypes:['longtask']});window.__hcdMutation=new MutationObserver(()=>{if(document.querySelector('.recovery-archive-panel')?.innerText.includes('保存基线 r')){window.__hcdPerf.end=performance.now();window.__hcdMutation.disconnect()}});window.__hcdMutation.observe(document.body,{subtree:true,childList:true,characterData:true})})()`)
 const {root:dom}=await instance.call('DOM.getDocument',{},instance.sessionId),{nodeId}=await instance.call('DOM.querySelector',{nodeId:dom.nodeId,selector:'.recovery-archive-panel input[type=file]'},instance.sessionId);assert.ok(nodeId)
 await instance.call('DOM.setFileInputFiles',{nodeId,files:[packet]},instance.sessionId);await waitFor(async()=>{const text=await body(instance);if(text.includes('恢复包或其中的文档、资源未通过校验'))throw Error('recovery comparison rejected the package');return text.includes('保存基线 r')&&text.includes('large-1.bin')&&text.includes('large-2.bin')},'large packet comparison',120000);await sleep(500)
 const perf=await instance.evaluate(`(()=>{window.__hcdObserver.disconnect();const {start,end,long}=window.__hcdPerf;return{comparisonMs:end-start,longTasks:long.filter(e=>e.start>=start&&e.start<=end)}})()`);assert.equal(await serverHead(),head);assert.ok(perf.comparisonMs>0);await snapshot(instance,'comparison.png')
 let restored=false
 if(restore){await click(instance,'确认合并到草稿');await waitFor(async()=>(await body(instance)).includes('操作完成。导入内容按正常协同和保存处理'),'recovery merged',120000)
  const restoredFiles=await instance.evaluate(`(async()=>{const name=(await indexedDB.databases()).map(x=>x.name).find(x=>x&&x.endsWith('-nodefiles1'));const db=await new Promise(resolve=>{const q=indexedDB.open(name);q.onsuccess=()=>resolve(q.result)});const entries=await new Promise(resolve=>{const q=db.transaction('meta').objectStore('meta').getAll();q.onsuccess=()=>resolve(q.result)});db.close();const result=[];for(const x of entries.filter(x=>x.resource?.name?.startsWith('large-'))){const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',x.bytes)),n=>n.toString(16).padStart(2,'0')).join('');result.push({name:x.resource.name,hash,declared:x.resource.hash,length:x.bytes.length,phase:x.phase})}return result})()`,true)
  assert.equal(restoredFiles.length,2);for(const item of restoredFiles){const file=archive.pendingFiles.find(x=>x.resource.name===item.name);assert.equal(item.hash,file.resource.hash);assert.equal(item.hash,item.declared);assert.equal(item.length,6*1024*1024)}restored=true;await snapshot(instance,'restored.png')
  await click(instance,'重新比较');await waitFor(async()=>(await body(instance)).includes('保存基线 r'),'repeat comparison',120000)
  await click(instance,'确认合并到草稿');await waitFor(async()=>(await body(instance)).includes('操作完成。导入内容按正常协同和保存处理'),'repeat merge',120000)
  const again=await instance.evaluate(`(async()=>{const name=(await indexedDB.databases()).map(x=>x.name).find(x=>x&&x.endsWith('-nodefiles1'));const db=await new Promise(resolve=>{const q=indexedDB.open(name);q.onsuccess=()=>resolve(q.result)});const entries=await new Promise(resolve=>{const q=db.transaction('meta').objectStore('meta').getAll();q.onsuccess=()=>resolve(q.result)});db.close();const result=[];for(const x of entries.filter(x=>x.resource?.name?.startsWith('large-'))){const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',x.bytes)),n=>n.toString(16).padStart(2,'0')).join('');result.push({name:x.resource.name,hash,declared:x.resource.hash,length:x.bytes.length,phase:x.phase})}return result})()`,true);assert.deepEqual(again,restoredFiles);assert.equal(await serverHead(),head);await snapshot(instance,'repeat-imported.png')
 }
 assert.equal(await instance.evaluate(`(()=>{const p=document.querySelector('.semantic-recovery-panel'),b=[...p.querySelectorAll('button')].find(x=>x.textContent.trim()==='关闭');if(!b)return false;b.click();return true})()`),true)
 await waitFor(async()=>(await body(instance)).includes('待处理节点文件'),'pending files');await click(instance,'待处理节点文件')
 const jobAction=async(name,label)=>instance.evaluate(`(()=>{const job=[...document.querySelectorAll('.word-upload-job')].find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(name)}),b=[...(job?.querySelectorAll('button')||[])].find(x=>x.textContent.trim()===${JSON.stringify(label)}&&!x.disabled);if(!b)return false;b.click();return true})()`)
 for(let i=1;i<=2;i++){
  const name=`large-${i}.bin`;await waitFor(()=>jobAction(name,'核对并继续'),`resume ${name}`,30000)
  await waitFor(async()=>await instance.evaluate(`([...document.querySelectorAll('.word-upload-job')].find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(name)})?.innerText||'').includes('已归档，待确认关联')`),`archived ${name}`,120000)
  assert.equal(await jobAction(name,'查看并处理属性'),true);await waitFor(()=>jobAction(name,'关联到此节点'),`attach ${name}`,30000)
  await waitFor(async()=>!(await instance.evaluate(`([...document.querySelectorAll('.word-upload-job')].find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(name)})?.innerText||'')`)),`attached ${name}`,120000)
 }
 await click(instance,'保存');await waitFor(async()=>await serverHead()>head,'saved document',120000);const saved=await serverHead()
 for(const item of archive.pendingFiles.filter(x=>x.resource.name.startsWith('large-'))){const response=await fetch(`${base}/assets/${item.resource.hash}?revision=${saved}`,{headers});assert.equal(response.status,200);const payload=Buffer.from(await response.arrayBuffer());assert.equal(payload.length,6*1024*1024);assert.equal((await import('node:crypto')).createHash('sha256').update(payload).digest('hex'),item.resource.hash)}
 await snapshot(instance,'saved.png');await killBrowser(instance);instance=null;instance=await start()
 await waitFor(async()=>await instance.evaluate(`(()=>{const node=document.querySelector('[data-hcd-inline-container]')?.pmViewDesc?.node?.attrs?.extension;return !!node&&['large-1.bin','large-2.bin'].every(name=>node.resources?.some(item=>item.name===name))})()`),'reopened resources',30000)
 assert.equal(await instance.evaluate(`(()=>{const button=document.querySelector('[data-hcd-inline-container] .hcd-inline-container-label');if(!button)return false;button.click();return true})()`),true);await snapshot(instance,'reopened.png')
 const result={scope:'isolated local service and headless Chrome',attachmentBytes:12*1024*1024,packetBytes:bytes.length,exportMs,exportLongTasks,comparisonMs:perf.comparisonMs,comparisonLongTasks:perf.longTasks,originalRevision:head,savedRevision:saved,restoredPendingFiles:restored,repeatedImportPreservedTasks:restored,attachmentBytesReadBack:true,reopenedNodeReferences:true};await writeFile(join(out,'browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}catch(error){if(instance){await snapshot(instance,'failed.png');console.error('Failure screen:',(await body(instance)).slice(0,1500))}throw error}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
