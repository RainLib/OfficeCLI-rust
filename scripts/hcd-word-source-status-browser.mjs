/** Isolated browser check for the stopped Word checkpoint recovery panel. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:net'

const token='local-test-only',port=1
const key=`.hcd-stale-${randomUUID()}`,html=`${key}.html`,entry=`${key}.tsx`,profile=await mkdtemp(join(tmpdir(),'hcd-stale-browser-'))
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const webPort=probe.address().port;await new Promise(resolve=>probe.close(resolve))
let vite,chrome,ws
try{
 await writeFile(html,`<!doctype html><html><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`,{flag:'wx'})
 const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {I18nProvider} from './src/i18n.tsx';import {WordSourceRecovery} from './src/WordSourceRecovery.tsx';const session={documentId:'doc',token:'local-test-only',userId:'alice',scope:'write',format:'docx'} as const;let proof=true,held=false,release,present=false;const original=fetch;window.fetch=(...args)=>String(args[0]).endsWith('/word/source')?(args[1]?.method==='POST'?new Promise(resolve=>{window.finishUpload=()=>{present=true;resolve(Response.json({sourceRestored:true,revision:1,alreadyPresent:false}))}}):held?new Promise(resolve=>{release=()=>resolve(Response.json({status:'missing',sourceFreeProtected:true}))}):Promise.resolve(Response.json({status:present?'present':'missing',sourceFreeProtected:proof}))):original(...args);function App(){const [revision,setRevision]=useState(0);window.advance=(value)=>{proof=value;setRevision(n=>n+1)};window.hold=()=>{held=true};window.release=()=>{held=false;release?.()};return <I18nProvider initialLocale="zh-CN"><WordSourceRecovery session={session} canWrite={true} revision={revision}/></I18nProvider>}createRoot(document.getElementById('root')!).render(<App/>);`

 await writeFile(entry,source,{flag:'wx',mode:0o600});vite=spawn('./node_modules/.bin/vite',['--host','127.0.0.1','--port',String(webPort),'--strictPort'],{stdio:'ignore'})
 let ready=false;for(let i=0;i<500&&!ready;i++){if(vite.exitCode!==null)throw Error('vite exited');try{ready=(await fetch(`http://127.0.0.1:${webPort}/${html}`)).ok}catch{}if(!ready)await wait(100)}if(!ready)throw Error('vite timeout')
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:'ignore',detached:true})
 let debugPort;for(let i=0;i<300;i++){try{debugPort=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];if((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok)break}catch{}await wait(100)}if(!debugPort)throw Error('chrome timeout')
 const version=await(await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
 let sequence=0,dropped=false;const pending=new Map();ws.onmessage=event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(m.method==='Fetch.requestPaused'){const q=m.params;if(process.env.HCD_TEST_STALE_UI_REBASE_LOST==='1'&&!dropped&&q.request.method==='POST'&&q.request.postData?.includes('"operation":"rebase-stale"')&&q.responseStatusCode===200){dropped=true;void call('Fetch.failRequest',{requestId:q.requestId,errorReason:'ConnectionReset'},m.sessionId)}else void call('Fetch.continueRequest',{requestId:q.requestId},m.sessionId)}if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}}
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('browser command timeout'))},30000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})
 const downloads=join(profile,'downloads');await mkdir(downloads);await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads})
 const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});await call('Emulation.setDeviceMetricsOverride',{width:1008,height:900,deviceScaleFactor:1,mobile:false},sessionId);await call('Page.enable',{},sessionId);await call('Runtime.enable',{},sessionId);await call('Page.navigate',{url:`http://127.0.0.1:${webPort}/${html}`},sessionId)
 const evaluate=async(expression)=>{const value=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(value.exceptionDetails)throw Error('browser evaluation failed');return value.result.value}
 const until=async(fn,label)=>{for(let i=0;i<400;i++){if(await fn())return;await wait(100)}throw Error(`${label} timeout`)},body=()=>evaluate('document.body?.innerText||""')
 const click=async(label)=>until(()=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes(${JSON.stringify(label)})&&!e.disabled);if(!b)return false;b.click();return true})()`),label)
 await until(async()=>(await body()).includes('本机保护证明目前允许兼容的修改'),'initial proof')
 await evaluate('window.advance(false)');await until(async()=>{const text=await body();return text.includes('旧文档的受保护内容无法核验')&&!text.includes('本机保护证明目前允许兼容的修改')},'revision invalidates proof')
 await evaluate('window.hold();window.advance(true)');await until(async()=>(await body()).includes('正在检查'),'held check');assert.equal((await body()).includes('本机保护证明目前允许兼容的修改'),false)
 await evaluate('window.advance(false)');await evaluate('new Promise(resolve=>setTimeout(resolve,100))');await evaluate('window.release()');await until(async()=>{const text=await body();return text.includes('旧文档的受保护内容无法核验')&&!text.includes('正在检查')&&!text.includes('本机保护证明目前允许兼容的修改')},'stale result discarded')
 await evaluate('window.advance(true)');await until(async()=>(await body()).includes('本机保护证明目前允许兼容的修改'),'renewed proof')
 const filePath=join(profile,'original.docx');await writeFile(filePath,'controlled original bytes');const {root:dom}=await call('DOM.getDocument',{},sessionId),{nodeId}=await call('DOM.querySelector',{nodeId:dom.nodeId,selector:'input[type=file]'},sessionId);assert.ok(nodeId);await call('DOM.setFileInputFiles',{nodeId,files:[filePath]},sessionId)
 await until(async()=>(await body()).includes('停止等待'),'upload pending');await click('停止等待');await until(async()=>(await body()).includes('无法确认是否恢复成功'),'unknown upload result');assert.equal((await body()).includes('停止等待'),false)
 await evaluate('window.finishUpload()');await evaluate('new Promise(resolve=>setTimeout(resolve,100))');assert.ok((await body()).includes('检查恢复状态'));await click('检查恢复状态');await until(async()=>!(await body()).includes('检查恢复状态'),'explicit source readback')
 console.log(JSON.stringify({scope:'isolated React component with controlled source-status responses in Chrome',revisionRefresh:true,checkingHidesProof:true,lateOldResultRejected:true,renewedProofVisible:true,uploadWaitStopped:true,lateUploadDoesNotHidePanel:true,explicitReadback:true}))

}finally{
 if(ws)ws.close();if(chrome?.pid){const exit=new Promise(resolve=>{if(chrome.exitCode!==null||chrome.signalCode!==null)resolve();else chrome.once('exit',resolve)});try{process.kill(-chrome.pid,'SIGKILL')}catch{}await exit}
 if(vite){const exit=new Promise(resolve=>{if(vite.exitCode!==null||vite.signalCode!==null)resolve();else vite.once('exit',resolve)});vite.kill('SIGTERM');await exit}
 await rm(html,{force:true});await rm(entry,{force:true});await rm(profile,{recursive:true,force:true})
}
