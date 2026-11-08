/** Verify a peer-created grid cell in an owned synthetic workbook and Chrome profile. */
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
const crash=process.argv[4]==='crash'
const lost=process.argv[4]==='lost'
const keyboard=process.argv[4]==='keyboard'
const stalePeer=process.argv[4]==='stale-peer'
const peer=process.argv[4]==='peer'||stalePeer
const revoked=process.argv[4]==='revoked'
if(!rootArg||!outArg)throw Error('usage: node hcd-workbook-blank-live-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
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
 instance=await start();await waitFor(async()=>(await body(instance)).includes('检查工作簿保护'),'workbook load');await sleep(800)
 const c=instance.call,s=instance.sessionId,expected=keyboard?'A真实空格输入😀':'真实空格输入😀'
 for(const type of ['mousePressed','mouseReleased'])await c('Input.dispatchMouseEvent',{type,x:390,y:205,button:'left',clickCount:1},s)
 await waitFor(async()=>{try{return (await readFile(join(root,'requests.ndjson'),'utf8')).includes('/grid/cells/inspect')}catch{return false}},'blank source inspection',30000);await sleep(1000)
 if(keyboard){await c('Input.dispatchKeyEvent',{type:'keyDown',key:'A',code:'KeyA',text:'A',unmodifiedText:'a',windowsVirtualKeyCode:65},s);await c('Input.dispatchKeyEvent',{type:'keyUp',key:'A',code:'KeyA',windowsVirtualKeyCode:65},s);await sleep(200);await c('Input.insertText',{text:'真实空格输入😀'},s)}
 else{for(const [type,clickCount]of [['mousePressed',1],['mouseReleased',1],['mousePressed',2],['mouseReleased',2]])await c('Input.dispatchMouseEvent',{type,x:390,y:205,button:'left',clickCount},s);await sleep(300);await c('Input.insertText',{text:expected},s)}
 const inspect=`(async()=>{for(const item of await indexedDB.databases()){if(!item.name)continue;const db=await new Promise((resolve,reject)=>{const req=indexedDB.open(item.name);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});if(!db.objectStoreNames.contains('branches')){db.close();continue}const records=await new Promise((resolve,reject)=>{const tx=db.transaction('branches','readonly'),r=tx.objectStore('branches').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});db.close();if(records.some(v=>v.state?.blankInput?.cell?.text===${JSON.stringify(expected)}))return true}return false})()`
 await waitFor(()=>instance.evaluate(inspect,true),'durable blank input',30000);await snapshot(instance,'typing.png');assert.equal(await serverHead(),0)
 if(peer){
  const manifest=await (await fetch(base,{headers})).json(),page=await (await fetch(base+'/index/0',{headers})).json(),grid=page.chunks.find(item=>item.grid?.kind==='cells').grid
  const payload={documentId:'book',patchId:'peer-blank-race',baseRevision:0,sourceSha256:manifest.source.sha256,actor:{},cells:[{sheetId:grid.sheetId,sheetPart:'xl/worksheets/sheet1.xml',row:3,column:2,text:'Peer saved'}]}
  const response=await fetch(base+'/grid/cells',{method:'POST',headers:{Authorization:`Bearer ${config.tokens.bob}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(response.status,200);const created=await response.json()
  await waitFor(async()=>(await body(instance)).includes('r1'),'peer revision seen',30000)
  await c('Input.insertText',{text:'继续输入'},s);await sleep(500)
  await c('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},s);await c('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},s)
  await waitFor(async()=>{const text=await body(instance);return text.includes('保存空白格输入')&&text.includes(expected+'继续输入')},'local blank retained',30000)
  await click(instance,'保存空白格输入');await waitFor(async()=>{const text=await body(instance);return text.includes('Peer saved')&&text.includes('保留我的内容')},'peer comparison',30000)
  const node=await (await fetch(base+'/text/'+created.dirtyNodeIds[0],{headers})).json();assert.equal(node.text,'Peer saved');assert.equal(await serverHead(),1)
  assert.ok((await body(instance)).includes(expected+'继续输入'));await snapshot(instance,'peer-conflict.png')
  if(stalePeer){
   const edit={schemaVersion:'hcd-patch/3',documentId:'book',patchId:'peer-newer',baseRevision:1,actor:{},metadata:{},operations:[{op:'text.splice',nodeId:node.nodeId,start:0,deleteCount:Array.from(node.text).length,insertText:'Peer newer',precondition:{nodeHash:node.nodeHash}}]}
   const response=await fetch(base+'/edits',{method:'POST',headers:{Authorization:`Bearer ${config.tokens.bob}`,'Content-Type':'application/json'},body:JSON.stringify(edit)});assert.equal(response.status,200);assert.equal((await response.json()).revision,2)
   await click(instance,'保留我的内容')
   await waitFor(async()=>{const text=await body(instance);return text.includes('检查存在冲突的单元格')&&text.includes('Peer newer')&&text.includes(expected+'继续输入')},'newer peer conflict',30000)
   assert.equal(await serverHead(),2);assert.equal((await(await fetch(base+'/text/'+node.nodeId,{headers})).json()).text,'Peer newer')
   await snapshot(instance,'peer-newer-conflict.png');await click(instance,'保留我的内容');await waitFor(async()=>await serverHead()===3,'confirmed newer conflict save',30000)
   const final=await(await fetch(base+'/text/'+node.nodeId,{headers})).json();assert.equal(final.text,expected+'继续输入')
   const exported=await fetch(base+'/export/xlsx?revision=3&source=true',{headers});assert.equal(exported.status,200);await writeFile(join(out,'peer-newer-resolved.xlsx'),Buffer.from(await exported.arrayBuffer()))
   execFileSync('python3',['-c',`import sys,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 root=E.fromstring(z.read('xl/worksheets/sheet1.xml'));ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'};cells={c.attrib['r']:c for c in root.findall('.//s:c',ns)}
 assert ''.join(t.text or '' for t in cells['B3'].findall('.//s:t',ns))==sys.argv[2]
 assert cells['C1'].findtext('s:f',namespaces=ns)=='1+2'`,join(out,'peer-newer-resolved.xlsx'),final.text])
   console.log(JSON.stringify({newerPeerRetained:true,localDraftRetained:true,conflictRevision:2,resolvedRevision:3,sourceReadback:true}))
  }else{
  await click(instance,'保留我的内容');await waitFor(async()=>await serverHead()===2,'local choice saved',30000)
  const updated=await (await fetch(base+'/text/'+created.dirtyNodeIds[0],{headers})).json();assert.equal(updated.text,expected+'继续输入')
  const exported=await fetch(base+'/export/xlsx?revision=2&source=true',{headers});assert.equal(exported.status,200);await writeFile(join(out,'peer-resolved.xlsx'),Buffer.from(await exported.arrayBuffer()))
  execFileSync('python3',['-c',`import sys,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 root=E.fromstring(z.read('xl/worksheets/sheet1.xml'));ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'};cells={c.attrib['r']:c for c in root.findall('.//s:c',ns)}
 assert ''.join(t.text or '' for t in cells['B3'].findall('.//s:t',ns))==sys.argv[2]
 assert cells['C1'].findtext('s:f',namespaces=ns)=='1+2'`,join(out,'peer-resolved.xlsx'),updated.text])
  await snapshot(instance,'peer-resolved.png');console.log(JSON.stringify({peerWon:true,localInputRetained:true,peerText:node.text,resolvedRevision:2,localText:updated.text}))
  }
 }else if(revoked){
  await fetch(`http://127.0.0.1:${config.ports[1]}/__fixture/control?user=alice&mode=revoked`,{method:'POST'})
  await waitFor(async()=>{const text=await body(instance);return text.includes(expected)&&text.includes('保存空白格输入')},'revoked input retained',30000)
  assert.equal(await serverHead(),0);assert.equal(await instance.evaluate(`([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存空白格输入')||{}).disabled`),true)
  await snapshot(instance,'revoked.png');await fetch(`http://127.0.0.1:${config.ports[1]}/__fixture/control?user=alice&mode=online`,{method:'POST'})
  await killBrowser(instance);instance=null;instance=await start()
  await waitFor(async()=>{const text=await body(instance);return text.includes('发现本机草稿')&&text.includes(expected)},'reauthenticated recovery review',30000)
  await snapshot(instance,'reauth-review.png');await click(instance,'恢复选中草稿并继续');await waitFor(async()=>await serverHead()===1,'restored permission save',30000)
 }else if(crash){
  await killBrowser(instance);instance=null;instance=await start()
  await waitFor(async()=>{const text=await body(instance);return text.includes('发现本机草稿')&&text.includes(expected)},'crash recovery review',30000)
  await snapshot(instance,'crash-review.png');await click(instance,'恢复选中草稿并继续')
  await waitFor(async()=>await serverHead()===1,'recovered blank save',30000)
  await waitFor(async()=>(await body(instance)).includes('检查工作簿保护'),'editor reopened',30000)
 }else{
 await c('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},s);await c('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},s)
 await waitFor(async()=>(await body(instance)).includes('保存空白格输入'),'blank draft review',30000);await snapshot(instance,'draft.png')
 if(lost)await fetch(`http://127.0.0.1:${config.ports[1]}/__fixture/control?user=alice&mode=grid-lost`,{method:'POST'})
 await click(instance,'保存空白格输入');await waitFor(async()=>await serverHead()===1,'blank save',30000)
 if(lost){
  await waitFor(async()=>(await body(instance)).includes('保存结果尚未确认'),'unknown save retained',30000);await snapshot(instance,'lost-response.png')
  await fetch(`http://127.0.0.1:${config.ports[1]}/__fixture/control?user=alice&mode=online`,{method:'POST'})
  await click(instance,'保存空白格输入')
  await waitFor(async()=>!(await body(instance)).includes('保存空白格输入'),'receipt confirmed',30000)
 }
 }
 if(!peer){
 await waitFor(async()=>(await body(instance)).includes('r1'),'saved revision',30000);await sleep(500);await snapshot(instance,'saved.png')
 const response=await fetch(base+'/export/xlsx?revision=1&source=true',{headers});assert.equal(response.status,200);await writeFile(join(out,'saved.xlsx'),Buffer.from(await response.arrayBuffer()))
 execFileSync('python3',['-c',`import sys,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 root=E.fromstring(z.read('xl/worksheets/sheet1.xml'));ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'};cells={c.attrib['r']:c for c in root.findall('.//s:c',ns)}
 assert ''.join(t.text or '' for t in cells['B3'].findall('.//s:t',ns))==sys.argv[2]
 assert cells['C1'].findtext('s:f',namespaces=ns)=='1+2'`,join(out,'saved.xlsx'),expected])
 const log=(await readFile(join(root,'requests.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
 assert.equal(log.filter(entry=>entry.user==='alice'&&entry.method==='POST'&&entry.path.endsWith('/grid/cells')).length,1)
 if(lost)assert.ok(log.some(entry=>entry.user==='alice'&&entry.path.endsWith('/grid/cells/receipt')))
 console.log(JSON.stringify({actualGridInput:true,keyboardStart:keyboard,durableBeforeSave:true,browserKilledDuringInput:crash,permissionRevokedDuringInput:revoked,lostResponse:lost,revision:1,sourceReadback:true,formulaPreserved:true}))
 }
}catch(error){if(instance){await snapshot(instance,'failed.png');console.error((await body(instance)).slice(0,1200));console.error(JSON.stringify(await instance.evaluate('window.__blankDebug||[]')))}throw error}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
