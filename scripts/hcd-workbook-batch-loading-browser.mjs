/** Local synthetic workbook only. Runs a dedicated Chrome process group with
 * its own temporary profile; the user's existing browser is never touched. */
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [rootArg,outArg]=process.argv.slice(2)
if(!rootArg||!outArg)throw Error('usage: node hcd-workbook-batch-loading-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
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
 return{chrome,ws,call,sessionId,targetId,evaluate}
}
async function waitFor(test,label,timeout=20000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await test())return;await sleep(100)}throw Error(label+' timed out')}
async function killBrowser(browser){const exit=new Promise(resolve=>browser.chrome.once('exit',(code,signal)=>resolve({code,signal})));process.kill(-browser.chrome.pid,'SIGKILL');const result=await exit;browser.ws.close();assert.equal(result.signal,'SIGKILL');await sleep(300)}
async function snapshot(browser,name){const data=await browser.call('Page.captureScreenshot',{format:'png'},browser.sessionId);await writeFile(join(out,name),Buffer.from(data.data,'base64'))}
async function serverHead(){const response=await fetch(base,{headers});assert.equal(response.status,200);return(await response.json()).revision}
const body=browser=>browser.evaluate('document.body?.innerText||""')
const click=async(browser,label)=>{const ok=await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled);if(!b)return false;b.click();return true})()`);assert.equal(ok,true,`missing button ${label}`)}
try{
 await fetch(`http://127.0.0.1:${config.ports[1]}/__fixture/control?user=alice&mode=online`,{method:'POST'})
 instance=await start();await waitFor(async()=>{const t=await body(instance);return t.includes('检查工作簿保护')&&t.includes('已连接')},'workbook load',30000);await sleep(800)
 const c=instance.call,s=instance.sessionId;await c('Target.activateTarget',{targetId:instance.targetId});await instance.evaluate('window.focus()')
 await c('Browser.grantPermissions',{origin:new URL(url).origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']})
 await instance.evaluate("navigator.clipboard.writeText('真实粘贴甲\\t真实粘贴乙')",true)
 for(const type of ['mousePressed','mouseReleased'])await c('Input.dispatchMouseEvent',{type,x:390,y:229,button:'left',clickCount:1},s)
 await instance.evaluate("window.__testPaste=[];document.addEventListener('paste',e=>window.__testPaste.push({trusted:e.isTrusted,text:e.clipboardData?.getData('text/plain')}),true)")
 await c('Input.dispatchKeyEvent',{type:'keyDown',key:'v',code:'KeyV',modifiers:4,windowsVirtualKeyCode:86,commands:['paste']},s);await c('Input.dispatchKeyEvent',{type:'keyUp',key:'v',code:'KeyV',modifiers:4,windowsVirtualKeyCode:86},s)
 await waitFor(async()=>{const t=await body(instance);return t.includes('真实粘贴甲')&&t.includes('真实粘贴乙')},'captured paste',30000)
 const events=await instance.evaluate('window.__testPaste');assert.equal(events.length,1);assert.equal(events[0].trusted,true);assert.equal(events[0].text,'真实粘贴甲\t真实粘贴乙');assert.equal(await serverHead(),0);await snapshot(instance,'captured.png')
 await waitFor(async()=>!(await body(instance)).includes('这组内容目前只保存在内存中'),'batch durable',30000);await killBrowser(instance);instance=null
 const logStart=(await readFile(join(root,'requests.ndjson'),'utf8')).length
 await fetch(`http://127.0.0.1:${config.ports[1]}/__fixture/control?user=alice&mode=chunks-delay`,{method:'POST'});instance=await start()
 await waitFor(async()=>{try{return (await readFile(join(root,'requests.ndjson'),'utf8')).slice(logStart).includes('"delayChunk":true')}catch{return false}},'delayed grid request',30000)
 const status=()=>instance.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='保存整组');return b?{disabled:b.disabled,text:document.body.innerText}:null})()`)
 await waitFor(async()=>{const value=await status();return !!value&&value.text.includes('真实粘贴甲')},'recovered batch shown',30000)
 const pending=await status();assert.equal(pending.disabled,true);assert.equal(await serverHead(),0);await snapshot(instance,'grid-loading.png')
 await waitFor(async()=>{const value=await status();return !!value&&!value.disabled},'batch enabled after grid ready',65000);await snapshot(instance,'grid-ready.png')
 await click(instance,'保存整组');await waitFor(async()=>await serverHead()===1,'batch saved',30000)
 const response=await fetch(base+'/export/xlsx?revision=1&source=true',{headers});assert.equal(response.status,200);await writeFile(join(out,'saved.xlsx'),Buffer.from(await response.arrayBuffer()))
 execFileSync('python3',['-c',`import sys,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 n={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'};root=E.fromstring(z.read('xl/worksheets/sheet1.xml'));cells={c.attrib['r']:c for c in root.findall('.//s:c',n)}
 def text(address):return ''.join(t.text or '' for t in cells[address].findall('.//s:t',n))
 assert text('B3')=='真实粘贴甲' and text('C3')=='真实粘贴乙' and cells['C1'].findtext('s:f',namespaces=n)=='1+2'`,join(out,'saved.xlsx')])
 const result={scope:'isolated workbook and Chrome; proxy delayed first grid chunk by 30 seconds',trustedPaste:true,batchPersisted:true,disabledWhileGridLoading:true,enabledAfterGridReady:true,revision:1,xlsxReadback:true,formulaPreserved:true};await writeFile(join(out,'browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}catch(error){if(instance){await snapshot(instance,'failed.png');console.error('screen:',(await body(instance)).slice(0,2500))}throw error}finally{if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
