/** Dedicated Chrome and isolated Word preview; no existing browser state. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdtemp,rm,mkdir,readdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
const [rootArg,outArg]=process.argv.slice(2)
if(!rootArg||!outArg)throw Error('usage: node hcd-word-txt-browser.mjs FIXTURE_ROOT OUTPUT_DIR')
const root=resolve(rootArg),out=resolve(outArg),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
if(config.root!==root||!root.includes('/target/hcd-preview-runtime/word-region-preview-')||!/^http:\/\/127\.0\.0\.1:\d+\/\.hcd-word-region-[a-z0-9_-]+-writer\.html$/.test(config.pages.writer))throw Error('owned Word preview required')
await mkdir(out,{recursive:true});const profile=await mkdtemp(join(tmpdir(),'hcd-word-txt-')),sleep=ms=>new Promise(r=>setTimeout(r,ms));let chrome,ws
try{
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run','--user-data-dir='+profile,'--remote-debugging-port=0','about:blank'],{stdio:'ignore',detached:true})
 let port;for(let i=0;i<120;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break}catch{}await sleep(100)}if(!port)throw Error('Chrome failed')
 const v=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();ws=new WebSocket(v.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let id=0;const pending=new Map()
 ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}}
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}))})
 const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});await call('Page.enable',{},sessionId);await call('Runtime.enable',{},sessionId);await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:out});await call('Page.navigate',{url:config.pages.writer},sessionId)
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error('browser evaluation failed');return r.result.value}
 const waitFor=async(test,label,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await sleep(100)}throw Error(label+' timeout')}
 await waitFor(()=>evaluate("document.body.innerText.includes('导出')"),'editor');assert.equal(await evaluate("(()=>{const b=[...document.querySelectorAll('nav button')].find(x=>x.textContent.trim()==='导出');if(!b)return false;b.click();return true})()"),true)
 await waitFor(()=>evaluate("!!document.querySelector('select[aria-label=\"导出格式\"]')"),'export control');assert.equal(await evaluate("(()=>{const s=document.querySelector('select[aria-label=\"导出格式\"]');if(![...s.options].some(o=>o.value==='txt'))return false;s.value='txt';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()"),true)
 try{await waitFor(()=>evaluate("document.body.innerText.includes('TXT 将各节正文')&&[...document.querySelectorAll('.export-control button')].some(b=>b.textContent.trim()==='导出'&&!b.disabled)"),'TXT preflight',15000)}catch(error){console.error('export state:',await evaluate("JSON.stringify({text:document.querySelector('.export-control')?.parentElement?.innerText,value:document.querySelector('select[aria-label=导出格式]')?.value,buttons:[...document.querySelectorAll('.export-control button')].map(b=>({text:b.textContent,disabled:b.disabled}))})"));throw error}const shot=await call('Page.captureScreenshot',{format:'png'},sessionId);await writeFile(join(out,'export.png'),Buffer.from(shot.data,'base64'))
 if((await readdir(out)).some(name=>/^region-ui-r\d+\.txt$/.test(name)))throw Error('output directory already contains a matching download')
 assert.equal(await evaluate("(()=>{const b=[...document.querySelectorAll('.export-control button')].find(x=>x.textContent.trim()==='导出'&&!x.disabled);if(!b)return false;b.click();return true})()"),true)
 let downloaded;await waitFor(async()=>{const name=(await readdir(out)).find(value=>/^region-ui-r\d+\.txt$/.test(value));if(!name)return false;try{downloaded=join(out,name);return (await readFile(downloaded)).length>0}catch{return false}},'download',60000);const text=await readFile(downloaded,'utf8');assert.match(text,/Section 1/);assert.match(text,/Section 2/);assert.match(text,/Body one/);assert.match(text,/Body two/);assert.match(text,/Header/);assert.match(text,/Footer/);assert.doesNotMatch(text,/asset:\/\//)
 const result={scope:'isolated synthetic two-section Word and dedicated Chrome',capabilityChecked:true,staticLossHint:true,downloaded:true,bodyAndStoriesPresent:true,opaqueAssetUrlsAbsent:true};await writeFile(join(out,'browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{if(chrome){try{process.kill(-chrome.pid,'SIGKILL')}catch{}}ws?.close();await rm(profile,{recursive:true,force:true})}
