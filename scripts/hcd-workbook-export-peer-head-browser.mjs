/** Local synthetic workbook only. Runs a dedicated Chrome process group with
 * its own temporary profile; the user's existing browser is never touched. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir,readdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
if(!rootArg||!outArg)throw Error('usage: node hcd-workbook-browser-crash.mjs FIXTURE_ROOT OUTPUT_DIR')
const root=resolve(rootArg),out=resolve(outArg),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
if(config.root!==root||!root.includes('/target/hcd-preview-runtime/hcd-workbook-')||!/^http:\/\/127\.0\.0\.1:\d+\/alice\.html$/.test(config.pages.alice))throw Error('not an owned workbook fixture')
await mkdir(out,{recursive:true})
const profile=await mkdtemp(join(tmpdir(),'hcd-export-browser-')),expected='Bob latest😀',url=config.pages.alice,base=`http://127.0.0.1:${config.ports[0]}/v1/documents/book`,headers={Authorization:`Bearer ${config.tokens.reader}`}
let instance,heldExport=null,holdOnce=true
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
 ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.method==='Fetch.requestPaused'){if(holdOnce&&message.params.request.url.includes('/export/xlsx')){holdOnce=false;heldExport=message.params.requestId}else void call('Fetch.continueRequest',{requestId:message.params.requestId},message.sessionId)}if(message.id&&pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);message.error?reject(Error(message.error.message)):resolve(message.result)}}
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})
 const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true})
 await call('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false},sessionId);await call('Page.enable',{},sessionId);await call('Runtime.enable',{},sessionId)
 await call('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const d=Object.getOwnPropertyDescriptor(WebSocket.prototype,'onmessage');window.__dropRevision=false;window.__revisionSockets=[];Object.defineProperty(WebSocket.prototype,'onmessage',{configurable:true,enumerable:d.enumerable,get:d.get,set(fn){if(this.url.includes('/events/ws')&&typeof fn==='function'){window.__revisionSockets.push(this);d.set.call(this,e=>{if(!window.__dropRevision)fn.call(this,e)})}else d.set.call(this,fn)}})})()`},sessionId)
 await call('Page.navigate',{url},sessionId)
 const evaluate=async(expression,awaitPromise=false)=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise},sessionId);if(result.exceptionDetails)throw Error('browser evaluation failed');return result.result.value}
 return{chrome,ws,call,sessionId,targetId,evaluate}
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
 await instance.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:out})
 await instance.call('Fetch.enable',{patterns:[{urlPattern:'*/export/xlsx*',requestStage:'Response'}]},instance.sessionId)
 await click(instance,'导出');await waitFor(async()=>!!heldExport,'export response held',30000)
 const c=instance.call,s=instance.sessionId
 await instance.evaluate('window.__dropRevision=true')
 const {targetId}=await c('Target.createTarget',{url:'about:blank'}),peer=await c('Target.attachToTarget',{targetId,flatten:true})
 await c('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false},peer.sessionId);await c('Page.enable',{},peer.sessionId);await c('Runtime.enable',{},peer.sessionId);await c('Page.navigate',{url:config.pages.bob},peer.sessionId)
 const peerEval=async(expression)=>{const result=await c('Runtime.evaluate',{expression,returnByValue:true},peer.sessionId);if(result.exceptionDetails)throw Error('peer evaluation failed');return result.result.value}
 await waitFor(async()=>(await peerEval('document.body?.innerText||""')).includes('检查工作簿保护'),'peer load');await sleep(800)
 for(const [type,clickCount]of [['mousePressed',1],['mouseReleased',1],['mousePressed',2],['mouseReleased',2]])await c('Input.dispatchMouseEvent',{type,x:390,y:167,button:'left',clickCount},peer.sessionId)
 await c('Input.insertText',{text:expected},peer.sessionId);await c('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},peer.sessionId);await c('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},peer.sessionId)
 await waitFor(async()=>await serverHead()===1,'peer save',30000)
 assert.ok((await body(instance)).includes('r0'),'revision notification must be delayed')
 await c('Target.activateTarget',{targetId:instance.targetId});await c('Fetch.continueRequest',{requestId:heldExport},s)
 await waitFor(async()=>(await body(instance)).includes('导出期间工作簿发生变化'),'stale export warning');await snapshot(instance,'blocked-export.png')
 assert.equal((await readdir(out)).some(name=>name.endsWith('.xlsx')),false);assert.equal(await serverHead(),1)
 await instance.evaluate('window.__dropRevision=false;window.__revisionSockets.forEach(socket=>socket.close())')
 await waitFor(async()=>(await body(instance)).includes('r1'),'revision reconnect',30000)
 await waitFor(async()=>await instance.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='导出'&&!b.disabled)"),'export ready')
 const control=mode=>fetch(`http://127.0.0.1:${config.ports[1]}/__fixture/control?user=alice&mode=${mode}`,{method:'POST'})
 await control('head-offline');await click(instance,'导出')
 await waitFor(async()=>(await readFile(join(root,'requests.ndjson'),'utf8')).trim().split('\n').some(line=>{const row=JSON.parse(line);return row.mode==='head-offline'&&row.path?.endsWith('/head')}),'head outage observed')
 await waitFor(async()=>(await body(instance)).includes('导出期间工作簿发生变化'),'head outage warning')
 assert.equal((await readdir(out)).some(name=>name.endsWith('.xlsx')),false)
 await control('online')
 await waitFor(async()=>await instance.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='导出'&&!b.disabled)"),'export retry ready')
 await click(instance,'导出');await waitFor(async()=>(await readdir(out)).some(name=>name.endsWith('.xlsx')),'new export download',30000)
 const downloaded=(await readdir(out)).find(name=>name.endsWith('.xlsx'))
 await writeFile(join(out,'browser.json'),JSON.stringify({scope:'isolated synthetic workbook, two headless tabs; delayed Alice revision events, held export response and head outage',peerSavedRevision:1,aliceStillObservedRevision:0,staleDownloadBlocked:true,headOutageBlocked:true,downloaded},null,2)+'\n')
 console.log(JSON.stringify({peerSavedRevision:1,aliceStillObservedRevision:0,staleDownloadBlocked:true,headOutageBlocked:true,downloaded}))
}catch(error){if(instance){await snapshot(instance,'failed.png');console.error((await body(instance)).slice(0,1200))}throw error}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
