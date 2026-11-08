import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {schemaExtensions,jsonToSnapshot,sourceIdentityPlugin} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {extensionNodes} from '../examples/hdoc/editor/src/extensionNode.ts'
import {documentReferences} from '../examples/hdoc/editor/src/referenceEdits.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),verify=process.argv[3]==='verify',initial=JSON.parse(await readFile(c.root+'/business-initial-evidence.json','utf8')),base=c.origin+'/v1/documents/mentions-docx',headers={Authorization:'Bearer '+c.bob,'X-HCD-Node-Edits-Version':'4'},schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
async function until(check:()=>boolean,label:string){const end=Date.now()+45000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,50))}throw Error('Timeout '+label)}
const response=await fetch(`http://127.0.0.1:${c.ports[1]}/v1/documents/mentions-docx/collaboration/negotiate`,{method:'POST',headers});assert.equal(response.status,200);const auth=await response.json();assert.equal(auth.nodeEditVersion,4)
const document=new Y.Doc(),store=new SemanticBlockStore(document,schema),provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(`ws://127.0.0.1:${c.ports[1]}`),name:`mentions-docx:${auth.collaborationEpoch}:structure3:save4`,document,token:c.bob,WebSocketPolyfill:WebSocket})
try{
 await until(()=>provider.isSynced&&store.initialized&&!provider.hasUnsyncedChanges,'Bob socket');const head=await(await fetch(base,{headers})).json();assert.equal(head.revision,verify?10:9);const before=extensionNodes(store.project()),oldIds=new Set(initial.nodes.map((n:any)=>n.instanceId));assert.equal(before.size,9);assert.equal(documentReferences(store.project()).size,2);for(const n of initial.nodes)assert.deepEqual(before.get(n.instanceId)!.value,n)
 if(!verify){
 const doc=store.project(),state=EditorState.create({schema,doc,plugins:[sourceIdentityPlugin()]});let end=-1;doc.descendants((node,pos)=>{if(node.isTextblock&&node.textContent==='容器后段')end=pos+1+node.content.size});assert.ok(end>0);const next=state.applyTransaction(state.tr.insertText(' · Bob 在扩展卸载后继续协作',end)).state.doc;store.reconcile(store.blocks(),next.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));await until(()=>!provider.hasUnsyncedChanges,'peer update acknowledgement')
 const reply=await requestCoordinatedSave(provider,await checkpointDigest(jsonToSnapshot(store.project().toJSON())),undefined,45000,await imageDraftDigest(document));assert.equal(reply.status,'saved',JSON.stringify(reply));assert.equal(reply.revision,10);assert.equal(reply.pending,false);assert.deepEqual([...extensionNodes(store.project()).values()].map(entry=>entry.value),[...before.values()].map(entry=>entry.value))
 }
 assert.match(store.project().textContent,/Bob 在扩展卸载后继续协作/)
 await writeFile(c.root+'/codec-history-socket.json',JSON.stringify({scope:verify?'Read-only real authenticated socket after the explicit save failure and subsequent coordinator retry. Confirms current saved content, not the success of the failed request.':'Actual authenticated Bob socket updates ordinary body while Alice has host codecs unloaded, then native coordinated save. Browser registration/undo/redo covered separately.',finalRevision:10,originalIds:[...oldIds],newIds:[...before.keys()].filter(id=>!oldIds.has(id)),nodes:[...before.values()].map(entry=>entry.value),references:[...documentReferences(store.project()).values()].map(entry=>entry.reference),checks:{allNineEnvelopesUnchanged:true,peerBodySaved:true,resourcesAndMentionsRetained:true},...(verify?{initialSaveAnomaly:'The first explicit request returned failed; native checkpoint returned400. A later auto-retry saved the same body as r10. Cause requires independent reproduction; not a clean-save acceptance.'}:{})},null,2)+'\n');console.log('PASS current saved r10 retains Bob body, all nine business envelopes and both references.',verify?'Initial explicit save failure is separately retained, not counted as passed.':'')
}finally{provider.disconnect();provider.destroy();await provider.configuration.websocketProvider.destroy();document.destroy()}
