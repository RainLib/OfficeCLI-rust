/** Verify a peer-created grid cell in an owned synthetic workbook and Chrome profile. */
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
if(!rootArg||!outArg)throw Error('usage: node hcd-workbook-created-cell-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
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
 instance=await start();await waitFor(async()=>{const text=await body(instance);return text.includes('检查工作簿保护')},'workbook load');await sleep(800)
 const get=async(path,options={})=>{const response=await fetch(base+path,{...options,headers:{...headers,...options.headers}});assert.equal(response.status,200);return response.json()}
 const manifest=await get(''),page=await get('/index/0'),grid=page.chunks.find(item=>item.grid?.kind==='cells').grid
 const attempt={documentId:'book',patchId:'browser-create',baseRevision:0,sourceSha256:manifest.source.sha256,cells:[{sheetId:grid.sheetId,sheetPart:'xl/worksheets/sheet1.xml',row:3,column:2,text:'新格 peer😀'}],actor:{}}
 const created=await get('/grid/cells',{method:'POST',headers:{Authorization:`Bearer ${config.tokens.bob}`,'Content-Type':'application/json'},body:JSON.stringify(attempt)})
 await waitFor(async()=> (await body(instance)).includes('r1'),'peer revision');await sleep(2000);await snapshot(instance,'after-create.png')
 const c=instance.call,s=instance.sessionId
 // Exercise lazy window eviction and reloading before editing the new node.
 await c('Input.dispatchMouseEvent',{type:'mouseWheel',x:700,y:500,deltaX:0,deltaY:6000},s);await sleep(1200)
 await c('Input.dispatchMouseEvent',{type:'mouseWheel',x:700,y:500,deltaX:0,deltaY:-6000},s);await sleep(1200)
 for(const [type,clickCount]of [['mousePressed',1],['mouseReleased',1],['mousePressed',2],['mouseReleased',2]])await c('Input.dispatchMouseEvent',{type,x:390,y:205,button:'left',clickCount},s)
 await sleep(300);await c('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',modifiers:4,windowsVirtualKeyCode:65},s);await c('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:4,windowsVirtualKeyCode:65},s);await c('Input.insertText',{text:expected},s)
 await c('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},s);await c('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},s)
 await waitFor(async()=>await serverHead()===2,'peer edit saved',30000)
 const node=await get('/text/'+created.dirtyNodeIds[0]);assert.equal(node.text,expected)
 const exported=await fetch(base+'/export/xlsx?revision=2&source=true',{headers});assert.equal(exported.status,200)
 await writeFile(join(out,'after-edit.xlsx'),Buffer.from(await exported.arrayBuffer()))
 execFileSync('python3',['-c',`import sys,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 root=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
 ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
 cells={c.attrib['r']:c for c in root.findall('.//s:c',ns)}
 assert ''.join(t.text or '' for t in cells['B3'].findall('.//s:t',ns))==sys.argv[2]
 assert cells['C1'].findtext('s:f',namespaces=ns)=='1+2'`,join(out,'after-edit.xlsx'),expected])
 await snapshot(instance,'after-edit.png')
 console.log(JSON.stringify({peerCreationRevision:1,peerEditRevision:2,textReadback:node.text}))
}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
