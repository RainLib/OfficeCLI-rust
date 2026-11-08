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
 instance=await start();await waitFor(async()=>(await body(instance)).includes('检查工作簿保护'),'workbook load');await sleep(700)
 const get=async(path,options={})=>{const response=await fetch(base+path,{...options,headers:{...headers,...options.headers}});assert.equal(response.status,200);return response.json()}
 const manifest=await get(''),page=await get('/index/0'),grid=page.chunks.find(item=>item.grid?.kind==='cells').grid
 const request={expectedRevision:0,sourceSha256:manifest.source.sha256,cells:[{sheetId:grid.sheetId,row:3,column:2}]}
 const observed=await get('/grid/cells/inspect',{method:'POST',headers:{Authorization:`Bearer ${config.tokens.alice}`,'Content-Type':'application/json'},body:JSON.stringify(request)})
 const cell={...observed.cells[0],text:'恢复创建😀'},attempt={documentId:'book',patchId:'grid-browser-recovery',baseRevision:0,sourceSha256:manifest.source.sha256,cells:[{sheetId:cell.sheetId,sheetPart:cell.sheetPart,sheetName:cell.sheetName,row:cell.row,column:cell.column,text:cell.text,nodeId:cell.nodeId}]}
 const wire={...attempt,actor:{},cells:attempt.cells.map(({nodeId,sheetName,...item})=>item)}
 await get('/grid/cells',{method:'POST',headers:{Authorization:`Bearer ${config.tokens.alice}`,'Content-Type':'application/json'},body:JSON.stringify(wire)})
 const session={documentId:'book',userId:'alice',token:config.tokens.alice,apiUrl:'/v1/documents',scope:'write',format:'xlsx'}
 const seed=`(async()=>{const m=await import('/src/fixedDraftJournal.ts');const s=${JSON.stringify(session)};const name=await m.fixedDraftDatabase(s,'alice',${JSON.stringify(manifest.source.sha256)},location.href);const j=await m.FixedDraftJournal.open(name);await j.write({version:5,texts:[],images:[],attempt:null,blankAttempt:${JSON.stringify(attempt)}});await j.flush();j.close();return true})()`
 assert.equal(await instance.evaluate(seed,true),true)
 await instance.call('Page.reload',{},instance.sessionId)
 await waitFor(async()=>{const text=await body(instance);return text.includes('发现本机草稿')&&text.includes('恢复创建😀')&&text.includes('恢复时会核对原请求')},'pending recovery review',30000)
 await snapshot(instance,'recovery-review.png')
 await click(instance,'恢复选中草稿并继续')
 await waitFor(async()=>{const text=await body(instance);return text.includes('检查工作簿保护')&&text.includes('r1')},'recovery complete',30000)
 assert.equal(await serverHead(),1);await snapshot(instance,'recovered.png')
 const node=await get('/text/'+cell.nodeId);assert.equal(node.text,cell.text)
 console.log(JSON.stringify({pendingRecovered:true,receiptRevision:1,noDuplicateRevision:true,sourceText:node.text}))
}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
