/** Isolated browser verification of cancellation and retry during recovery comparison. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
if(!rootArg||!outArg)throw Error('usage: node hcd-recovery-comparison-cancel-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
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
 instance=await start();await instance.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:out},undefined)
 await waitFor(async()=>{const text=await body(instance);return text.includes('修订')&&text.includes('导出')},'editor load',30000);await sleep(1000)
 assert.equal(await instance.evaluate(`(async()=>{const name=(await indexedDB.databases()).map(x=>x.name).find(x=>x&&x.endsWith('-nodefiles1'));const db=await new Promise(resolve=>{const q=indexedDB.open(name);q.onsuccess=()=>resolve(q.result)});const id='00000000-0000-4000-8000-000000000001',bytes=new TextEncoder().encode('pending attachment during comparison');const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');const file={version:1,id,regionId:'body',phase:'chosen',expected:{schemaVersion:'hcd.extension/2',instanceId:'x_'+ 'a'.repeat(32),type:'example.file',version:1,display:'inline',data:{},fallback:{text:'file'}},resource:{key:'file',hash,byteLength:bytes.length,name:'pending.txt',mediaType:'text/plain'},bytes};await new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put(file,'node-resource:'+id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();return true})()`,true),true)
 const head=await serverHead();await click(instance,'修订');await waitFor(async()=>(await body(instance)).includes('草稿恢复副本'),'recovery control');await click(instance,'草稿恢复副本')
 await waitFor(async()=>await instance.evaluate("!!document.querySelector('.recovery-archive-panel')"),'portable panel',30000);await click(instance,'导出恢复包')
 const packet=join(out,'inline-native.hcd-recovery');await waitFor(async()=>{try{return (await readFile(packet)).length>0}catch{return false}},'portable download',30000)
 const original=await readFile(packet),archive=JSON.parse(original.toString()),file=archive.pendingFiles.find(item=>item.resource.name==='pending.txt'),asset=archive.resources.find(item=>item.sha256===file?.resource.hash);assert.ok(file&&asset);assert.equal(Buffer.from(asset.base64,'base64').toString(),'pending attachment during comparison');await waitFor(async()=>(await body(instance)).includes('恢复包已导出'),'export complete')
 assert.equal(await instance.evaluate(`(()=>{const original=crypto.subtle.digest.bind(crypto.subtle);window.__hcdDigest={original,calls:0,release:null};crypto.subtle.digest=(...args)=>{window.__hcdDigest.calls++;if(window.__hcdDigest.calls===1)return new Promise(resolve=>window.__hcdDigest.release=()=>original(...args).then(resolve));return original(...args)};return true})()`),true)
 const {root:dom}=await instance.call('DOM.getDocument',{},instance.sessionId),{nodeId}=await instance.call('DOM.querySelector',{nodeId:dom.nodeId,selector:'.recovery-archive-panel input[type=file]'},instance.sessionId);assert.ok(nodeId)
 await instance.call('DOM.setFileInputFiles',{nodeId,files:[packet]},instance.sessionId)
 await waitFor(async()=>await instance.evaluate('window.__hcdDigest.calls===1 && !!window.__hcdDigest.release'),'stalled comparison digest',30000)
 await waitFor(async()=>(await body(instance)).includes('正在核对文档和资源字节'),'comparison busy')
 assert.equal(await instance.evaluate(`(()=>{const panel=document.querySelector('.recovery-archive-panel'),b=[...panel.querySelectorAll('button')].find(x=>x.textContent.trim()==='取消');if(!b)return false;b.click();return true})()`),true)
 await waitFor(async()=>(await body(instance)).includes('重新比较')&&!(await body(instance)).includes('正在核对文档和资源字节'),'cancelled comparison',5000)
 await instance.evaluate(`(()=>{window.__hcdDigest.release();crypto.subtle.digest=window.__hcdDigest.original})()`);await sleep(300)
 assert.equal(await serverHead(),head);assert.deepEqual(await readFile(packet),original);assert.equal(await instance.evaluate(`(async()=>{const name=(await indexedDB.databases()).map(x=>x.name).find(x=>x&&x.endsWith('-nodefiles1'));const db=await new Promise(resolve=>{const q=indexedDB.open(name);q.onsuccess=()=>resolve(q.result)});const value=await new Promise(resolve=>{const r=db.transaction('meta').objectStore('meta').get('node-resource:00000000-0000-4000-8000-000000000001');r.onsuccess=()=>resolve(r.result)});db.close();return new TextDecoder().decode(value.bytes)})()`,true),'pending attachment during comparison');await snapshot(instance,'cancelled.png')
 await click(instance,'重新比较');await waitFor(async()=>{const text=await body(instance);return text.includes('保存基线 r')&&text.includes('pending.txt')},'comparison retried with attachment',30000)
 assert.equal(await serverHead(),head);await snapshot(instance,'retried.png');await writeFile(join(out,'browser.json'),JSON.stringify({scope:'isolated local service and headless Chrome',stalledComparisonHash:true,cancelled:true,retryCompared:true,serverRevisionUnchanged:true,recoveryFileUnchanged:true,pendingAttachmentBytesRetained:true},null,2)+'\n')
 console.log(JSON.stringify({cancelled:true,retryCompared:true,revision:head,recoveryFileUnchanged:true}))
}catch(error){if(instance){await snapshot(instance,'failed.png');console.error('Failure screen:',(await body(instance)).slice(0,1600))}throw error}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
