import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {schemaExtensions,jsonToSnapshot,sourceIdentityPlugin} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {extensionNodes,extensionPreservationPlugin} from '../examples/hdoc/editor/src/extensionNode.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {nodePortableFixture} from '../examples/hdoc/editor/fixtures/nodePortable.ts'
import {deletionReviews} from '../examples/hdoc/editor/src/deletionReview.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),mode=process.argv[3]??'prepare',isLate=mode.startsWith('late'),base=c.origin+'/v1/documents/mentions-docx',headers={Authorization:'Bearer '+c.alice,'X-HCD-Node-Edits-Version':'5'},schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),registry=new NodeExtensionRegistry(nodePortableFixture)
async function info(path=''){const response=await fetch(base+path,{headers});assert.equal(response.status,200);return response.json()}
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25))}throw Error('Timeout '+label)}
const response=await fetch(`http://127.0.0.1:${c.ports[1]}/v1/documents/mentions-docx/collaboration/negotiate`,{method:'POST',headers});assert.equal(response.status,200);const auth=await response.json();assert.equal(auth.nodeEditVersion,5)
const name=`mentions-docx:${auth.collaborationEpoch}:structure3:save4`,url=nodeEditCollaborationUrl(`ws://127.0.0.1:${c.ports[1]}`),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema)
if(isLate)Y.applyUpdate(b,new Uint8Array(await readFile(c.root+'/deletion-offline.bin')))
const pa=new HocuspocusProvider({url,name,document:a,token:c.alice,WebSocketPolyfill:WebSocket});let pb:HocuspocusProvider|undefined
const input=(store:SemanticBlockStore,label:string)=>{const doc=store.project();let position=-1;doc.descendants((node,at)=>{if(node.isTextblock&&node.textContent.startsWith('子段落甲：')&&position<0)position=at+1+node.content.size});assert.ok(position>0);const state=EditorState.create({schema,doc,plugins:[extensionPreservationPlugin(()=>{},()=>registry),sourceIdentityPlugin()]}),next=state.applyTransaction(state.tr.insertText(label,position)).state.doc;store.reconcile(store.blocks(),next.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}
const save=async(provider:HocuspocusProvider,store:SemanticBlockStore)=>{await until(()=>!provider.hasUnsyncedChanges,'ack');return requestCoordinatedSave(provider,await checkpointDigest(jsonToSnapshot(store.project().toJSON())),undefined,45000,await imageDraftDigest(store.document))}
try{
 await until(()=>pa.isSynced&&sa.initialized&&!pa.hasUnsyncedChanges,'Alice synced');const head=(await info()).revision;assert.equal(head,mode==='prepare'?6:mode==='second'?8:9)
 if(!isLate){
  pb=new HocuspocusProvider({url,name,document:b,token:c.bob,WebSocketPolyfill:WebSocket});await until(()=>pb!.isSynced&&sb.initialized&&!pb!.hasUnsyncedChanges,'Bob synced');pb.disconnect();await until(()=>pb!.configuration.websocketProvider.status==='disconnected','Bob offline');await writeFile(c.root+'/deletion-offline.bin',Y.encodeStateAsUpdate(b),{mode:0o600})
  const block=sa.blocks().find(block=>block.node.attrs.extension?.type==='example.rich_callout'&&block.node.attrs.extension.data.title==='团队记录')!;assert.ok(block);sa.remove([block.key]);assert.equal(deletionReviews(sa).length,0);const saved=await save(pa,sa);assert.equal(saved.status,'saved',JSON.stringify(saved));assert.equal(saved.revision,head+1);assert.equal(saved.pending,false)
  input(sb,mode==='prepare'?' · Bob 删除后离线输入':' · Bob 第二次离线输入');pb.connect()
 }else{input(sb,mode==='late'?' · Bob 迟到复核输入':' · Bob 确认后再到输入');pb=new HocuspocusProvider({url,name,document:b,token:c.bob,WebSocketPolyfill:WebSocket})}
 await until(()=>pb!.isSynced&&!pb!.hasUnsyncedChanges&&deletionReviews(sa).length===1&&deletionReviews(sb).length===1,'hidden late edit converged');const expected=isLate?head:head+1,reply=await save(pb!,sb);assert.equal(reply.status,'failed',JSON.stringify(reply));assert.equal(reply.problem,'deletion-drafts-conflict');assert.equal(reply.pending,true);assert.equal((await info()).revision,expected)
 const reviews=deletionReviews(sa),current=reviews[0];assert.match(current.node.textContent,/Bob/);await writeFile(c.root+'/deletion-blocked-'+mode+'.bin',Y.encodeStateAsUpdate(a),{mode:0o600});const evidence={mode,scope:'Actual authenticated WebSockets + native coordinator, no browser claim',nativeHead:expected,reply,hiddenNode:current.node.toJSON(),review:{key:current.key,receiptId:current.receipt?.id,snapshot:current.snapshot},nodeCount:extensionNodes(sa.project()).size,allHiddenContentStillPresent:true}
 await writeFile(c.root+'/deletion-'+mode+'.json',JSON.stringify(evidence,null,2)+'\n');console.log('PASS',mode,'late hidden edits retained; coordinator refuses canonical save at r'+expected)
}finally{pa.disconnect();pa.destroy();await pa.configuration.websocketProvider.destroy();if(pb){pb.disconnect();pb.destroy();await pb.configuration.websocketProvider.destroy()}a.destroy();b.destroy()}
