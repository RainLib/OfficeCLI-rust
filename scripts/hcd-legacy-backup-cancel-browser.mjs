/** Local proof response-loss validation. Runs a dedicated Chrome process group with
 * its own temporary profile; the user's existing browser is never touched. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
if(!rootArg||!outArg)throw Error('usage: node hcd-legacy-backup-cancel-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
const root=resolve(rootArg),out=resolve(outArg),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
if(config.root!==root||!root.includes('/target/hcd-preview-runtime/hcd-inline-editor-')||!/^http:\/\/127\.0\.0\.1:\d+\/inline-writer\.html$/.test(config.pages.writer))throw Error('not an owned workbook fixture')
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
 instance=await start();await waitFor(async()=>{const text=await body(instance);return text.includes('修订')&&text.includes('导出')},'editor load',30000);await sleep(1000)
 const lockName=await instance.evaluate("(async()=>{const n=(await indexedDB.databases()).map(x=>x.name).find(x=>x&&x.endsWith('-nodefiles1'));return n?n+'-file-boundary-v1':null})()",true);assert.ok(lockName)
 await click(instance,'修订');await waitFor(async()=>(await body(instance)).includes('草稿恢复副本'),'recovery control');await click(instance,'草稿恢复副本');await waitFor(async()=>(await body(instance)).includes('其他草稿备份'),'recovery panel')
 await instance.evaluate("[...document.querySelectorAll('summary')].find(x=>x.textContent.trim()==='其他草稿备份').click()")
 assert.equal(await instance.evaluate(`(()=>{const original=IDBObjectStore.prototype.getAllKeys;window.__hcdStalled=0;IDBObjectStore.prototype.getAllKeys=function(...args){if(this.name==='meta'&&!window.__hcdStalled){window.__hcdStalled=1;return {}}return original.apply(this,args)};const b=[...document.querySelectorAll('.semantic-recovery-panel button')].find(b=>b.textContent.trim()==='下载草稿备份');if(!b)return false;b.click();return true})()`),true)
 await waitFor(async()=>await instance.evaluate("window.__hcdStalled===1"),'stalled read')
 await waitFor(async()=>await instance.evaluate(`navigator.locks.query().then(s=>s.held.some(x=>x.name===${JSON.stringify(lockName)}))`,true),'held device lock')
 assert.equal(await instance.evaluate(`(()=>{const panel=document.querySelector('.semantic-recovery-panel');const b=[...panel.querySelectorAll('button')].find(x=>x.textContent.trim()==='关闭');if(!b)return false;b.click();return true})()`),true)
 await waitFor(async()=>await instance.evaluate(`navigator.locks.request(${JSON.stringify(lockName)},{ifAvailable:true},lock=>!!lock)`,true),'released lock',5000)
 assert.equal(await instance.evaluate("!!document.querySelector('.semantic-recovery-panel')"),false);await snapshot(instance,'closed.png')
 await writeFile(join(out,'browser.json'),JSON.stringify({scope:'isolated synthetic DOCX and dedicated headless Chrome',stalledIndexedDbRead:true,lockHeldBeforeClose:true,lockReleasedAfterClose:true},null,2)+'\n')
 console.log(JSON.stringify({stalledRead:true,lockReleasedAfterClose:true}))
}catch(error){if(instance){await snapshot(instance,'failed.png');console.error('Failure screen:',(await body(instance)).slice(0,1200))}throw error}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
