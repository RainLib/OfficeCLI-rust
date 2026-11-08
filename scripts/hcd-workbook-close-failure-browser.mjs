/** Local synthetic workbook only. Runs a dedicated Chrome process group with
 * its own temporary profile; the user's existing browser is never touched. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
if(!rootArg||!outArg)throw Error('usage: node hcd-workbook-close-failure-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
const root=resolve(rootArg),out=resolve(outArg),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
if(config.root!==root||!root.includes('/target/hcd-preview-runtime/hcd-workbook-')||!/^http:\/\/127\.0\.0\.1:\d+\/alice\.html$/.test(config.pages.alice))throw Error('not an owned workbook fixture')
const pagePath=join(root,'editor','alice.html'),html=await readFile(pagePath,'utf8')
if(!html.includes('React.createElement(EmbeddedHcdEditor,Object.assign({onClose:()=>{window.__fixtureClosed=true}},')){
 if(!html.includes('React.createElement(EmbeddedHcdEditor,')||!html.includes('));\nfor(const [id,mode]'))throw Error('unexpected fixture page')
 await writeFile(pagePath,html.replace('React.createElement(EmbeddedHcdEditor,','React.createElement(EmbeddedHcdEditor,Object.assign({onClose:()=>{window.__fixtureClosed=true}},').replace('));\nfor(const [id,mode]', ')));\nfor(const [id,mode]'))
}
await mkdir(out,{recursive:true})
const profile=await mkdtemp(join(tmpdir(),'hcd-crash-browser-')),expected='崩溃未确认😀',url=config.pages.alice,base=`http://127.0.0.1:${config.ports[0]}/v1/documents/book`,headers={Authorization:`Bearer ${config.tokens.reader}`}
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
const click=async(browser,label)=>{const ok=await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled);if(!b)return false;b.click();return true})()`);assert.equal(ok,true,`missing button ${label}`)}
try{
 instance=await start();await waitFor(async()=>{const text=await body(instance);return text.includes('检查工作簿保护')&&text.includes('已连接')},'workbook load');await sleep(800)
 assert.equal(await serverHead(),0)
 assert.equal((await body(instance)).includes('本机备份不可用'),false)
 await instance.evaluate(`window.__originalCloseTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(stores,...args){if(stores==='branches'&&args[0]==='readwrite')throw new DOMException('injected close failure','InvalidStateError');return window.__originalCloseTransaction.call(this,stores,...args)}`)
 await click(instance,'关闭')
 await waitFor(async()=>(await body(instance)).includes('本机备份不可用'),'backup failure warning')
 assert.ok((await body(instance)).includes('继续编辑，本机备份暂不可用'))
 assert.equal(await instance.evaluate('window.__fixtureClosed===true'),false);assert.equal(await serverHead(),0)
 await snapshot(instance,'blocked-close.png')
 await instance.evaluate('IDBDatabase.prototype.transaction=window.__originalCloseTransaction')
 await click(instance,'重试');await waitFor(async()=>!(await body(instance)).includes('本机备份不可用'),'backup retry success')
 await click(instance,'关闭');await waitFor(()=>instance.evaluate('window.__fixtureClosed===true'),'close after backup retry')
 assert.equal(await serverHead(),0)
 await writeFile(join(out,'browser.json'),JSON.stringify({scope:'isolated synthetic workbook and dedicated headless Chrome; injected IndexedDB transaction failure',flushFailurePreventedClose:true,warningVisible:true,continueWithoutBackupOffered:true,backupRetrySucceeded:true,retryClosed:true,revision:0},null,2)+'\n')
 console.log(JSON.stringify({flushFailurePreventedClose:true,warningVisible:true,continueWithoutBackupOffered:true,backupRetrySucceeded:true,retryClosed:true,revision:0}))
}catch(error){if(instance){await snapshot(instance,'failed.png');console.error((await body(instance)).slice(0,1200))}throw error}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
