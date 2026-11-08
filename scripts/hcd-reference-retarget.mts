import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {referenceEditIndex,documentReferences} from '../examples/hdoc/editor/src/referenceEdits.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),base=c.origin+'/v1/documents/mentions-docx',headers={Authorization:'Bearer '+c.alice,'X-HCD-Node-Edits-Version':'4'},schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),id='m_'+'a'.repeat(32)
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50))}throw Error('Timeout '+label)}
async function info(){const response=await fetch(base,{headers});assert.equal(response.status,200);return response.json()}
const negotiated=await fetch(`http://127.0.0.1:${c.ports[1]}/v1/documents/mentions-docx/collaboration/negotiate`,{method:'POST',headers});assert.equal(negotiated.status,200,await negotiated.clone().text());const auth=await negotiated.json();assert.equal(auth.nodeEditVersion,4)
const a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema),url=nodeEditCollaborationUrl(`ws://127.0.0.1:${c.ports[1]}`),name=`mentions-docx:${auth.collaborationEpoch}:structure3:save4`,pa=new HocuspocusProvider({url,name,document:a,token:c.alice,WebSocketPolyfill:WebSocket}),pb=new HocuspocusProvider({url,name,document:b,token:c.bob,WebSocketPolyfill:WebSocket})
function reconcile(store:SemanticBlockStore,doc:ReturnType<SemanticBlockStore['project']>){store.reconcile(store.blocks(),doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}
function retarget(store:SemanticBlockStore,target:string,label:string){const doc=store.project(),entry=documentReferences(doc).get(id)!;assert.ok(entry);const node=doc.nodeAt(entry.position)!;reconcile(store,EditorState.create({schema,doc}).tr.setNodeMarkup(entry.position,undefined,{...node.attrs,reference:{...entry.reference,target:{kind:'person',id:target},snapshot:{label}}}).doc)}
try{
 await until(()=>pa.isSynced&&pb.isSynced&&sa.initialized&&sb.initialized&&!pa.hasUnsyncedChanges&&!pb.hasUnsyncedChanges,'two authenticated sockets ready');assert.equal((await info()).revision,2);assert.equal(documentReferences(sa.project()).size,2)
 pa.disconnect();pb.disconnect();await until(()=>pa.configuration.websocketProvider.status==='disconnected'&&pb.configuration.websocketProvider.status==='disconnected','offline replicas')
 retarget(sa,'alice','Alice 王');retarget(sb,'bob','Bob 李');let position=-1;const doc=sb.project();doc.descendants((node,at)=>{if(node.isTextblock&&node.textContent==='Original')position=at+1+node.content.size});assert.ok(position>=0);reconcile(sb,EditorState.create({schema,doc}).tr.insertText(' · Bob 并发正文',position).doc)
 pa.connect();pb.connect();await until(()=>pa.isSynced&&pb.isSynced&&!pa.hasUnsyncedChanges&&!pb.hasUnsyncedChanges&&referenceEditIndex(a).get(id)?.conflicted===true&&referenceEditIndex(b).get(id)?.conflicted===true&&sa.project().textContent.includes('Bob 并发正文'),'candidate and text convergence')
 assert.ok(sa.project().eq(sb.project()));assert.equal(documentReferences(sa.project()).size,2)
 const reply=await requestCoordinatedSave(pa,await checkpointDigest(jsonToSnapshot(sa.project().toJSON())),undefined,45000,await imageDraftDigest(a));assert.equal(reply.nodeEditVersion,4);assert.equal(reply.problem,'reference-drafts-conflict');assert.equal((await info()).revision,2)
 const group=referenceEditIndex(a).get(id)!;assert.equal(group.candidates.length,2);await mkdir('docs/assets/hcd-reference-intents-2026-10-25',{recursive:true});await writeFile('docs/assets/hcd-reference-intents-2026-10-25/socket-evidence.json',JSON.stringify({scope:'Two actual authenticated local WebSockets, offline edits and coordinated save refusal; no browser clicks or production claim.',root:c.root,revision:2,mentionId:id,candidates:group.candidates.map(edit=>({id:edit.id,reference:edit.after})),ids:group.ids,checks:{oneOccurrencePreserved:true,twoFullCandidatesRetained:true,peerBodyRetained:true,saveRefusedWithoutHeadChange:true}},null,2)+'\n');console.log('PASS real offline retarget candidates, peer body and save gate; head remains r2.')
}finally{pa.disconnect();pb.disconnect();pa.destroy();pb.destroy();await pa.configuration.websocketProvider.destroy();await pb.configuration.websocketProvider.destroy();a.destroy();b.destroy()}
