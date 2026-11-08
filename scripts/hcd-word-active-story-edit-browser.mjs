/** Normal editor edits an API-created independent footer after a fresh join. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdir,mkdtemp,readdir,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
const root=resolve(process.argv[2]),out=resolve(process.argv[3]),c=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
assert.equal(c.root,root);assert.equal(c.clean,true);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
await mkdir(out,{recursive:true});const profile=await mkdtemp(join(tmpdir(),'hcd-active-story-editor-')),downloads=await mkdtemp(join(out,'downloads-')),tabs=[],pending=new Map(),errors=[]
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

const service=JSON.parse(await readFile(resolve(out,'../service.json'),'utf8')),storyId=service.pending.story.id,marker='Independent footer '+randomUUID().slice(0,8)
async function choose(page){
 await until(()=>evaluate(page,`!!document.querySelector('.regional-word-workspace .tiptap')`),'editor ready');await saved(page)
 await evaluate(page,`(()=>{const b=[...document.querySelectorAll('.statusbar button')].find(b=>b.textContent==='节导航');b.click()})()`)
 await until(()=>evaluate(page,`document.querySelectorAll('.word-outline-sections button').length>=2`),'section navigation')
 await evaluate(page,`document.querySelectorAll('.word-outline-sections button')[1].click()`)
 await evaluate(page,`(()=>{const s=document.querySelector('.statusbar select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'default');s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
 await until(()=>evaluate(page,`!!document.querySelector('[data-word-region="${storyId}"] .tiptap')`),'new independent story rendered')
}
try{
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run','--user-data-dir='+profile,'--remote-debugging-port=0','about:blank'],{stdio:'ignore',detached:true})
 let port;await until(async()=>{try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok}catch{return false}},'isolated Chrome')
 const info=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();ws=new WebSocket(info.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
 ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text)}
 const alice=await tab('alice'),bob=await tab('bob'),reader=await tab('reader');for(const page of tabs)await choose(page)
 const initial=await head();await evaluate(alice,`[...document.querySelectorAll('.word-tabs button')].find(b=>b.textContent==='插入').click()`);await click(alice,'编辑页脚')
 await until(()=>evaluate(alice,`!!document.querySelector('[data-word-region="${storyId}"] .tiptap[contenteditable="true"]')`),'new footer editable')
 assert.equal(await evaluate(alice,`(()=>{const e=document.querySelector('[data-word-region="${storyId}"] .tiptap[contenteditable="true"]'),p=e?.querySelector('p');if(!p)return false;e.focus();const r=document.createRange();r.selectNodeContents(p);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);return true})()`),true)
 await call('Input.insertText',{text:' · '+marker},alice.sessionId)
 for(const page of [bob,reader])await until(()=>evaluate(page,`document.querySelector('[data-word-region="${storyId}"]')?.textContent.includes(${JSON.stringify(marker)})`),'new footer shared')
 const finalRevision=await save(alice);assert.equal(finalRevision,initial+1);for(const page of tabs)await saved(page);await screenshot(alice,'independent-footer-edited.png')
 await call('Page.reload',{},alice.sessionId);await choose(alice);assert.ok((await paper(alice)).includes(marker));assert.equal(await head(),finalRevision)
 assert.deepEqual(errors,[]);const result={scope:'normal editor after fresh join to an API-created story; no creation UI or automatic story rebind',initial,finalRevision,storyId,section:2,kind:'footer',variant:'default',marker,threeRolesShared:true,saved:true,reopened:true,browserExceptions:errors,normalStoryCreationUI:false,automaticStoryRebind:false,physicalDevice:false,realIme:false,production:false};await writeFile(join(out,'browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}catch(error){for(let i=0;i<tabs.length;i++)await screenshot(tabs[i],`failed-${i}.png`).catch(()=>{});await writeFile(join(out,'failure.json'),JSON.stringify({errors,pages:await Promise.all(tabs.map(p=>evaluate(p,'document.body.innerText.slice(-3000)').catch(()=>'')))},null,2));throw error}
finally{if(chrome){const exit=new Promise(resolve=>chrome.once('exit',resolve));try{process.kill(-chrome.pid,'SIGKILL')}catch{}await exit}ws?.close();await rm(profile,{recursive:true,force:true});await rm(downloads,{recursive:true,force:true})}
