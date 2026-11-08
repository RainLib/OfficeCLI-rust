import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import assert from 'node:assert/strict'
import {readFile,writeFile,open} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),log=await open(config.root+'/sidecar.log','a')
const child=spawn(process.execPath,['--import','tsx','sidecar.ts'],{cwd:fileURLToPath(new URL('../examples/hdoc/editor/',import.meta.url)),env:{...process.env,HCD_API_URL:config.origin,HCD_COLLAB_BIND:'127.0.0.1',HCD_COLLAB_PORT:String(config.collabPort),HCD_TOKEN_SECRET:config.secret,HCD_SIDECAR_STATE_DIR:config.root+'/sidecar-state'},stdio:['ignore',log.fd,log.fd]})
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check:()=>boolean|Promise<boolean>,name:string){const until=Date.now()+25000;while(Date.now()<until){if(await check())return;await pause(50)}throw new Error('Timeout: '+name)}
let provider:HocuspocusProvider|undefined,document:Y.Doc|undefined,bob:HocuspocusProvider|undefined,bobDoc:Y.Doc|undefined
try{
 await until(async()=>{try{return(await fetch(`http://127.0.0.1:${config.collabPort}`,{signal:AbortSignal.timeout(500)})).status===200}catch{return false}},'sidecar listens')
 const selected=await fetch(`http://127.0.0.1:${config.collabPort}/v1/documents/doc/collaboration/negotiate`,{method:'POST',headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config.alice}`},signal:AbortSignal.timeout(45000)});assert.equal(selected.status,200,await selected.clone().text());const authority=await selected.json()
 document=new Y.Doc();const store=new SemanticBlockStore(document,schema)
 provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(`ws://127.0.0.1:${config.collabPort}`),name:`doc:${authority.collaborationEpoch}:structure3:save4`,document,token:config.alice,WebSocketPolyfill:WebSocket})
 await until(()=>provider!.isSynced&&store.initialized&&!provider!.hasUnsyncedChanges,'reference-aware room')
 const original=jsonToSnapshot(store.project().toJSON()).flatMap(block=>block.content.inlines).filter(inline=>inline.reference).map(inline=>inline.reference!.mentionId).sort();assert.equal(original.length,2)
 store.insert([schema.node('paragraph',null,schema.text('Text saved with offline people directory'))],null);await until(()=>!provider!.hasUnsyncedChanges,'typed paragraph synchronized')
 const saved=await requestCoordinatedSave(provider,await checkpointDigest(jsonToSnapshot(store.project().toJSON())),undefined,30000,await imageDraftDigest(document));assert.equal(saved.status,'saved',JSON.stringify(saved));assert.equal(saved.pending,false)
 const response=await fetch(config.origin+'/v1/documents/doc/references',{headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config.alice}`}});assert.equal(response.status,200);const refs=await response.json();assert.deepEqual(refs.items.map((item:any)=>item.reference.mentionId).sort(),original);assert.equal(refs.transition.events.length,0);assert.equal(refs.reminders.enabled,false)
 await writeFile(config.root+'/socket-evidence.json',JSON.stringify({existingReferencesPreserved:true,missingDirectoryDidNotBlockUnrelatedSave:true,savedRevision:saved.revision,unchangedReferencesProduceNoEvents:true,notificationsDisabled:true}));console.log('PASS existing reference atoms survive a real structural room save with no people directory')
 // The candidate source authorizes targets per actual occurrence author, not
 // whichever editor presses Save or any other contributor in the batch.
 const people={schemaVersion:'hcd-people/1',generation:2,people:[{id:'person-a',label:'Same Name',detail:'Alpha',active:true,visibleTo:['alice'],mentionableBy:['alice']},{id:'person-b',label:'Same Name',detail:'Beta',active:true,visibleTo:['bob'],mentionableBy:['bob']}]}
 await writeFile(config.root+'/people/doc.json',JSON.stringify(people))
 bobDoc=new Y.Doc();const bobStore=new SemanticBlockStore(bobDoc,schema)
 bob=new HocuspocusProvider({url:nodeEditCollaborationUrl(`ws://127.0.0.1:${config.collabPort}`),name:`doc:${authority.collaborationEpoch}:structure3:save4`,document:bobDoc,token:config.bob,WebSocketPolyfill:WebSocket})
 await until(()=>bob!.isSynced&&bobStore.initialized&&!bob!.hasUnsyncedChanges,'Bob joined')
 const mention=(id:string,target:string)=>({type:'hcd.mention',version:1,mentionId:`m_${id.repeat(32)}`,target:{kind:'person',id:target},snapshot:{label:'Same Name'}})
 const add=(store:SemanticBlockStore,id:string,target:string)=>store.insert([schema.node('paragraph',null,schema.nodes.hcdMention.createChecked({reference:mention(id,target)}))],null)[0]
 const ids=(store:SemanticBlockStore)=>jsonToSnapshot(store.project().toJSON()).flatMap(block=>block.content.inlines).filter(inline=>inline.reference).map(inline=>inline.reference!.mentionId)
 const readRefs=async()=>{const response=await fetch(config.origin+'/v1/documents/doc/references',{headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config.alice}`}});assert.equal(response.status,200);return response.json()}
 const save=async(peer:HocuspocusProvider,doc:Y.Doc,store:SemanticBlockStore)=>requestCoordinatedSave(peer,await checkpointDigest(jsonToSnapshot(store.project().toJSON())),undefined,30000,await imageDraftDigest(doc))
 const a=add(store,'a','person-a');await until(()=>!provider!.hasUnsyncedChanges&&ids(bobStore).includes(mention('a','person-a').mentionId),'Alice mention synchronized')
 const b=add(bobStore,'b','person-b');await until(()=>!bob!.hasUnsyncedChanges&&ids(store).includes(mention('b','person-b').mentionId),'Bob mention synchronized')
 assert.equal((await save(provider,document,store)).status,'saved')
 let committed=await readRefs();const byId=new Map(committed.transition.events.map((event:any)=>[event.mentionId,event.context.actorId]));assert.equal(byId.get(mention('a','person-a').mentionId),'alice');assert.equal(byId.get(mention('b','person-b').mentionId),'bob');assert.equal(committed.items.length,4)
 const boundRevision=committed.revision,bad=add(bobStore,'c','person-a');await until(()=>!bob!.hasUnsyncedChanges&&ids(store).includes(mention('c','person-a').mentionId),'unauthorized mention synchronized')
 store.insert([schema.node('paragraph',null,schema.text('Alice unrelated input'))],null);await until(()=>!provider!.hasUnsyncedChanges,'unrelated authorized input synchronized')
 assert.equal((await save(provider,document,store)).status,'failed');assert.equal((await readRefs()).revision,boundRevision)
 bobStore.remove([bad]);await until(()=>!bob!.hasUnsyncedChanges&&!ids(store).includes(mention('c','person-a').mentionId),'bad draft removed');assert.equal((await save(provider,document,store)).status,'saved')
 const ownHistory=bobStore.undoManager();ownHistory.stopCapturing();bobStore.remove([b]);await until(()=>!bob!.hasUnsyncedChanges&&!ids(store).includes(mention('b','person-b').mentionId),'Bob removed own reference');assert.equal((await save(provider,document,store)).status,'saved');committed=await readRefs();assert.equal(committed.transition.events[0].kind,'reference.removed');assert.equal(committed.transition.events[0].context.actorId,'bob')
 ownHistory.undo();await until(()=>!bob!.hasUnsyncedChanges&&ids(store).includes(mention('b','person-b').mentionId),'Bob undid committed removal');assert.equal((await save(provider,document,store)).status,'saved');committed=await readRefs();assert.equal(committed.transition.events[0].context.actorId,'bob');assert.equal(committed.transition.events[0].mentionId,mention('b','person-b').mentionId);ownHistory.destroy()
 for(const format of ['docx','pdf','md']){const response=await fetch(config.origin+`/v1/documents/doc/export/${format}?revision=${committed.revision}`,{headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config.alice}`}});assert.equal(response.status,200);await writeFile(config.root+`/collaborative-mentions.${format}`,new Uint8Array(await response.arrayBuffer()))}
 const evidence={newReferencesSavedThroughRealSocket:true,distinctOccurrenceAuthorsInOneCommit:true,unauthorizedReferenceCannotBorrowAnotherContributor:true,committedDeletionAttributed:true,ownUndoResurrectsStableIdentity:true,collaborativeExportRevision:committed.revision,notificationsDisabled:committed.reminders.enabled===false}
 await writeFile(config.root+'/collaborative-reference-evidence.json',JSON.stringify(evidence))
 // Return the original offline-export fixture, preserving its existing identities.
 store.remove([a]);await until(()=>!provider!.hasUnsyncedChanges&&!ids(bobStore).includes(mention('a','person-a').mentionId),'Alice cleanup synchronized');bobStore.remove([b]);await until(()=>!bob!.hasUnsyncedChanges&&!ids(store).includes(mention('b','person-b').mentionId),'Bob cleanup synchronized');assert.equal((await save(provider,document,store)).status,'saved')
 const {unlink}=await import('node:fs/promises');await unlink(config.root+'/people/doc.json')
 console.log('PASS per-occurrence authors, denied-target isolation, committed own undo and real collaborative export')

}finally{bob?.destroy();bobDoc?.destroy();provider?.destroy();document?.destroy();child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',()=>resolve());setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL')},3000).unref()});await log.close()}
