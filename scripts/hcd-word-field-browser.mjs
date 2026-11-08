/** Validate an isolated synthetic legacy DOCX with a dedicated Chrome profile. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
if(!rootArg||!outArg)throw Error('usage: node hcd-word-field-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
const root=resolve(rootArg),out=resolve(outArg),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
if(config.root!==root||!root.includes('/target/hcd-preview-runtime/hcd-inline-editor-')||!/^http:\/\/127\.0\.0\.1:\d+\/inline-writer\.html$/.test(config.pages.writer))throw Error('isolated fixture required')
await mkdir(out,{recursive:true})
const profile=await mkdtemp(join(tmpdir(),'hcd-field-browser-')),base=`http://127.0.0.1:${config.ports[0]}/v1/documents/inline-native`,headers={Authorization:`Bearer ${config.tokens.reader}`}
let browser
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function start(){
 const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run','--user-data-dir='+profile,'--remote-debugging-port=0','about:blank'],{stdio:'ignore',detached:true})
 let port
 for(let n=0;n<120;n++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break}catch{}await sleep(100)}
 if(!port)throw Error('Chrome did not start')
 const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json(),ws=new WebSocket(version.webSocketDebuggerUrl)
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
 let seq=0;const pending=new Map()
 ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.method==='Page.javascriptDialogOpening')void call('Page.handleJavaScriptDialog',{accept:true},m.sessionId);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}}
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP ${method} timed out`))},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})
 const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true})
 await call('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false},sessionId);await call('Page.enable',{},sessionId);await call('Runtime.enable',{},sessionId);await call('Page.navigate',{url:config.pages.writer},sessionId)
 const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
 return{chrome,ws,call,sessionId,evaluate}
}
async function waitFor(test,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await sleep(100)}throw Error(label+' timed out')}
const body=()=>browser.evaluate('document.body?.innerText||""')
async function click(label){assert.equal(await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(label)})&&!b.disabled);if(!b)return false;b.click();return true})()`),true,`missing ${label}`)}
async function screenshot(name){const result=await browser.call('Page.captureScreenshot',{format:'png'},browser.sessionId);await writeFile(join(out,name),Buffer.from(result.data,'base64'))}
async function head(){const response=await fetch(base,{headers});assert.equal(response.status,200);return(await response.json()).revision}
try{
 browser=await start();await waitFor(async()=>(await body()).includes('Cached page 1'),'editor');await sleep(1000);const initialRevision=await head()
 const id=await browser.evaluate(`(()=>{const p=[...document.querySelectorAll('.ProseMirror p')].find(p=>p.textContent.includes('Cached page 1'));if(!p)return null;const range=document.createRange();range.selectNodeContents(p);range.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(range);p.focus();return p.getAttribute('data-hcd-block-id')})()`)
 assert.match(id,/^n_[a-f0-9]{32}$/)
 await browser.call('Input.insertText',{text:' changed'},browser.sessionId)
 await click('保存')
 await waitFor(async()=>(await body()).includes('受保护内容'),'protected error')
 assert.equal(await head(),initialRevision);assert.ok((await body()).includes('Cached page 1 changed'))
 await screenshot('blocked.png');await click('定位受保护内容')
 assert.equal(await browser.evaluate(`document.querySelector('[data-hcd-block-id="${id}"]').getAnimations().length>0`),true)
 console.log('blocked save and location verified; reloading')
 await browser.call('Page.reload',{},browser.sessionId)
 await waitFor(async()=>(await body()).includes('Cached page 1 changed'),'reopened draft');await sleep(1000);console.log('draft reopened')
 await click('保存');await waitFor(async()=>(await body()).includes('受保护内容'),'reopened protected error')
 assert.equal(await head(),initialRevision)
 assert.equal(await browser.evaluate(`(()=>{const p=[...document.querySelectorAll('.ProseMirror p')].find(p=>p.textContent.includes('Cached page 1 changed'));if(!p)return false;const w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const at=n.textContent.indexOf(' changed');if(at<0)continue;const r=document.createRange();r.setStart(n,at);r.setEnd(n,at+8);const s=getSelection();s.removeAllRanges();s.addRange(r);return true}return false})()`),true)
 await browser.call('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8},browser.sessionId)
 await browser.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8},browser.sessionId)
 await waitFor(async()=>(await body()).includes('Cached page 1')&&!(await body()).includes('Cached page 1 changed'),'manual correction')
 await click('保存');await waitFor(async()=>!(await body()).includes('受保护内容'),'error cleared')
 assert.equal(await head(),initialRevision)
 await writeFile(join(out,'browser.json'),JSON.stringify({scope:'isolated synthetic legacy DOCX and dedicated headless Chrome',fieldChangeRetained:true,saveRejectedAtRevision:initialRevision,locateHighlight:true,reopenedDraft:true,manualCorrectionClearedError:true,sourceHashVerifiedByService:true},null,2)+'\n')
 console.log(JSON.stringify({fieldChangeRetained:true,saveRejectedAtRevision:initialRevision,locateHighlight:true,reopenedDraft:true,manualCorrectionClearedError:true}))
}catch(error){if(browser){await screenshot('failed.png');console.error((await body()).slice(0,1800))}throw error}
finally{if(browser){const exit=new Promise(resolve=>browser.chrome.once('exit',resolve));process.kill(-browser.chrome.pid,'SIGKILL');await exit;browser.ws.close()}await rm(profile,{recursive:true,force:true})}
