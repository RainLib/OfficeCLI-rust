/** Normal browser story replacement. Creation remains an explicit API action. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdir,mkdtemp,readdir,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
const root=resolve(process.argv[2]),out=resolve(process.argv[3]),c=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
assert.equal(c.root,root);assert.equal(c.clean,true);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
await mkdir(out,{recursive:true});const profile=await mkdtemp(join(tmpdir(),'hcd-word-page-controls-')),downloads=await mkdtemp(join(out,'downloads-')),tabs=[],pending=new Map(),errors=[]
let chrome,ws,seq=0,socketCount=0;const pageRequests=[],networkFailures=[]
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP '+method+' timeout'))},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})
async function until(check,label){const end=Date.now()+60000;while(Date.now()<end){if(await check())return;await sleep(100)}throw Error(label+' timeout')}
async function evaluate(tab,expression){const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},tab.sessionId);if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value}
const text=tab=>evaluate(tab,'document.body.innerText'),paper=tab=>evaluate(tab,`document.querySelector('.word-region-paper')?.textContent||''`)
const headers={Authorization:'Bearer '+c.reader,'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7'}
async function read(route,token=c.reader){const response=await fetch(c.origin+'/v1/documents/region-test'+route,{headers:{...headers,Authorization:'Bearer '+token}});assert.equal(response.status,200);return response.json()}
const head=async()=>(await read('')).revision
async function tab(person){const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true}),value={targetId,sessionId};tabs.push(value);await call('Page.enable',{},sessionId);await call('Runtime.enable',{},sessionId);await call('Network.enable',{},sessionId);await call('Emulation.setDeviceMetricsOverride',{width:1100,height:1050,deviceScaleFactor:1,mobile:false},sessionId);await call('Page.navigate',{url:c.pages[person]},sessionId);return value}
async function click(tab,label){await until(()=>evaluate(tab,`[...document.querySelectorAll('.ribbon button')].some(node=>(node.getAttribute('aria-label')===${JSON.stringify(label)}||node.textContent.trim()===${JSON.stringify(label)})&&!node.disabled)`),'enabled '+label);assert.equal(await evaluate(tab,`(()=>{const button=[...document.querySelectorAll('.ribbon button')].find(node=>node.getAttribute('aria-label')===${JSON.stringify(label)}||node.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)return false;button.click();return true})()`),true,'enabled '+label)}
async function insert(tab,value){assert.equal(await evaluate(tab,`(()=>{const editor=document.querySelector('.word-region-rich[data-word-kind="body"] .tiptap[contenteditable="true"]'),p=editor?.querySelector('p');if(!p)return false;editor.focus();const range=document.createRange();range.selectNodeContents(p);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return true})()`),true);await call('Input.insertText',{text:value},tab.sessionId)}
async function saved(tab){await until(()=>evaluate(tab,`document.querySelector('.word-titlebar small')?.textContent.includes('已保存')`),'verified saved UI')}
async function save(tab){await click(tab,'保存');await saved(tab);return head()}
async function screenshot(tab,name){const image=await call('Page.captureScreenshot',{format:'png'},tab.sessionId);await writeFile(join(out,name),Buffer.from(image.data,'base64'))}
const own='Story own '+randomUUID().slice(0,8),peer='Story peer '+randomUUID().slice(0,8)
try{
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run','--user-data-dir='+profile,'--remote-debugging-port=0','about:blank'],{stdio:'ignore',detached:true})
 let port;await until(async()=>{try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok}catch{return false}},'isolated Chrome')
 const info=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();ws=new WebSocket(info.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
 ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const task=pending.get(message.id);pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error(message.error.message)):task.resolve(message.result)}if(message.method==='Network.webSocketCreated')socketCount++;if(message.method==='Network.responseReceived'&&message.params.response.status>=400&&message.params.response.url.includes('/word-room-projection'))networkFailures.push({route:'word-room-projection',status:message.params.response.status});if(message.method==='Network.requestWillBeSent'&&message.params.request.url.endsWith('/word-active-layout')&&message.params.request.method==='POST'&&message.params.request.postData){const body=JSON.parse(message.params.request.postData);pageRequests.push(body)}if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);if(message.method==='Runtime.consoleAPICalled'&&message.params.type==='error')errors.push(message.params.args.map(arg=>arg.description??arg.value??'').join(' '));if(message.method==='Page.javascriptDialogOpening')void call('Page.handleJavaScriptDialog',{accept:true},message.sessionId)}
 await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads})
 const alice=await tab('alice'),bob=await tab('bob'),reader=await tab('reader')
 for(const page of [alice,bob])await until(()=>evaluate(page,`!!document.querySelector('.word-region-rich[data-word-kind="body"] .tiptap[contenteditable="true"]')`),'normal editor ready')
 await until(()=>evaluate(reader,`!!document.querySelector('.regional-word-workspace .tiptap')`),'reader ready')

 const openedRevision=await head();await insert(alice,' · '+own);await until(async()=>(await paper(bob)).includes(own),'own edit synchronized');const initial=await save(alice);assert.ok(initial>openedRevision);await saved(bob)
 const origins=await Promise.all(tabs.map(page=>evaluate(page,'performance.timeOrigin'))),socketsBefore=socketCount
 const native=await read('/word/layout?revision='+initial),auth=await read('/auth',c.alice),kind=process.argv.includes('--footer')?'footer':'header',bindings=kind==='footer'?'footers':'headers',selection={sectionId:native.layout.sections[1].id,kind,variant:'default',transactionId:randomUUID().replaceAll('-','')}
 assert.equal(native.layout.sections[1][bindings].default,undefined)
 async function post(action,body){const r=await fetch(`http://127.0.0.1:${c.collabPort}/v1/documents/region-test/collaboration/word-active-story-${action}`,{method:'POST',headers:{Authorization:'Bearer '+c.alice,'Content-Type':'application/json','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Story-Version':'1'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value}
 const preview=await post('preview',{epoch:auth.collaborationEpoch,selection}),applied=await post('submit',{epoch:auth.collaborationEpoch,pending:preview.pending,reviewHash:preview.reviewHash});assert.equal(applied.revision,initial+1)
 for(const page of [alice,bob]){await until(()=>evaluate(page,`!!document.querySelector('.word-region-rich[data-word-kind="body"] .tiptap[contenteditable="true"]')`),'automatic story rebind');await saved(page)}
 await until(()=>evaluate(reader,`!!document.querySelector('.word-region-paper')`),'reader automatic story rebind');await saved(reader)
 await until(()=>socketCount>=socketsBefore+3,'three replacement transports');assert.deepEqual(await Promise.all(tabs.map(page=>evaluate(page,'performance.timeOrigin'))),origins)
 assert.equal(await evaluate(reader,`document.querySelectorAll('.tiptap[contenteditable="true"]').length`),0)
 for(const page of tabs)assert.ok((await paper(page)).includes(own));await screenshot(alice,'story-rebound.png')
 await insert(bob,' · '+peer);await until(async()=>(await paper(alice)).includes(peer),'peer edit after story rebind');const peerRevision=await save(bob);await saved(alice)
 await click(alice,'撤销');await until(async()=>!(await paper(alice)).includes(own)&&(await paper(alice)).includes(peer),'own undo retains peer after story');const undoRevision=await save(alice)
 await click(alice,'重做');await until(async()=>(await paper(alice)).includes(own)&&(await paper(alice)).includes(peer),'own redo retains peer after story');const redoRevision=await save(alice);await screenshot(alice,'story-history-redo.png')
 const storyId=preview.pending.story.id,storyMarker='Rebound story '+randomUUID().slice(0,8)
 for(const page of tabs){
  await evaluate(page,`[...document.querySelectorAll('.statusbar button')].find(b=>b.textContent==='节导航').click()`)
  await until(()=>evaluate(page,`document.querySelectorAll('.word-outline-sections button').length>=2`),'section navigation')
  await evaluate(page,`document.querySelectorAll('.word-outline-sections button')[1].click()`)
  await evaluate(page,`(()=>{const s=document.querySelector('.statusbar select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'default');s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await until(()=>evaluate(page,`!!document.querySelector('[data-word-region="${storyId}"] .tiptap')`),'independent story in retained view')
 }
 await evaluate(alice,`[...document.querySelectorAll('.word-tabs button')].find(b=>b.textContent==='插入').click()`);await click(alice,kind==='footer'?'编辑页脚':'编辑页眉')
 await until(()=>evaluate(alice,`!!document.querySelector('[data-word-region="${storyId}"] .tiptap[contenteditable="true"]')`),'independent region editable after rebind')
 await evaluate(alice,`(()=>{const e=document.querySelector('[data-word-region="${storyId}"] .tiptap[contenteditable="true"]'),p=e.querySelector('p');e.focus();const r=document.createRange();r.selectNodeContents(p);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r)})()`)
 await call('Input.insertText',{text:' · '+storyMarker},alice.sessionId)
 for(const page of [bob,reader])await until(()=>evaluate(page,`document.querySelector('[data-word-region="${storyId}"]')?.textContent.includes(${JSON.stringify(storyMarker)})`),'independent region shared after rebind')
 const finalRevision=await save(alice);await screenshot(alice,'independent-story-after-rebind.png')
 assert.equal(await evaluate(alice,`(()=>{const b=[...document.querySelectorAll('.statusbar button')].find(n=>n.textContent.includes('下载')&&n.textContent.includes('草稿'));if(!b)return false;b.click();return true})()`),true)
 let backup;await until(async()=>{backup=(await readdir(downloads)).find(name=>name.endsWith('.hcd-word-draft'));return !!backup},'story device backup');await writeFile(join(out,'device-backup.hcd-word-draft'),await readFile(join(downloads,backup)))
 const origin=await evaluate(alice,'performance.timeOrigin');await call('Page.reload',{},alice.sessionId);await until(()=>evaluate(alice,`performance.timeOrigin!==${origin}&&!!document.querySelector('.word-region-rich .tiptap[contenteditable="true"]')`),'story device journal reopen');await saved(alice);assert.ok((await paper(alice)).includes(own)&&(await paper(alice)).includes(peer));assert.equal(await head(),finalRevision)
 const result={scope:'normal isolated Chrome automatic story rebind and personal content history; story creation initiated by actual sidecar API',openedRevision,initial,storyRevision:applied.revision,peerRevision,undoRevision,redoRevision,finalRevision,storyMarker,normalIndependentStoryEditVerified:true,selection,pending:preview.pending,markers:{own,peer},automaticWriterRebind:true,automaticReadOnlyRebind:true,automaticStoryRebind:true,noPageReloadDuringRebind:true,personalHistoryRetained:true,peerSameParagraphInputRetained:true,deviceBackupDownloaded:true,reopenedDeviceJournal:true,browserExceptions:errors,networkFailures,normalStoryCreationUI:false,physicalDevice:false,realIme:false,production:false}
 assert.deepEqual(errors,[]);await writeFile(join(out,'service.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({initial,storyRevision:applied.revision,finalRevision,automaticStoryRebind:true,personalHistoryRetained:true,browserExceptions:errors}))
}catch(error){for(let i=0;i<tabs.length;i++)await screenshot(tabs[i],`failed-${i}.png`).catch(()=>{});await writeFile(join(out,'failure-details.json'),JSON.stringify({errors,networkFailures,pages:await Promise.all(tabs.map(page=>evaluate(page,'document.body.textContent.slice(-7000)').catch(()=>'')))},null,2));if(tabs[0])console.error((await text(tabs[0]).catch(()=>'' )).slice(0,2000));throw error}
finally{if(chrome){const exit=new Promise(resolve=>chrome.once('exit',resolve));try{process.kill(-chrome.pid,'SIGKILL')}catch{}await exit}ws?.close();await rm(profile,{recursive:true,force:true});await rm(downloads,{recursive:true,force:true})}
