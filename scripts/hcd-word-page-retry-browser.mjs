/** Actual normal page request refresh, process loss and durable cancellation acceptance. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdir,mkdtemp,readdir,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
const root=resolve(process.argv[2]),out=resolve(process.argv[3]),c=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
assert.equal(c.root,root);assert.equal(c.clean,true);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
await mkdir(out,{recursive:true});const profile=await mkdtemp(join(tmpdir(),'hcd-word-page-retry-')),downloads=await mkdtemp(join(out,'downloads-')),tabs=[],pending=new Map(),errors=[]
let chrome,ws,seq=0,socketCount=0;const pageRequests=[]
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

const mode=process.argv[4];assert.ok(['lost','cancel'].includes(mode));assert.equal(c.allowRestart,true)
let blockStatus=true,inject=true,pausedWork=new Set();const faults=[],checks=[],responses=[],responseIds=new Map()
const stored=tab=>evaluate(tab,`(()=>{const key=Object.keys(sessionStorage).find(k=>k.startsWith('hcd-word-page-request/1:'));return key?JSON.parse(sessionStorage.getItem(key)):null})()`)
async function panelClick(tab,label){await until(()=>evaluate(tab,`[...document.querySelectorAll('.word-page-transaction button')].some(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled)`),'panel '+label);assert.equal(await evaluate(tab,`(()=>{const b=[...document.querySelectorAll('.word-page-transaction button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`),true)}
async function stage(tab){
 const native=await read('/word/layout?revision='+await head()),width=native.layout.sections[0].page.widthTwips===11906?12240:11906
 assert.equal(await evaluate(tab,`(()=>{const b=[...document.querySelectorAll('.word-tabs button')].find(b=>b.textContent==='布局');b?.click();return !!b})()`),true);await click(tab,'页面设置');await until(()=>evaluate(tab,`!!document.querySelector('.word-page-setup')`),'setup')
 for(const [index,value] of [[1,width===11906?'a4':'letter'],[2,'portrait']])assert.equal(await evaluate(tab,`(()=>{const s=document.querySelectorAll('.word-page-setup select')[${index}];Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`),true)
 for(const label of ['核对更改','应用设置']){await until(()=>evaluate(tab,`[...document.querySelectorAll('.word-page-setup button')].some(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled)`),'form '+label);await evaluate(tab,`[...document.querySelectorAll('.word-page-setup button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`)}
 return width
}
async function reload(tab){const before=await evaluate(tab,'performance.timeOrigin');await call('Page.reload',{},tab.sessionId);await until(()=>evaluate(tab,`performance.timeOrigin!==${before}&&document.readyState==='complete'`),'reload')}
async function ready(tab,readonly=false){await until(()=>evaluate(tab,readonly?`!!document.querySelector('.regional-word-workspace .tiptap')`:`!!document.querySelector('.word-region-rich[data-word-kind="body"] .tiptap[contenteditable="true"]')`),'normal editor ready')}
async function restart(){let generation=0;try{generation=JSON.parse(await readFile(join(root,'sidecar-restarted.json'),'utf8')).generation}catch{}await writeFile(join(root,'restart-sidecar'),'restart');await until(async()=>{try{return JSON.parse(await readFile(join(root,'sidecar-restarted.json'),'utf8')).generation>generation}catch{return false}},'owned sidecar restart')}
async function post(operation,record,token=c.alice){const response=await fetch(`http://127.0.0.1:${c.collabPort}/v1/documents/region-test/collaboration/word-active-layout${operation?'-'+operation:''}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify({epoch:record.epoch,request:record.request})});return{status:response.status,body:await response.json()}}
try{
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run','--user-data-dir='+profile,'--remote-debugging-port=0','about:blank'],{stdio:'ignore',detached:true})
 let port;await until(async()=>{try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok}catch{return false}},'isolated Chrome')
 const info=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();ws=new WebSocket(info.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
 async function paused(message){const p=message.params,session=message.sessionId,path=new URL(p.request.url).pathname,response=p.responseStatusCode!==undefined;if(p.request.method!=='POST')return call(response?'Fetch.continueResponse':'Fetch.continueRequest',{requestId:p.requestId},session)
  if(path.endsWith('/word-active-layout-status')&&blockStatus){faults.push('status-blocked');return call('Fetch.failRequest',{requestId:p.requestId,errorReason:'ConnectionClosed'},session)}
  if(path.endsWith('/word-active-layout')&&inject&&((mode==='lost'&&response)||(mode==='cancel'&&!response))){if(mode==='lost')assert.equal(p.responseStatusCode,200);inject=false;faults.push(mode==='lost'?'successful-response-dropped':'request-not-dispatched');return call('Fetch.failRequest',{requestId:p.requestId,errorReason:'ConnectionClosed'},session)}
  return call(response?'Fetch.continueResponse':'Fetch.continueRequest',{requestId:p.requestId},session)
 }
 ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id&&pending.has(m.id)){const task=pending.get(m.id);pending.delete(m.id);clearTimeout(task.timer);m.error?task.reject(Error(m.error.message)):task.resolve(m.result)}
  if(m.method==='Fetch.requestPaused'){const task=paused(m).catch(error=>errors.push('interception: '+error.message)).finally(()=>pausedWork.delete(task));pausedWork.add(task)}
  if(m.method==='Network.requestWillBeSent'&&m.params.request.method==='POST'){const req=m.params.request;if(req.url.endsWith('/word-active-layout')&&req.postData)pageRequests.push(JSON.parse(req.postData));if(req.url.endsWith('/word-active-layout-check'))checks.push('native-signed-receipt')}
  if(m.method==='Network.responseReceived'&&/\/word-active-layout(?:-cancel|-check)?$/.test(new URL(m.params.response.url).pathname))responseIds.set(m.params.requestId,{route:new URL(m.params.response.url).pathname.split('/').pop(),status:m.params.response.status});
  if(m.method==='Network.loadingFinished'&&responseIds.has(m.params.requestId)){const value=responseIds.get(m.params.requestId);void call('Network.getResponseBody',{requestId:m.params.requestId},m.sessionId).then(body=>{try{value.body=JSON.parse(body.body)}catch{}responses.push(value);console.error(JSON.stringify(value))}).catch(()=>{})}
  if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text)
 }
 const alice=await tab('alice'),bob=await tab('bob'),reader=await tab('reader');await ready(alice);await ready(bob);await ready(reader,true)
 await call('Fetch.enable',{patterns:[{urlPattern:'*/word-active-layout',requestStage:'Request'},{urlPattern:'*/word-active-layout',requestStage:'Response'},{urlPattern:'*/word-active-layout-status',requestStage:'Request'}]},alice.sessionId)
 const initial=await head(),width=await stage(alice)
 await until(()=>evaluate(alice,`!!document.querySelector('.word-page-transaction code')&&[...document.querySelectorAll('.word-page-transaction button')].some(b=>!b.disabled)`),'unknown result retained');const original=await stored(alice);assert.ok(original);await writeFile(join(out,'retained-request.json'),JSON.stringify(original,null,2)+'\n');assert.deepEqual(pageRequests[0],{epoch:original.epoch,request:original.request});await screenshot(alice,'unknown.png')
 let cancelledReplay,alteredCheck,readerCheck,newRequest
 if(mode==='lost'){
  assert.equal(await head(),initial+1);await reload(alice);await until(async()=>JSON.stringify(await stored(alice))===JSON.stringify(original),'refresh exact request');await panelClick(alice,'重试原请求');await until(()=>evaluate(alice,`document.querySelector('.word-page-transaction')?.textContent.includes('页面调整已确认')`),'same-request retry');assert.equal(pageRequests.length,2);assert.deepEqual(pageRequests[0],pageRequests[1]);assert.equal(await head(),initial+1);await screenshot(alice,'same-request-retry.png')
 }else{
  assert.equal(await head(),initial);await panelClick(alice,'检查并取消未准备的请求');await until(()=>evaluate(alice,`document.querySelector('.word-page-transaction')?.textContent.includes('未准备的请求已取消')`),'cancel unprepared');assert.equal((await stored(alice)).operation,'cancel');assert.equal(await head(),initial);await screenshot(alice,'cancelled.png')
 }
 await restart();blockStatus=false;for(const page of [bob,reader,alice])await reload(page);await ready(bob);await ready(reader,true);await ready(alice);for(const page of [alice,bob,reader])await saved(page)
 if(mode==='lost'){
  // The refresh can check before a stable room exists. Explicitly check again once ready.
  await until(()=>evaluate(alice,`[...document.querySelectorAll('.word-page-transaction button')].some(b=>!b.disabled)`),'request panel after restart')
  if(!(await text(alice)).includes('页面调整已确认'))await panelClick(alice,'核对结果')
  await until(()=>evaluate(alice,`document.querySelector('.word-page-transaction')?.textContent.includes('页面调整已确认')`),'native receipt after process loss');assert.ok(checks.length>=1);assert.equal(pageRequests.length,2);assert.equal(await head(),initial+1)
  const changed=structuredClone(original);changed.request.edits.changes[0].value+=1;alteredCheck=await post('check',changed);readerCheck=await post('check',original,c.reader);assert.equal(alteredCheck.status,409);assert.equal(readerCheck.status,403);assert.equal(await head(),initial+1);await screenshot(alice,'signed-receipt-after-restart.png')
 }else{
  // Replay before refilling any process-local cancellation cache.
  cancelledReplay=await post('',original);assert.equal(cancelledReplay.status,409);assert.match(JSON.stringify(cancelledReplay.body),/word-topology-cancelled/);assert.equal(await head(),initial)
  await panelClick(alice,'重试同一次取消');await until(()=>evaluate(alice,`document.querySelector('.word-page-transaction')?.textContent.includes('未准备的请求已取消')`),'cancel retry after restart');assert.equal(await head(),initial);assert.equal(pageRequests.length,1);await screenshot(alice,'durable-cancel-after-restart.png')
 }
 await panelClick(alice,'关闭');assert.equal(await stored(alice),null)
 if(mode==='cancel'){
  await ready(alice);await stage(alice);await until(()=>evaluate(alice,`document.querySelector('.word-page-transaction')?.textContent.includes('页面调整已确认')`),'new page request after cancellation');newRequest=await stored(alice);assert.notEqual(newRequest.request.transactionId,original.request.transactionId);assert.equal(await head(),initial+1);await panelClick(alice,'关闭');assert.equal((await post('',original)).status,409)
 }
 for(const page of [alice,bob]){await ready(page);await saved(page)}await ready(reader,true)
 const marker='Page '+mode+' peer '+randomUUID().slice(0,8);await insert(bob,' · '+marker);await until(async()=>(await paper(alice)).includes(marker),'peer edit after recovery');const finalRevision=await save(bob);for(const page of [alice,bob,reader]){await saved(page);await until(()=>evaluate(page,`document.querySelector('.word-titlebar small')?.textContent.includes('r${finalRevision}')`),'all roles at latest revision')}assert.equal(finalRevision,initial+2);await screenshot(alice,'continued-editing.png');assert.deepEqual(errors,[])
 const result={scope:'actual Chrome normal page controls with native service, sidecar restart and controlled transport faults',mode,initial,pageRevision:initial+1,finalRevision,pageWidthTwips:width,marker,originalRequest:original,newRequest,exactRequestRetained:true,applyPostCount:pageRequests.length,faults,responses,signedReceiptChecks:checks.length,cancelledReplay,alteredCheck,readerCheck,browserExceptions:errors,physicalDevice:false,realIme:false,production:false}
 await writeFile(join(out,'browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}catch(error){for(let i=0;i<tabs.length;i++)await screenshot(tabs[i],`failed-${i}.png`).catch(()=>{});await writeFile(join(out,'failure-details.json'),JSON.stringify({errors,faults,checks,responses,pages:await Promise.all(tabs.map(page=>evaluate(page,'document.body.textContent.slice(-7000)').catch(()=>'')))},null,2));throw error}
finally{if(chrome){const exit=new Promise(resolve=>chrome.once('exit',resolve));try{process.kill(-chrome.pid,'SIGKILL')}catch{}await exit}ws?.close();await rm(profile,{recursive:true,force:true});await rm(downloads,{recursive:true,force:true})}
