import assert from 'node:assert/strict'
import {readFile,writeFile,open} from 'node:fs/promises'
import {spawn,type ChildProcess} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {WordRegionStore,wordRegionSchema,wordRegionStoreField} from '../examples/hdoc/editor/src/wordRegionStore.ts'
import {wordOutline,wordOutlineTransaction,wordOutlinePosition} from '../examples/hdoc/editor/src/wordOutline.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8'));assert.match(c.root,/\/target\/hcd-preview-runtime\/word-outline-/)
const started=performance.now(),progress=(stage:string,detail?:unknown)=>console.log(JSON.stringify({elapsedMs:Math.round(performance.now()-started),stage,...(detail===undefined?{}:{detail})}))
const schema=wordRegionSchema(),clients:Array<{document:Y.Doc;provider:HocuspocusProvider;model:WordRegionStore}>=[],log=await open(c.root+'/sidecar.log','a')
let sidecar:ChildProcess|undefined
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+40000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,30))}throw Error('Timeout '+label)}
async function native(route:string){const response=await fetch(c.apiUrl+route,{headers:{Authorization:'Bearer '+c.reader,'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7'},signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,await response.clone().text());return response.json()}
const initial=await native('/editor?revision=1')
async function refresh(value:typeof clients[number]){const hash=value.document.getMap(wordRegionStoreField).get('layoutHash');if(!hash)return false;if(hash!==value.model.layoutState().layoutHash){const projection=await native('/editor');if(projection.flowLayoutHash!==hash)return false;value.model.syncLayout(projection.flowLayout,projection.flowLayoutHash)}return true}
async function client(user:'alice'|'bob'){
 const document=new Y.Doc(),provider=new HocuspocusProvider({url:`ws://127.0.0.1:${c.collabPort}?hcdNodeEdits=7&hcdWordRegions=1`,name:'outline:1:wordregions1:save5',document,token:c[user],WebSocketPolyfill:WebSocket}),model=new WordRegionStore(document,schema,'outline',initial.flowLayout,initial.flowLayoutHash),value={document,provider,model};clients.push(value)
 provider.on('close',({event})=>progress('socket close',{user,code:event.code,reason:event.reason}));provider.on('status',({status})=>progress('socket status',{user,status}));provider.on('stateless',({payload})=>{try{const message=JSON.parse(payload);progress('stateless',{user,type:message.type,status:message.status,revision:message.revision,error:message.error})}catch{}})
 await until(async()=>provider.isSynced&&!provider.hasUnsyncedChanges&&document.getMap(wordRegionStoreField).size>0&&await refresh(value),'regional client');return value
}
try{
 sidecar=spawn(process.execPath,['--import','tsx','sidecar.ts'],{cwd:fileURLToPath(new URL('../examples/hdoc/editor/',import.meta.url)),env:{...process.env,HCD_WORD_ROOMS:'1',HCD_TOKEN_SECRET:c.secret,HCD_API_URL:c.origin,HCD_COLLAB_PORT:String(c.collabPort),HCD_SIDECAR_STATE_DIR:c.root+'/sidecar'},stdio:['ignore',log.fd,log.fd]})
 await until(async()=>{if(sidecar!.exitCode!==null)throw Error('sidecar exited');try{return(await fetch(`http://127.0.0.1:${c.collabPort}`,{signal:AbortSignal.timeout(500)})).ok}catch{return false}},'sidecar ready')
 progress('connecting');const a=await client('alice'),b=await client('bob'),entries=wordOutline(initial.flowLayout,a.model.structure.project());progress('clients ready');assert.equal(entries.length,183);assert.equal(entries.filter(v=>v.text==='Repeated title').length,2);assert.ok(entries.every(v=>!v.text.includes('Header heading')))
 const target=entries.find(v=>v.text==='Repeated title'&&v.sectionId===initial.flowLayout.sections[1].id)!,before=Y.encodeStateAsUpdate(a.document),state=EditorState.create({schema,doc:a.model.project(target.sectionId)}),navigation=wordOutlineTransaction(state,target)!
 assert.ok(navigation);assert.equal(navigation.docChanged,false);assert.deepEqual(Y.encodeStateAsUpdate(a.document),before);assert.equal((await native('')).revision,1)
 const second=b.model.region(target.sectionId),heading=second.find(v=>v.node.attrs.hcdStructureKey===target.key)!
 b.model.reconcile(target.sectionId,second,second.map(v=>v===heading?{key:v.key,node:v.node.type.createChecked(v.node.attrs,schema.text('Peer renamed heading',v.node.firstChild?.marks))}:v))
 const firstId=initial.flowLayout.sections[0].id,first=a.model.region(firstId);a.model.reconcile(firstId,first,[{node:schema.nodes.paragraph.createChecked(null,schema.text('Before heading'))},...first])
 await until(async()=>{if(!clients.every(v=>v.provider.isSynced&&!v.provider.hasUnsyncedChanges))return false;await Promise.all(clients.map(refresh));return clients.every(v=>v.model.contents()===a.model.contents())},'peer title and first-section insertion')
 const updated=wordOutline(initial.flowLayout,a.model.structure.project());assert.deepEqual(updated.map(v=>v.key),entries.map(v=>v.key));assert.equal(updated.find(v=>v.key===target.key)!.text,'Peer renamed heading');assert.notEqual(wordOutlinePosition(a.model.project(target.sectionId),target),null)
 progress('save requested');const saved=await requestCoordinatedSave(a.provider,createHash('sha256').update(a.model.contents()).digest('hex'),undefined,40000,await imageDraftDigest(a.document));progress('save received',{status:saved.status,revision:saved.revision});assert.equal(saved.status,'saved',JSON.stringify(saved));assert.equal(saved.pending,false)
 await until(async()=>!a.provider.hasUnsyncedChanges&&await refresh(a),'source receipt')
 const afterReceipt=wordOutline(a.model.layoutState().layout,a.model.structure.project());assert.deepEqual(afterReceipt,updated)
 const reopened=await client('alice');assert.deepEqual(wordOutline(reopened.model.layoutState().layout,reopened.model.structure.project()),afterReceipt)
 const evidence={scope:'Actual native Word projection, production regional sidecar, authenticated sockets and native files; no browser or physical Word pagination claim',head:saved.revision,headingCount:entries.length,sections:initial.flowLayout.sections.length,navigationDidNotWriteOrSave:true,sameTitleDistinctIdentities:true,peerRenameKeepsIdentity:true,receiptKeepsOutlineIdentity:true,freshConnectionExact:true,headerHeadingsExcluded:true}
 await writeFile(c.root+'/outline-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence))
}finally{for(const value of clients){value.provider.destroy();value.document.destroy()}if(sidecar){const child=sidecar;child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',()=>resolve());setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL')},3000).unref()})}await log.close()}
