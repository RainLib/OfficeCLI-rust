import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {Fragment} from '../examples/hdoc/editor/node_modules/@tiptap/pm/model/index.ts'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {extensionNodes} from '../examples/hdoc/editor/src/extensionNode.ts'
import {documentReferences} from '../examples/hdoc/editor/src/referenceEdits.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {nodePortableFixture} from '../examples/hdoc/editor/fixtures/nodePortable.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),verify=process.argv[3]==='verify',initial=JSON.parse(await readFile(c.root+'/business-initial-evidence.json','utf8')),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),registry=new NodeExtensionRegistry(nodePortableFixture),base=c.origin+'/v1/documents/mentions-docx',headers={Authorization:'Bearer '+c.bob,'X-HCD-Node-Edits-Version':'4'}
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50))}throw Error('Timeout '+label)}
async function json(path:string){const r=await fetch(base+path,{headers,signal:AbortSignal.timeout(45000)});assert.equal(r.status,200,await r.clone().text());return r.json()}
// Source receipts arrive after the save response; compare user content and
// occurrence identities here. Native/offline projections are compared exactly
// in hcd-undo-review-files.py, including their committed source identities.
function withoutSourceReceipts(snapshot:any[]){const content=(value:any):any=>({...value,inlines:value.inlines.map(({nodeId:_receipt,...inline}:any)=>inline),...(value.children?{children:value.children.map(content)}:{})});return snapshot.map(block=>({...block,content:content(block.content)}))}
const response=await fetch(`http://127.0.0.1:${c.ports[1]}/v1/documents/mentions-docx/collaboration/negotiate`,{method:'POST',headers});assert.equal(response.status,200);const auth=await response.json();assert.equal(auth.nodeEditVersion,4)
const document=new Y.Doc(),store=new SemanticBlockStore(document,schema),provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(`ws://127.0.0.1:${c.ports[1]}`),name:`mentions-docx:${auth.collaborationEpoch}:structure3:save4`,document,token:c.bob,WebSocketPolyfill:WebSocket})
try{
 await until(()=>provider.isSynced&&store.initialized&&!provider.hasUnsyncedChanges,'Bob socket synced');assert.equal((await json('')).revision,verify?8:7)
 const originals=new Set(initial.nodes.map((node:any)=>node.instanceId)),nodes=extensionNodes(store.project()),fresh=[...nodes.values()].filter(entry=>!originals.has(entry.value.instanceId));assert.equal(nodes.size,9);assert.equal(fresh.length,3)
 for(const node of initial.nodes)assert.deepEqual(nodes.get(node.instanceId)!.value,node)
 if(!verify){
  const clone=fresh.find(entry=>entry.value.type==='example.rich_callout'&&entry.value.data.title==='团队记录')!,before=store.project().nodeAt(clone.position)!,key=before.attrs.hcdStructureKey
  const transform=(node:typeof before):typeof before=>{
   if(node.type.name==='hcdExtensionInline')return node.type.createChecked({...node.attrs,extension:registry.update(node.attrs.extension,{title:'Bob 审阅资料'})},null,node.marks)
   if(node.type.name==='hcdMention')return node.type.createChecked({...node.attrs,reference:{...node.attrs.reference,target:{kind:'person',id:'bob'},snapshot:{label:'Bob 李'}}},null,node.marks)
   let content=Fragment.fromArray(node.content.content.map(transform));if(node.isTextblock&&node.textContent==='嵌套正文')return schema.nodes.heading.createChecked({...node.attrs,level:2},content.append(Fragment.from(schema.text(' · Bob 同伴新增正文',[schema.marks.bold.create()]))))
   return node.copy(content)
  }
  const transformed=transform(before),next=transformed.type.createChecked({...transformed.attrs,extension:registry.update(before.attrs.extension,{title:'Bob 协作副本'})},transformed.content.append(Fragment.from(schema.nodes.paragraph.createChecked(null,[schema.text('Bob 新增子块')]))))
  store.update(key,before,next);await until(()=>!provider.hasUnsyncedChanges,'Bob changes acknowledged');const reply=await requestCoordinatedSave(provider,await checkpointDigest(jsonToSnapshot(store.project().toJSON())),undefined,45000,await imageDraftDigest(document));assert.equal(reply.status,'saved',JSON.stringify(reply));assert.equal(reply.revision,8);assert.equal(reply.pending,false)
  await writeFile(c.root+'/undo-review-socket.json',JSON.stringify({scope:'Actual authenticated Bob WebSocket changes a browser-created copy, then coordinated native save. Browser undo/cancel/skip verified separately.',revision:8,cloneId:clone.value.instanceId,newIds:fresh.map(entry=>entry.value.instanceId),originalIds:[...originals],snapshot:jsonToSnapshot(store.project().toJSON()),checks:{originalEnvelopesUnchanged:true,newPeerText:true,headingAndBold:true,inlineProperty:true,referenceTarget:true,newChild:true}},null,2)+'\n')
 }else{
  const saved=JSON.parse(await readFile(c.root+'/undo-review-socket.json','utf8'));assert.deepEqual(withoutSourceReceipts(jsonToSnapshot(store.project().toJSON())),withoutSourceReceipts(saved.snapshot));assert.match(store.project().textContent,/Bob 同伴新增正文/);assert.match(store.project().textContent,/Bob 新增子块/);assert.equal(documentReferences(store.project()).size,2);assert.equal((await json('')).revision,8)
 }
 console.log('PASS',verify?'live projection and canonical r8 unchanged after browser review':'Bob text, formatting, business properties, reference and new child saved r8')
}finally{provider.disconnect();provider.destroy();await provider.configuration.websocketProvider.destroy();document.destroy()}
