/** Validate restoring a missing source with an isolated Chrome profile. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg,sourceArg]=process.argv.slice(2)
if(!rootArg||!outArg||!sourceArg)throw Error('usage: node hcd-word-source-browser.mjs FIXTURE_ROOT OUTPUT_DIR ORIGINAL_DOCX')
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
 return{chrome,ws,call,sessionId,targetId,evaluate}
}
async function waitFor(test,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await sleep(100)}throw Error(label+' timed out')}
const body=()=>browser.evaluate('document.body?.innerText||""')
async function click(label){assert.equal(await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(label)})&&!b.disabled);if(!b)return false;b.click();return true})()`),true,`missing ${label}`)}
async function screenshot(name){const result=await browser.call('Page.captureScreenshot',{format:'png'},browser.sessionId);await writeFile(join(out,name),Buffer.from(result.data,'base64'))}
async function head(){const response=await fetch(base,{headers});assert.equal(response.status,200);return(await response.json()).revision}
try{
 browser=await start();await waitFor(async()=>(await body()).includes('原始 Word 文件不可用'),'missing original warning');const initialRevision=await head();await screenshot('missing.png')
 const peerTarget=await browser.call('Target.createTarget',{url:'about:blank'}),peer=await browser.call('Target.attachToTarget',{targetId:peerTarget.targetId,flatten:true})
 await browser.call('Page.enable',{},peer.sessionId);await browser.call('Runtime.enable',{},peer.sessionId);await browser.call('Page.navigate',{url:config.pages.peer},peer.sessionId)
 const peerBody=async()=>{const result=await browser.call('Runtime.evaluate',{expression:'document.body?.innerText||""',returnByValue:true},peer.sessionId);return result.result.value}
 await waitFor(async()=>(await peerBody()).includes('原始 Word 文件不可用'),'peer warning')
 const prepared=await browser.call('Runtime.evaluate',{expression:`(()=>{const p=[...document.querySelectorAll('.ProseMirror p')].find(p=>p.textContent.includes('Neighbor paragraph'));if(!p)return false;const r=document.createRange();r.selectNodeContents(p);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);p.focus();return true})()`,returnByValue:true},peer.sessionId)
 assert.equal(prepared.result.value,true);await browser.call('Input.insertText',{text:' peer draft'},peer.sessionId)
 await waitFor(async()=>(await body()).includes('Neighbor paragraph peer draft'),'peer draft synced')
 await browser.call('Target.activateTarget',{targetId:browser.targetId});await click('保存');await waitFor(async()=>(await body()).includes('需要原始 Word 文件才能核验受保护内容'),'missing source save blocked');assert.equal(await head(),initialRevision);assert.ok((await body()).includes('Neighbor paragraph peer draft'));await screenshot('save-blocked.png')
 await browser.evaluate(`(()=>{const c=new BroadcastChannel('hcd-word-source/1');c.postMessage({documentId:'inline-native',apiUrl:'/v1/documents'});c.close()})()`);await sleep(500)
 assert.ok((await peerBody()).includes('原始 Word 文件不可用'),'notification alone must not authorize a source')
 await browser.call('Target.activateTarget',{targetId:browser.targetId})
 await writeFile(join(root,'wrong-test.docx'),'wrong file')
 await browser.call('DOM.enable',{},browser.sessionId)
 async function upload(path){const {root}=await browser.call('DOM.getDocument',{},browser.sessionId);const {nodeId}=await browser.call('DOM.querySelector',{nodeId:root.nodeId,selector:'.hcd-word-source-warning input[type=file]'},browser.sessionId);assert.ok(nodeId);await browser.call('DOM.setFileInputFiles',{nodeId,files:[resolve(path)]},browser.sessionId)}
 await upload(join(root,'wrong-test.docx'));await waitFor(async()=>(await body()).includes('所选文件与导入时的原文件不一致'),'wrong original')
 assert.equal(await head(),initialRevision)
 await upload(sourceArg);await waitFor(async()=>!(await body()).includes('原始 Word 文件不可用'),'source restored')
 await waitFor(async()=>!(await peerBody()).includes('原始 Word 文件不可用'),'peer refreshed after source restore')
 assert.ok((await peerBody()).includes('Neighbor paragraph peer draft'));assert.ok((await body()).includes('Neighbor paragraph peer draft'))
 assert.equal(await head(),initialRevision)
 await click('保存');await waitFor(async()=>await head()===initialRevision+1,'saved after source restore');assert.ok((await body()).includes('Neighbor paragraph peer draft'))
 await rm(join(root,'sources','inline-native.docx'));await browser.evaluate("window.dispatchEvent(new Event('focus'))");await waitFor(async()=>(await body()).includes('本机保护证明目前允许兼容的修改'),'source-free proof notice');await screenshot('source-free.png')
 assert.equal(await browser.evaluate(`(()=>{const p=[...document.querySelectorAll('.ProseMirror p')].find(p=>p.textContent.includes('Normal paragraph'));if(!p)return false;const range=document.createRange();range.selectNodeContents(p);range.collapse(false);const selected=getSelection();selected.removeAllRanges();selected.addRange(range);p.focus();return true})()`),true)
 await browser.call('Input.insertText',{text:' unsourced draft'},browser.sessionId);await click('保存');await waitFor(async()=>await head()===initialRevision+2,'saved with local proof');const savedRevision=await head()

 const id=await browser.evaluate(`(()=>{const p=[...document.querySelectorAll('.ProseMirror p')].find(p=>p.textContent.includes('Cached page 1'));if(!p)return null;const range=document.createRange();range.selectNodeContents(p);range.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(range);p.focus();return p.getAttribute('data-hcd-block-id')})()`)
 assert.match(id,/^n_[a-f0-9]{32}$/)
 await browser.call('Input.insertText',{text:' changed'},browser.sessionId)
 await waitFor(()=>browser.evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('保存')&&!b.disabled)`),'save available',30000);await click('保存')
 await waitFor(async()=>(await body()).includes('受保护内容'),'protected error')
 assert.equal(await head(),savedRevision);assert.ok((await body()).includes('Cached page 1 changed'))
 await screenshot('blocked.png');await click('定位受保护内容')
 assert.equal(await browser.evaluate(`document.querySelector('[data-hcd-block-id="${id}"]').getAnimations().length>0`),true)
 await writeFile(join(out,'browser.json'),JSON.stringify({scope:'isolated synthetic legacy DOCX and two tabs in dedicated headless Chrome',missingWarning:true,wrongSourceRejected:true,matchingSourceRestored:true,missingSourceSaveBlocked:true,savedAfterRestore:true,sourceFreeProofSaved:true,peerRechecked:true,peerDraftRetained:true,unverifiedNoticeIgnored:true,protectedEditRejected:true,fieldChangeRetained:true,revision:savedRevision},null,2)+'\n')
 console.log(JSON.stringify({missingWarning:true,wrongSourceRejected:true,matchingSourceRestored:true,missingSourceSaveBlocked:true,savedAfterRestore:true,sourceFreeProofSaved:true,peerRechecked:true,peerDraftRetained:true,unverifiedNoticeIgnored:true,protectedEditRejected:true,revision:savedRevision}))
}catch(error){if(browser){await screenshot('failed.png');console.error((await body()).slice(0,1800))}throw error}
finally{if(browser){const exit=new Promise(resolve=>browser.chrome.once('exit',resolve));process.kill(-browser.chrome.pid,'SIGKILL');await exit;browser.ws.close()}await rm(profile,{recursive:true,force:true})}
