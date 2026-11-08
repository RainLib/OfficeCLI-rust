/** Concurrent regional choices against an isolated real sidecar and native service. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {imageIntents} from '../examples/hdoc/editor/src/collaborativeImages.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8'))
const headers=(person:string)=>({Authorization:`Bearer ${c[person]}`,'X-HCD-Node-Edits-Version':'7','X-HCD-Collaboration-Epoch':'1'})
async function native(route:string){const response=await fetch(c.apiUrl+route,{headers:{...headers('reader'),'X-HCD-Flow-Layout-Version':'2'},signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);return response.json()}
const initial=await native('/editor'),image=(await native('/images')).entries[0],head=(await native('/revisions?limit=1')).headRevision
const url=`http://127.0.0.1:${c.collabPort}/v1/documents/rich/collaboration/word-uploads`
const document=new Y.Doc(),provider=new HocuspocusProvider({url:`ws://127.0.0.1:${c.collabPort}?hcdNodeEdits=7&hcdWordRegions=1`,name:'rich:1:wordregions1:save5',document,token:c.bob,WebSocketPolyfill:WebSocket})
async function until(check:()=>boolean){const deadline=Date.now()+20000;while(!check()){if(Date.now()>deadline)throw new Error('timed out');await new Promise(resolve=>setTimeout(resolve,25))}}
async function request(person:string,body:unknown,id?:string){const response=await fetch(url+(id?`/${id}`:''),{method:id?'PUT':'POST',headers:{...headers(person),'Content-Type':id?'application/octet-stream':'application/json'},body:id?body as BodyInit:JSON.stringify(body),signal:AbortSignal.timeout(45000)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result}
try{
 await until(()=>provider.isSynced&&!provider.hasUnsyncedChanges)
 const files=await Promise.all(['replacement.png','recovery-original.png','interrupted-original.png'].map(name=>readFile(c.root+'/'+name)))
 const choices=Array.from({length:6},(_,i)=>{const bytes=files[i%files.length],person=i%2?'alice':'bob';return{person,bytes,selection:{id:randomUUID(),nodeId:image.nodeId,extension:'png',assetHash:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,revision:initial.revision,clientId:document.clientID,visualHash:image.visualHash,seen:[]}}})
 for(const choice of choices)await request(choice.person,{operation:'reserve',selection:choice.selection})
 await Promise.all(choices.map(choice=>request(choice.person,choice.bytes,choice.selection.id)))
 await until(()=>choices.every(choice=>imageIntents(document).filter(intent=>intent.intentId===choice.selection.id).length===1))
 assert.equal((await native('/revisions?limit=1')).headRevision,head)
 const evidence={scope:'isolated native service and regional sidecar, concurrent HTTP uploads, one observed WebSocket member',choices:choices.length,distinctBytes:files.length,appliedOnceEach:true,canonicalRevisionUnchanged:head,lockBusyResponsesObserved:null,note:'The test does not instrument native 409 responses or resolve concurrent choices into a saved revision.'}
 await writeFile(c.root+'/upload-concurrent-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence))
}finally{provider.destroy();document.destroy()}
