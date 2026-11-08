/** Verify a peer-created grid cell in an owned synthetic workbook and Chrome profile. */
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
const lost=process.argv[4]==='lost'
const occupied=process.argv[4]==='occupied'
if(!rootArg||!outArg)throw Error('usage: node hcd-workbook-blank-input-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
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
 const cell={...observed.cells[0],text:'未完成输入😀'},input={documentId:'book',baseRevision:0,sourceSha256:manifest.source.sha256,cell:{sheetId:cell.sheetId,sheetPart:cell.sheetPart,sheetName:cell.sheetName,row:cell.row,column:cell.column,text:cell.text,nodeId:cell.nodeId}}
 const session={documentId:'book',userId:'alice',token:config.tokens.alice,apiUrl:'/v1/documents',scope:'write',format:'xlsx'}
 const seed=`(async()=>{const m=await import('/src/fixedDraftJournal.ts');const s=${JSON.stringify(session)};const name=await m.fixedDraftDatabase(s,'alice',${JSON.stringify(manifest.source.sha256)},location.href);const j=await m.FixedDraftJournal.open(name);await j.write({version:6,texts:[],images:[],attempt:null,blankInput:${JSON.stringify(input)}});await j.flush();j.close();return true})()`
 assert.equal(await instance.evaluate(seed,true),true);await instance.call('Page.reload',{},instance.sessionId)
 await waitFor(async()=>{const text=await body(instance);return text.includes('发现本机草稿')&&text.includes('未完成输入😀')&&text.includes('如果位置已被占用')},'unfinished input review',30000)
 assert.equal(await instance.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='恢复选中草稿并继续')?.disabled"),false)
 assert.equal(await serverHead(),0);await snapshot(instance,'unfinished-review.png')
 if(occupied){
  const peer={documentId:'book',patchId:'peer-created',baseRevision:0,sourceSha256:manifest.source.sha256,actor:{},cells:[{sheetId:cell.sheetId,sheetPart:cell.sheetPart,row:cell.row,column:cell.column,text:'Peer value'}]}
  await get('/grid/cells',{method:'POST',headers:{Authorization:`Bearer ${config.tokens.bob}`,'Content-Type':'application/json'},body:JSON.stringify(peer)})
  await click(instance,'恢复选中草稿并继续')
  await waitFor(async()=>(await body(instance)).includes('当前协作内容 · r1'),'changed head review')
  await waitFor(async()=>{const text=await body(instance);return text.includes('未完成输入😀')&&text.includes('Peer value')&&text.includes('该单元格已有其他内容')},'occupied draft retained')
  assert.equal(await instance.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='恢复选中草稿并继续')?.disabled"),true)
  const peerNode=await get('/text/'+cell.nodeId);assert.equal(peerNode.text,'Peer value');assert.equal(await serverHead(),1)
  await snapshot(instance,'occupied-conflict.png')
  console.log(JSON.stringify({occupiedConflict:true,draftRetained:true,peerText:peerNode.text,headRevision:1}));process.exitCode=0
 } else {
 if(lost)await fetch(`http://127.0.0.1:${config.ports[1]}/__fixture/control?user=alice&mode=grid-lost`,{method:'POST'})
 await click(instance,'恢复选中草稿并继续')
 await waitFor(async()=>await serverHead()===1,'recovered save',30000)
 if(lost){
  await waitFor(async()=>{const text=await body(instance);return text.includes('待核对的原保存请求')&&text.includes('未完成输入😀')},'unknown request retained',30000)
  await snapshot(instance,'unknown-receipt.png')
  await fetch(`http://127.0.0.1:${config.ports[1]}/__fixture/control?user=alice&mode=online`,{method:'POST'})
  await click(instance,'恢复选中草稿并继续')
 }
 await waitFor(async()=>(await body(instance)).includes('检查工作簿保护'),'editor reopened',30000)
 const saved=await get('/text/'+cell.nodeId);assert.equal(saved.text,cell.text)
 const exported=await fetch(base+'/export/xlsx?revision=1&source=true',{headers});assert.equal(exported.status,200)
 await writeFile(join(out,'recovered.xlsx'),Buffer.from(await exported.arrayBuffer()))
 execFileSync('python3',['-c',`import sys,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 root=E.fromstring(z.read('xl/worksheets/sheet1.xml'));ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
 cells={c.attrib['r']:c for c in root.findall('.//s:c',ns)}
 assert ''.join(t.text or '' for t in cells['B3'].findall('.//s:t',ns))==sys.argv[2]
 assert cells['C1'].findtext('s:f',namespaces=ns)=='1+2'`,join(out,'recovered.xlsx'),cell.text])
 await snapshot(instance,'recovered.png')
 const log=(await readFile(join(root,'requests.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
 const writes=log.filter(entry=>entry.user==='alice'&&entry.method==='POST'&&entry.path.endsWith('/grid/cells'))
 assert.equal(writes.length,1)
 if(lost)assert.ok(log.some(entry=>entry.user==='alice'&&entry.path.endsWith('/grid/cells/receipt')))
 console.log(JSON.stringify({unfinishedInputDisplayed:true,lostResponse:lost,restoredRevision:1,createRequests:writes.length,textReadback:saved.text,formulaPreserved:true}))
 }
}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
