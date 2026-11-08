/** Verify a peer-created grid cell in an owned synthetic workbook and Chrome profile. */
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
if(!rootArg||!outArg)throw Error('usage: node hcd-workbook-blank-recovery-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
const root=resolve(rootArg),out=resolve(outArg),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
if(config.root!==root||!root.includes('/target/hcd-preview-runtime/hcd-workbook-')||!/^http:\/\/127\.0\.0\.1:\d+\/alice\.html$/.test(config.pages.alice))throw Error('not an owned workbook fixture')
await mkdir(out,{recursive:true})
const profile=await mkdtemp(join(tmpdir(),'hcd-created-cell-browser-')),expected='浏览器修改😀',url=config.pages.alice,base=`http://127.0.0.1:${config.ports[0]}/v1/documents/book`,headers={Authorization:`Bearer ${config.tokens.reader}`}
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
 instance=await start();await waitFor(async()=>(await body(instance)).includes('检查工作簿保护'),'workbook load',30000);await sleep(700)
 const get=async(path,options={})=>{const response=await fetch(base+path,{...options,headers:{...headers,...options.headers}});assert.equal(response.status,200);return response.json()}
 const manifest=await get(''),page=await get('/index/0'),grid=page.chunks.find(item=>item.grid?.kind==='cells').grid
 const observed=await get('/grid/cells/inspect',{method:'POST',headers:{Authorization:`Bearer ${config.tokens.alice}`,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:0,sourceSha256:manifest.source.sha256,cells:[{sheetId:grid.sheetId,row:3,column:2}]})})
 const selected=observed.cells[0],cell={sheetId:selected.sheetId,sheetPart:selected.sheetPart,sheetName:selected.sheetName,row:selected.row,column:selected.column,nodeId:selected.nodeId,text:'恢复原请求😀'},blankInput={documentId:'book',baseRevision:0,sourceSha256:manifest.source.sha256,cell},attempt={documentId:'book',patchId:'grid-pending-original',baseRevision:0,sourceSha256:manifest.source.sha256,cells:[cell]},session={documentId:'book',userId:'alice',token:config.tokens.alice,apiUrl:'/v1/documents',scope:'write',format:'xlsx'}
 const ids=await instance.evaluate(`(async()=>{const m=await import('/src/fixedDraftJournal.ts');const s=${JSON.stringify(session)},name=await m.fixedDraftDatabase(s,'alice',${JSON.stringify(manifest.source.sha256)},location.href),old=await m.FixedDraftJournal.open(name),newer=await m.FixedDraftJournal.open(name),blankInput=${JSON.stringify(blankInput)},blankAttempt=${JSON.stringify(attempt)};await old.write({version:6,texts:[],images:[],attempt:null,blankInput});await new Promise(r=>setTimeout(r,30));await newer.write({version:6,texts:[],images:[],attempt:null,blankInput,blankAttempt});const result={old:old.branch,newer:newer.branch};old.close();newer.close();return result})()`,true)
 await instance.call('Page.reload',{},instance.sessionId);await waitFor(async()=>{const t=await body(instance);return t.includes('发现本机草稿')&&t.includes('恢复原请求😀')},'review loaded',30000)
 assert.equal(await instance.evaluate(`(()=>{const select=document.querySelector('select[aria-label="本机备份"]');if(!select)return false;select.value=${JSON.stringify(ids.old)};select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`),true)
 await waitFor(()=>instance.evaluate(`document.querySelector('select[aria-label="本机备份"]')?.value===${JSON.stringify(ids.old)}`),'old selected',30000)
 await click(instance,'恢复选中草稿并继续');await waitFor(()=>instance.evaluate(`document.querySelector('select[aria-label="本机备份"]')?.value===${JSON.stringify(ids.newer)}`),'pending copy selected',30000);assert.equal(await serverHead(),0);await snapshot(instance,'pending-review.png')
 await waitFor(()=>instance.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='恢复选中草稿并继续'&&!b.disabled)"),'pending ready',30000);await click(instance,'恢复选中草稿并继续');await waitFor(async()=>await serverHead()===1,'original request committed',30000)
 const log=(await readFile(join(root,'requests.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(log.filter(e=>e.user==='alice'&&e.method==='POST'&&e.path.endsWith('/grid/cells')).length,1);assert.equal(log.filter(e=>e.user==='alice'&&e.method==='POST'&&e.path.endsWith('/grid/cells/receipt')).length,1)
 const node=await get('/text/'+cell.nodeId),revision=await get('/revisions/1');assert.equal(node.text,cell.text);assert.equal(revision.patchId,attempt.patchId)
 const result={scope:'owned synthetic workbook and browser, injected old and unresolved branches',olderCopyRedirected:true,originalRequestResolved:true,revision:1,gridCreates:1,receipts:1,textReadback:true};await writeFile(join(out,'browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}catch(error){if(instance){await snapshot(instance,'failed.png');console.error('screen:',(await body(instance)).slice(0,2000))}throw error}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
