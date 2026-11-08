/** Local synthetic workbook only. Runs a dedicated Chrome process group with
 * its own temporary profile; the user's existing browser is never touched. */
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir,readdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
if(!rootArg||!outArg)throw Error('usage: node hcd-workbook-batch-conflict-copy-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
const root=resolve(rootArg),out=resolve(outArg),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
if(config.root!==root||!root.includes('/target/hcd-preview-runtime/hcd-workbook-')||!/^http:\/\/127\.0\.0\.1:\d+\/alice\.html$/.test(config.pages.alice))throw Error('not an owned workbook fixture')
await mkdir(out,{recursive:true})
if((await readdir(out)).length)throw Error('output directory must be empty')
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
 return{chrome,ws,call,sessionId,targetId,evaluate}
}
async function waitFor(test,label,timeout=20000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await test())return;await sleep(100)}throw Error(label+' timed out')}
async function killBrowser(browser){const exit=new Promise(resolve=>browser.chrome.once('exit',(code,signal)=>resolve({code,signal})));process.kill(-browser.chrome.pid,'SIGKILL');const result=await exit;browser.ws.close();assert.equal(result.signal,'SIGKILL');await sleep(300)}
async function snapshot(browser,name){const data=await browser.call('Page.captureScreenshot',{format:'png'},browser.sessionId);await writeFile(join(out,name),Buffer.from(data.data,'base64'))}
async function serverHead(){const response=await fetch(base,{headers});assert.equal(response.status,200);return(await response.json()).revision}
const body=browser=>browser.evaluate('document.body?.innerText||""')
const click=async(browser,label)=>{const ok=await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled);if(!b)return false;b.click();return true})()`);assert.equal(ok,true,`missing button ${label}`)}
async function clickVisible(browser,label){const point=await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled);if(!b)return null;b.scrollIntoView({block:'nearest',inline:'nearest'});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);assert.ok(point,`missing button ${label}`);for(const type of ['mousePressed','mouseReleased'])await browser.call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1},browser.sessionId)}
try{
 const source=join(root,'sources/book.xlsx'),original=await readFile(source),upload=join(out,'original.xlsx');await writeFile(upload,original);await rm(source)
 instance=await start();await waitFor(async()=>(await body(instance)).includes('检查工作簿保护'),'workbook load',30000);await waitFor(()=>instance.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='检查工作簿保护'&&!b.disabled)"),'audit ready',30000);await click(instance,'阻断保存与回执');const c=instance.call,ss=instance.sessionId;for(const [type,clickCount]of [['mousePressed',1],['mouseReleased',1],['mousePressed',2],['mouseReleased',2]])await c('Input.dispatchMouseEvent',{type,x:390,y:205,button:'left',clickCount},ss);await sleep(300);await c('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',modifiers:4,windowsVirtualKeyCode:65},ss);await c('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:4,windowsVirtualKeyCode:65},ss);await c('Input.insertText',{text:'停止恢复后保留草稿😀'},ss);for(const type of ['rawKeyDown','keyUp'])await c('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13},ss);await waitFor(async()=>(await body(instance)).includes('核对保存结果'),'draft pending',30000);await click(instance,'检查工作簿保护');await waitFor(async()=>(await body(instance)).includes('恢复原始工作簿'),'source recovery entry',30000)
 await instance.evaluate(`(()=>{const original=window.fetch;window.__sourcePosts=0;window.fetch=async(...args)=>{if(String(args[0]).endsWith('/xlsx/source')&&args[1]?.method==='POST'){window.__sourcePosts++;const response=await original(...args);return new Promise(resolve=>{window.__releaseSource=()=>resolve(response)})}return original(...args)}})()`)
 const {root:dom}=await instance.call('DOM.getDocument',{},instance.sessionId),{nodeId}=await instance.call('DOM.querySelector',{nodeId:dom.nodeId,selector:'input[accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]'},instance.sessionId);assert.ok(nodeId);await instance.call('DOM.setFileInputFiles',{nodeId,files:[upload]},instance.sessionId)
 await waitFor(()=>instance.evaluate('typeof window.__releaseSource===\'function\''),'server restore finished',30000);assert.deepEqual(await readFile(source),original);await click(instance,'停止等待');await waitFor(async()=>(await body(instance)).includes('无法确认恢复结果'),'unknown restore outcome',30000);await snapshot(instance,'cancelled.png');assert.equal(await serverHead(),0)
 await instance.evaluate('window.__releaseSource()');await sleep(200);assert.ok((await body(instance)).includes('无法确认恢复结果'));assert.equal(await instance.evaluate('window.__sourcePosts'),1)
 await click(instance,'检查工作簿保护');await waitFor(async()=>(await body(instance)).includes('已检查保存版本'),'source checked',30000);assert.equal(await serverHead(),0);assert.equal(await instance.evaluate('window.__sourcePosts'),1);await snapshot(instance,'checked.png')
 await instance.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:out});await click(instance,'下载工作簿合并备份');const backup=join(out,'book.hcd-workbook-backup');await waitFor(async()=>{try{return (await readFile(backup,'utf8')).includes('停止恢复后保留草稿😀')}catch{return false}},'draft backup retained',30000)
 await click(instance,'恢复保存连接');await waitFor(()=>instance.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='核对保存结果'&&!b.disabled)"),'save ready',30000);await click(instance,'核对保存结果');await waitFor(async()=>await serverHead()===1,'draft saved',30000)
 const exported=await fetch(base+'/export/xlsx?revision=1&source=true',{headers});assert.equal(exported.status,200);const savedFile=join(out,'saved.xlsx');await writeFile(savedFile,Buffer.from(await exported.arrayBuffer()));execFileSync('python3',['-c',`import sys,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 n={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'};r=E.fromstring(z.read('xl/worksheets/sheet1.xml'));cells={c.attrib['r']:c for c in r.findall('.//s:c',n)}
 assert ''.join(t.text or '' for t in cells['A1'].findall('.//s:t',n))=='停止恢复后保留草稿😀'
 assert cells['C1'].findtext('s:f',namespaces=n)=='1+2'`,savedFile])
 const result={scope:'owned synthetic workbook and actual local source restore; JavaScript delays the successful response',uploadStopped:true,unknownOutcomePreserved:true,lateSuccessNotApplied:true,sourceReadback:true,sourcePosts:1,draftBackupRetained:true,draftSaved:true,xlsxReadback:true,formulaPreserved:true,revision:1};await writeFile(join(out,'browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
