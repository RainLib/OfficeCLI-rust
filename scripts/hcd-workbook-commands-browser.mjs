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
const pagePath=join(root,'editor','alice.html'),pageSource=await readFile(pagePath,'utf8')
const configuration=`{onReady:service=>{window.__sheetCommands=service},commands:[{id:'host.sheetCollaboration',label:'展开工作簿协作',profiles:['sheet'],access:'read',ready:false,selectionSensitive:false,surfaces:['ribbon','palette'],execute:({commands})=>commands.run('view.collaboration',{enabled:true})}]}`
const instrumented=pageSource.replace(/React.createElement\(EmbeddedHcdEditor,(\{[^\n]*\})\)\);/,(_,props)=>`React.createElement(EmbeddedHcdEditor,{...${props},commandExtensions:${configuration}}));`);assert.notEqual(instrumented,pageSource);await writeFile(pagePath,instrumented)
try{
 instance=await start();await waitFor(()=>instance.evaluate('!!window.__sheetCommands'),'registry ready',30000);await waitFor(()=>instance.evaluate("[...document.querySelectorAll('button')].some(b=>b.dataset.commandId==='file.save'&&!b.disabled)"),'grid ready',30000)
 assert.equal(await instance.evaluate('window.__sheetCommands.context().profile'),'sheet');await click(instance,'展开工作簿协作');await waitFor(()=>instance.evaluate('!!document.querySelector(\'.workbook-collaboration\')'),'custom command opened collaboration');await instance.evaluate("window.__sheetCommands.execute('view.panel.close')",true);await waitFor(()=>instance.evaluate('!document.querySelector(\'.workbook-collaboration\')'),'panel closed')
 await instance.evaluate("document.querySelector('[data-command-id=\"editor.palette\"]').focus()");await instance.call('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'P',code:'KeyP',modifiers:12,windowsVirtualKeyCode:80},instance.sessionId);await instance.call('Input.dispatchKeyEvent',{type:'keyUp',key:'P',code:'KeyP',modifiers:12,windowsVirtualKeyCode:80},instance.sessionId);await waitFor(()=>instance.evaluate('!!document.querySelector(\'.hcd-command-palette\')'),'palette keyboard');assert.ok((await body(instance)).includes('展开工作簿协作'));await snapshot(instance,'palette.png');await instance.call('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},instance.sessionId);await waitFor(()=>instance.evaluate('!document.querySelector(\'.hcd-command-palette\')'),'palette closed')
 await instance.evaluate("window.__sheetCommands.execute('file.export')",true);assert.equal(await instance.evaluate("!!document.activeElement?.closest('.workbook-export-controls')"),true)
 const denied=await instance.evaluate("window.__sheetCommands.execute('text.insert',{text:'unsupported'}).then(()=>false,()=>true)",true);assert.equal(denied,true);assert.equal(await serverHead(),0)
 const result={scope:'owned local workbook and isolated Chrome with custom command configuration',sheetRegistry:true,customRibbon:true,nestedCollaborationCommand:true,paletteKeyboard:true,exportFocus:true,unsupportedTextBlocked:true,revision:0};await writeFile(join(out,'browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{await writeFile(pagePath,pageSource);if(instance)await killBrowser(instance);await rm(profile,{recursive:true,force:true})}
