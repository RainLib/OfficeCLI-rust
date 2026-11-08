import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
/** Two actual Hocuspocus peers, native API and the production history adapter. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {TiptapTransformer} from '../examples/hdoc/editor/node_modules/@hocuspocus/transformer/dist/hocuspocus-transformer.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {CollaborativeImageDraftStore,imageDraftDigest,imageReceiptMap} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {SemanticHistory} from '../examples/hdoc/editor/src/semanticHistory.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {api,type Session} from '../examples/hdoc/editor/src/api.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8'))
const session=(token:string):Session=>({documentId:'doc',format:'docx',scope:'write',token,apiUrl:config.apiUrl,collabUrl:config.collabUrl})
const alice=session(config.alice),bob=session(config.bob),a=new Y.Doc(),b=new Y.Doc()
const sa=new CollaborativeImageDraftStore(a),sb=new CollaborativeImageDraftStore(b),detach=[sa.connect(),sb.connect()]
const reader=async(id:string,signal:AbortSignal)=>(await api(alice,`/images/${id}`,{signal})).json()
const history=new SemanticHistory(sa,new Y.UndoManager(a.getXmlFragment('default')),()=>sa.saving,reader);detach.push(history.connect())
const clients=[a,b].map((doc,index)=>new HocuspocusProvider({url:nodeEditCollaborationUrl(config.collabUrl),name:'doc:0:typography2:save4',document:doc,token:index?config.bob:config.alice,WebSocketPolyfill:WebSocket}))
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(predicate:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+20_000;while(Date.now()<end){if(await predicate())return;await pause(30)}throw new Error(`Timeout: ${label}`)}
const picture=async(actor=alice)=>(await(await api(actor,'/images')).json()).entries[0]
const head=async()=>(await(await api(alice,'')).json()).revision as number
const leaf=(doc:Y.Doc)=>{let found:Y.XmlText|undefined;const walk=(node:any)=>{if(found)return;if(node instanceof Y.XmlText){found=node;return}for(const child of node.toArray?.()??[])walk(child)};walk(doc.getXmlFragment('default'));assert.ok(found);return found}
async function save(index:number){const doc=index?b:a,provider=clients[index];await until(()=>!provider.hasUnsyncedChanges,'send updates');const reply=await requestCoordinatedSave(provider,await checkpointDigest(jsonToSnapshot(TiptapTransformer.fromYdoc(doc,'default'))),undefined,20_000,await imageDraftDigest(doc));assert.equal(reply.status,'saved',JSON.stringify(reply));return reply.revision!}
async function exportVersion(name:string,revision:number){await writeFile(config.root+`/${name}.docx`,Buffer.from(await(await api(alice,`/export/docx?revision=${revision}`)).arrayBuffer()))}
const result:any={schemaVersion:'hcd-semantic-history-evidence/1',format:'docx',phases:[]}
try{
 await until(()=>clients.every(client=>client.isSynced),'both peers synced')
 const original=await picture();result.original=original
 const text=leaf(a),attributes=text.toDelta()[0]?.attributes
 a.transact(()=>text.insert(0,'Own 中文😀 ',attributes))
 sa.edit(original,1,{...original.geometry,width:original.geometry.width*1.3},undefined,'width')
 const asset=await(await api(alice,'/staged-assets?extension=png',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:await readFile(config.root+'/red.png')})).json()
 const upload=sa.prepareReplacement(original,1);upload.commit(asset.hash);upload.finish();result.editedAsset=asset.hash
 const own=await save(0);assert.equal(own,2)
 // A stays open, retaining its own timeline, while disconnected during B's edit.
 clients[0].disconnect();await until(()=>!clients[0].configuration.websocketProvider.webSocket,'disconnect A')
 await until(()=>!!(b.getMap(imageReceiptMap).get(original.nodeId) as any)?.revision,'peer receipt')
 const peerBase=await picture(bob),peerText=leaf(b)
 b.transact(()=>peerText.insert(peerText.length,' Peer!',peerText.toDelta().at(-1)?.attributes))
 sb.edit(peerBase,own,{...peerBase.geometry,height:peerBase.geometry.height*1.5},undefined,'height')
 const peer=await save(1);assert.equal(peer,3)
 await clients[0].connect();await until(()=>clients[0].isSynced&&(a.getMap(imageReceiptMap).get(original.nodeId) as any)?.revision>=peer,'A reconnects to saved peer version')
 result.peerHeight=(await picture()).geometry.height
 for(const [name,index] of [['undo-resource',0],['undo-width',1],['undo-text',2]] as const){
  await history.step('undo');const revision=await save(0);await exportVersion(name,revision)
  const image=await picture();result.phases.push({name,revision,image,text:leaf(a).toString()})
  assert.equal(image.geometry.height,result.peerHeight)
  if(index>=1)assert.equal(image.geometry.width,original.geometry.width)
  assert.equal(image.assetHash,original.assetHash)
  assert.ok(leaf(a).toString().includes('Peer!'))
 }
 assert.ok(leaf(a).toString().includes('Original'));assert.ok(!leaf(a).toString().includes('Own'))
 for(const name of ['redo-text','redo-width','redo-resource']){
  await history.step('redo');const revision=await save(0);await exportVersion(name,revision)
  const image=await picture();result.phases.push({name,revision,image,text:leaf(a).toString()});assert.equal(image.geometry.height,result.peerHeight)
 }
 const restored=await picture();assert.equal(restored.assetHash,asset.hash);assert.equal(restored.geometry.width,original.geometry.width*1.3);assert.ok(leaf(a).toString().includes('Own'));assert.ok(leaf(a).toString().includes('Peer!'))
 // A later peer change of the same resource must not be overwritten by old undo.
 const green=await(await api(bob,'/staged-assets?extension=png',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:await readFile(config.root+'/green.png')})).json()
 const nextUpload=sb.prepareReplacement(await picture(bob),await head());nextUpload.commit(green.hash);nextUpload.finish();const peerResourceRevision=await save(1)
 await until(()=>(a.getMap(imageReceiptMap).get(original.nodeId) as any)?.revision>=peerResourceRevision,'new peer resource receipt')
 await assert.rejects(history.step('undo'),/historyConflict/);assert.equal(sa.size,0);assert.equal(await head(),peerResourceRevision)
 result.savedConflictBlocked=true;result.reconnectPreservedHistory=true;result.peerTextPreserved=true
 // Concurrent offline choices stay as candidates; choosing one is itself undoable.
 await until(()=>(b.getMap(imageReceiptMap).get(original.nodeId) as any)?.revision>=peerResourceRevision,'both peers current')
 clients.forEach(client=>client.disconnect())
 const conflictBase=await picture()
 sa.replace(conflictBase,peerResourceRevision,asset.hash);sb.replace(conflictBase,peerResourceRevision,original.assetHash)
 await Promise.all(clients.map(client=>client.connect()))
 await until(()=>!!sa.get(original.nodeId)?.alternatives?.length,'conflicting resource candidates')
 const option=sa.get(original.nodeId)!.alternatives!.find(choice=>choice.assetHash===original.assetHash)!
 assert.ok(option);sa.resolveVariant(original.nodeId,option.intentId)
 for(const [name,direction] of [['choice',null],['undo-choice','undo'],['redo-choice','redo']] as const){
  if(direction)await history.step(direction)
  const revision=await save(0);await exportVersion(name,revision);const image=await picture()
  assert.equal(image.assetHash,name==='undo-choice'?asset.hash:original.assetHash)
  assert.equal(image.geometry.height,result.peerHeight)
  result.phases.push({name,revision,image,text:leaf(a).toString()})
 }
 result.candidateChoiceSavedUndoRedo=true;result.finalRevision=await head()
 await writeFile(config.root+'/semantic-history-evidence.json',JSON.stringify(result,null,2)+'\n')
 console.log('PASS native API + two Hocuspocus peers: mixed saved undo/redo, peer fields/text, reconnect and same-field conflict')
}finally{history.dispose();for(const cleanup of detach)cleanup();for(const client of clients)client.destroy();a.destroy();b.destroy()}
