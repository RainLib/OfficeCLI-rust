/** Isolated browser check for the stopped Word checkpoint recovery panel. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:net'

const port=Number(process.argv[2]),token=process.env.HCD_TEST_ALICE
if(!Number.isSafeInteger(port)||port<1||!token)throw Error('isolated fixture required')
const key=`.hcd-stale-${randomUUID()}`,html=`${key}.html`,entry=`${key}.tsx`,profile=await mkdtemp(join(tmpdir(),'hcd-stale-browser-'))
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const webPort=probe.address().port;await new Promise(resolve=>probe.close(resolve))
let vite,chrome,ws
try{
 await writeFile(html,`<!doctype html><html><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`,{flag:'wx'})
 const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {I18nProvider} from './src/i18n.tsx';import {WordCheckpointRecovery} from './src/WordCheckpointRecovery.tsx';import {WordCompatibilityProblem} from './src/WordCompatibilityProblem.tsx';const session={documentId:'doc',token:${JSON.stringify(token)},userId:'alice',scope:'write',format:'docx',collabUrl:'ws://127.0.0.1:${port}',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'} as const;createRoot(document.getElementById('root')!).render(<I18nProvider initialLocale="zh-CN">${process.env.HCD_TEST_STALE_UI_REBASE==='1'?'<WordCompatibilityProblem session={session} checkpointSession={session} problem={{code:"HCD-DOC-1026",stage:"collaboration"}}/>':"<WordCheckpointRecovery session={session} expectedCheckpointId={'a'.repeat(32)} onConfirmed={()=>{(window as any).unsafeConfirmed=true}}/>"}</I18nProvider>);`
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
 await click('检查待确认的保存');await until(async()=>(await body()).includes('文档已有更新版本'),'stale confirmation');await click('比较保留的草稿');await until(async()=>{const text=await body();return text.includes('Submitted draft')&&text.includes('Competing newer version')},'both comparison branches')
 const text=await body();assert.match(text,/原版本 → 保留的草稿/);assert.match(text,/原版本 → 当前版本/);assert.match(text,/第 1 节 正文/);assert.match(text,/请比较变化后再处理/);assert.match(text,/这只是初步核对，不会合并或授权保存/);assert.equal(await evaluate('!!window.unsafeConfirmed'),false)
 if(process.env.HCD_TEST_STALE_DISJOINT==='1'){assert.match(text,/当前版本 → 拟合并结果/);assert.match(text,/这是临时预览，文档尚未更改或保存/)}
 assert.match(text,/文字文件不包含格式、图片、域和交互内容/);await click('下载草稿文字');let saved='';await until(async()=>{try{saved=await readFile(join(downloads,'word-recovered-draft.txt'),'utf8');return saved.includes('Submitted draft')}catch{return false}},'draft text download');assert.doesNotMatch(saved,/Competing newer version/);assert.equal(await evaluate('!!window.unsafeConfirmed'),false)
 if(process.env.HCD_TEST_STALE_UI_REBASE==='1'){
  if(process.env.HCD_TEST_STALE_UI_REBASE_LOST==='1')await call('Fetch.enable',{patterns:[{urlPattern:'*/word-stopped-draft',requestStage:'Response'}]},sessionId)
  await click('核对应用到草稿');await until(async()=>(await body()).includes('文档不会立即保存'),'rebase confirmation');await click('应用到草稿')
  if(process.env.HCD_TEST_STALE_UI_REBASE_LOST==='1'){await until(async()=>(await body()).includes('草稿更新结果尚未确认'),'unknown rebase status');assert.equal(dropped,true);await call('Fetch.disable',{},sessionId);await call('Page.reload',{},sessionId);await click('检查待确认的保存')}
  await until(async()=>(await body()).includes('草稿已更新到 r3 的基准，尚未保存'),'rebase status');await until(()=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent==='比较草稿');return !!b&&!b.disabled})()`),'draft review available')
  if(process.env.HCD_TEST_STALE_UI_ADVANCE==='1'){
   const directory=process.env.HCD_TEST_STALE_SIGNAL_DIR;if(!directory)throw Error('signal directory required');await writeFile(join(directory,'browser-rebased'),'ready');await until(async()=>{try{await readFile(join(directory,'head-advanced'));return true}catch{return false}},'later checkpoint');
   await click('检查待确认的保存');await until(async()=>(await body()).includes('文档再次更新'),'second stale status');await click('比较保留的草稿');await until(async()=>{const text=await body();return text.includes('Competing newer version again')&&text.includes('当前版本 → 拟合并结果')},'second comparison');await click('核对应用到草稿');await until(async()=>(await body()).includes('文档不会立即保存'),'second rebase confirmation');await click('应用到草稿');await until(async()=>(await body()).includes('草稿已更新到 r4 的基准，尚未保存'),'second rebase status');await click('比较草稿');await until(async()=>(await body()).includes('核对保存'),'second draft comparison');await click('核对保存');await until(async()=>(await body()).includes('将全部保留的协作更改保存为新的文档版本'),'second save confirmation');await click('保存草稿');await until(async()=>(await body()).includes('草稿已核对，当前版本 r5'),'second saved revision')
  }
  if(process.env.HCD_TEST_STALE_UI_FULL==='1'){await click('比较草稿');await until(async()=>(await body()).includes('核对保存'),'rebased draft comparison');await click('核对保存');await until(async()=>(await body()).includes('将全部保留的协作更改保存为新的文档版本'),'save confirmation');await click('保存草稿');await until(async()=>(await body()).includes('草稿已核对，当前版本 r4'),'saved revision')}
 }
 console.log(JSON.stringify({browserStaleReview:true,oldDraftVisible:true,newHeadVisible:true,confirmationGatePreserved:true,draftTextDownloaded:true}))
}finally{
 if(ws)ws.close();if(chrome?.pid){const exit=new Promise(resolve=>{if(chrome.exitCode!==null||chrome.signalCode!==null)resolve();else chrome.once('exit',resolve)});try{process.kill(-chrome.pid,'SIGKILL')}catch{}await exit}
 if(vite){const exit=new Promise(resolve=>{if(vite.exitCode!==null||vite.signalCode!==null)resolve();else vite.once('exit',resolve)});vite.kill('SIGTERM');await exit}
 await rm(html,{force:true});await rm(entry,{force:true});await rm(profile,{recursive:true,force:true})
}
