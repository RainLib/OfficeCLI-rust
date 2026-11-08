/** Real local inline1 room and native saves. This is not browser automation. */
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {getSchema,type Editor} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {EditorState,type Transaction} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {SemanticInlineContainerNode} from '../examples/hdoc/editor/src/semanticInlineNode.ts'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {InlineContainerRegistry} from '../examples/hdoc/editor/src/inlineContainerRegistry.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {retargetReference,chooseReferenceCandidate,canEditReference} from '../examples/hdoc/editor/src/referenceCommands.ts'
import {documentReferences,referenceEditIndex} from '../examples/hdoc/editor/src/referenceEdits.ts'
import {inlineCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2])
assert.equal(dirname(root),repo+'/target/hcd-preview-runtime');assert.ok(root.endsWith('hcd-inline-editor-riw31kza'),'Dedicated fixture required; never run against the unfinished resource UI room')
const config=JSON.parse(await readFile(root+'/private.json','utf8')),base=`http://127.0.0.1:${config.ports[0]}/v1/documents/inline-native`,sidecar=`http://127.0.0.1:${config.ports[1]}`,schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity])
const headers={Authorization:'Bearer '+config.tokens.alice,'X-HCD-Node-Edits-Version':'7','X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3','X-HCD-Custom-Marks-Version':'1'}
const assets=repo+'/docs/assets/hcd-inline-reference-retarget-2026-10-27';await mkdir(assets,{recursive:true})
const people=JSON.parse(await readFile(root+'/people/inline-native.json','utf8'));people.generation++;people.people=people.people.filter((v:any)=>v.id!=='carol');people.people.push({id:'carol',label:'Carol 陈',active:true});await writeFile(root+'/people/inline-native.json',JSON.stringify(people))
async function json(route:string){const response=await fetch(base+route,{headers,signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,route);return response.json()}
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,40))}throw Error('Timeout '+label)}
const negotiation=await fetch(sidecar+'/v1/documents/inline-native/collaboration/negotiate',{method:'POST',headers});assert.equal(negotiation.status,200,await negotiation.clone().text());const auth=await negotiation.json();assert.equal(auth.nodeEditVersion,7)
console.log('Negotiated inline1 epoch',auth.collaborationEpoch)
const adapter=({data}:{data:Record<string,unknown>})=>({support:'semantic' as const,includeContent:true,blocks:[{kind:'paragraph' as const,runs:[{text:data.title+': '}]}]})
const registry=new InlineContainerRegistry([{type:'example.ui_field',version:1,display:'inline',contentModel:'inline',label:'Field',defaultData:{title:'Field'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title),exportAdapters:{docx:adapter,pdf:adapter,pptx:adapter,md:adapter}}]),ordinary=new NodeExtensionRegistry(),release=registry.connect()
const clients:Array<{document:Y.Doc;provider:HocuspocusProvider;store:SemanticBlockStore;editor:Editor}>=[]
function client(user:'alice'|'bob'){
 const document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true}),provider=new HocuspocusProvider({url:inlineCollaborationUrl(`ws://127.0.0.1:${config.ports[1]}`),name:`inline-native:${auth.collaborationEpoch}:inlinecontainers1:save4`,document,token:config.tokens[user],WebSocketPolyfill:WebSocket})
 // Only the DOM shell is absent. The exact production command performs the
 // reference check, and the real model binding reconciliation creates intents.
 const editor={isDestroyed:false,isEditable:true,get state(){return EditorState.create({schema,doc:store.project()})},view:{composing:false,dispatch(tr:Transaction){store.reconcile(store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}}} as unknown as Editor
 const value={document,provider,store,editor};clients.push(value);return value
}
const a=client('alice'),b=client('bob'),mention='m_32ff10a0d643474bbf1338cc7eaaf5c6',inner='x_a357e63c178742a4a1d1e43a6590605f'
let history:ReturnType<SemanticBlockStore['undoManager']>|undefined
try{
 await until(()=>clients.every(c=>c.provider.isSynced&&c.store.initialized&&!c.provider.hasUnsyncedChanges),'two authenticated inline clients')
 console.log('Two clients initialized')
 const before=await json('');assert.equal(before.revision,26)
 const original=documentReferences(a.store.project()).get(mention)!.reference;assert.equal(original.target.id,'bob')
 assert.ok(canEditReference(a.editor,ordinary,mention,registry));assert.equal(canEditReference(a.editor,ordinary,mention),false)
 a.provider.disconnect();b.provider.disconnect();await until(()=>clients.every(c=>c.provider.configuration.websocketProvider.status==='disconnected'),'offline peers')
 console.log('Peers disconnected for concurrent target changes')
 assert.ok(retargetReference(a.editor,a.store,ordinary,original,{kind:'person',id:'alice',label:'Alice 王'},registry))
 assert.ok(retargetReference(b.editor,b.store,ordinary,original,{kind:'person',id:'carol',label:'Carol 陈'},registry))
 b.store.flow.containers!.bodies.get(inner)!.insert(0,'Socket peer ')
 console.log('Concurrent local changes created')
 a.provider.connect();b.provider.connect()
 const settled=()=>clients.every(c=>c.provider.isSynced&&!c.provider.hasUnsyncedChanges)
 await until(()=>settled()&&clients.every(c=>referenceEditIndex(c.document).get(mention)?.conflicted===true)&&a.store.project().textContent.includes('Socket peer '),'full candidates and peer content')
 console.log('Candidates converged')
 async function save(){await until(settled,'packets flushed');return requestCoordinatedSave(a.provider,await checkpointDigest(jsonToSnapshot(a.store.project().toJSON(),{inlineContainers:true})),undefined,45000,await imageDraftDigest(a.document))}
 const denied=await save();assert.equal(denied.problem,'reference-drafts-conflict');assert.equal((await json('')).revision,26)
 const group=referenceEditIndex(a.document).get(mention)!,candidate=group.candidates.find(v=>v.after.target.id==='carol')!;assert.ok(candidate);assert.equal(group.candidates.length,2)
 history=a.store.undoManager(false);assert.ok(chooseReferenceCandidate(a.editor,a.store,ordinary,{mentionId:mention,ids:group.ids,candidateId:candidate.id},registry))
 await until(()=>settled()&&documentReferences(b.store.project()).get(mention)?.reference.target.id==='carol','resolved peer target')
 const saved=await save();assert.equal(saved.status,'saved',JSON.stringify(saved));assert.equal(saved.pending,false);assert.equal(saved.revision,27)
 history.undo();await until(()=>settled()&&referenceEditIndex(b.document).get(mention)?.conflicted===true,'undo restores candidates')
 const undoDenied=await save();assert.equal(undoDenied.problem,'reference-drafts-conflict');assert.equal((await json('')).revision,27)
 history.redo();await until(()=>settled()&&!referenceEditIndex(b.document).get(mention)?.conflicted,'redo resolves candidates')
 const redone=await save();assert.equal(redone.status,'saved',JSON.stringify(redone));assert.equal(redone.pending,false);assert.equal(redone.revision,27)
 const refs=await json('/references?revision=27&locations=true'),entry=refs.items.find((v:any)=>v.reference.mentionId===mention);assert.equal(entry.reference.target.id,'carol');assert.equal(entry.reference.snapshot.label,'Carol 陈');assert.deepEqual(entry.inlinePath,[0,1]);assert.equal(refs.reminders.enabled,false)
 assert.equal(refs.transition.events.length,1);assert.equal(refs.transition.events[0].kind,'reference.retargeted');assert.equal(refs.transition.events[0].context.actorId,'alice')
 const current=a.store.project().toJSON()
 const fresh=client('alice');await until(()=>fresh.provider.isSynced&&fresh.store.initialized,'fresh room client');assert.deepEqual(fresh.store.project().toJSON(),current)
 assert.equal(documentReferences(fresh.store.project()).get(mention)!.reference.target.id,'carol');assert.match(fresh.store.project().textContent,/Socket peer/)
 await writeFile(assets+'/references-r27.json',JSON.stringify(refs,null,2)+'\n')
 await writeFile(assets+'/socket-evidence.json',JSON.stringify({scope:'Actual native API, production sidecar and real authenticated sockets; production reference commands with no DOM shell. No browser or physical-device claim.',fixture:root,head:27,mentionId:mention,inlinePath:entry.inlinePath,candidates:group.candidates.map(v=>v.after),savedResolver:'alice',undoReopensConflict:true,redoNoExtraRevision:true,freshClientExact:true,peerBodyRetained:true,remindersSent:false},null,2)+'\n')
 console.log('PASS inline nested retarget/candidates, save gate, personal undo/redo, r27 native event identity and fresh socket projection')
}finally{history?.destroy();release();for(const c of clients){c.provider.destroy();await c.provider.configuration.websocketProvider.destroy();c.document.destroy()}}
