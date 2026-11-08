/** Local synthetic workbook only. Runs a dedicated Chrome process group with
 * its own temporary profile; the user's existing browser is never touched. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
if(!rootArg||!outArg)throw Error('usage: node hcd-workbook-browser-crash.mjs FIXTURE_ROOT OUTPUT_DIR')
const root=resolve(rootArg),out=resolve(outArg),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
if(config.root!==root||!root.includes('/target/hcd-preview-runtime/hcd-workbook-')||!/^http:\/\/127\.0\.0\.1:\d+\/alice\.html$/.test(config.pages.alice))throw Error('not an owned workbook fixture')
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
 instance=await start();await waitFor(async()=>{const text=await body(instance);return text.includes('工作簿预览')&&text.includes('已连接')},'workbook load');await sleep(800)
 assert.equal(await serverHead(),0)
 const c=instance.call,s=instance.sessionId
 for(const [type,clickCount]of [['mousePressed',1],['mouseReleased',1],['mousePressed',2],['mouseReleased',2]])await c('Input.dispatchMouseEvent',{type,x:390,y:205,button:'left',clickCount},s)
 await sleep(300);await c('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',modifiers:4,windowsVirtualKeyCode:65},s);await c('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:4,windowsVirtualKeyCode:65},s);await c('Input.insertText',{text:expected},s)
 const inspect=`(async()=>{for(const item of await indexedDB.databases()){if(!item.name)continue;const db=await new Promise((resolve,reject)=>{const req=indexedDB.open(item.name);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});if(!db.objectStoreNames.contains('branches')){db.close();continue}const records=await new Promise((resolve,reject)=>{const tx=db.transaction('branches','readonly'),r=tx.objectStore('branches').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});db.close();if(records.some(v=>v.state?.workbookBuffer?.text===${JSON.stringify(expected)}&&v.state.workbookBuffer.base.text==='Original Bob'))return true}return false})()`
 await waitFor(()=>instance.evaluate(inspect,true),'durable input buffer');assert.equal(await serverHead(),0);await snapshot(instance,'editing.png')
 await killBrowser(instance);instance=null
 instance=await start();try{await waitFor(async()=>{const text=await body(instance);return text.includes('发现本机草稿')&&text.includes(expected)&&text.includes('Original Bob')},'crash recovery review')}catch(error){await snapshot(instance,'recovery-failed.png');console.error('Recovery screen:',(await body(instance)).slice(0,1000));throw error}
 assert.equal(await serverHead(),0);await snapshot(instance,'recovery-review.png')
 // Confirming the comparison converts the buffer directly into a text draft;
 // the ordinary autosave path then commits it.
 await click(instance,'恢复选中草稿并继续')
 await waitFor(async()=>await serverHead()===1,'restored save',30000);await waitFor(async()=>(await body(instance)).includes('r1 · 已保存'),'saved state',30000);await snapshot(instance,'saved.png')
 for(const [route,name]of [['/export/xlsx?revision=1&source=true','restored.xlsx'],['/export/hcdz?revision=1','restored.hcdz']]){const response=await fetch(base+route,{headers});assert.equal(response.status,200);await writeFile(join(out,name),Buffer.from(await response.arrayBuffer()))}
 await writeFile(join(out,'browser.json'),JSON.stringify({scope:'owned local workbook and separate headless Chrome profile',browserProcess:'SIGKILL',bufferPersistedBeforeKill:true,headBeforeAndAfterCrash:0,recoveryComparedOriginal:true,restoredRevision:1,xlsxDownloaded:true,hcdzDownloaded:true,imeAndPowerLoss:'not tested'},null,2)+'\n')
 console.log(JSON.stringify({browserProcess:'SIGKILL',bufferPersistedBeforeKill:true,restoredRevision:1}))
}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
