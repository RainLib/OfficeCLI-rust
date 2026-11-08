import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {EditorState,TextSelection} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {schemaExtensions,projectionToJson,blockIdentityPlugin,sourceIdentityPlugin,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {semanticStructureBinding} from '../examples/hdoc/editor/src/semanticStructureBinding.ts'
import {SemanticSaveCoordinator} from '../examples/hdoc/editor/src/semanticSaveCoordinator.ts'
import {blockTarget,rootBlocks,transformBlocks} from '../examples/hdoc/editor/src/commands/blocks.ts'
import {randomUUID} from 'node:crypto'
import {TiptapTransformer} from '../examples/hdoc/editor/node_modules/@hocuspocus/transformer/dist/hocuspocus-transformer.esm.js'
import {checkpointContents} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')),schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
let currentEpoch=0,currentProtocol:string|undefined
let replyGate:{arrive:()=>void;wait:Promise<void>}|null=null
async function request(route:string,init:RequestInit={}){const response=await fetch(config.apiUrl+route,{...init,signal:init.signal??AbortSignal.timeout(60_000),headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config['hcd-collaboration']}`,'X-HCD-Collaboration-Epoch':String(currentEpoch),...(currentProtocol?{'X-HCD-Collaboration-Protocol':currentProtocol}:{}),...init.headers}});if(route==='/checkpoints'&&!response.ok){const error=await response.clone().text();await writeFile(config.root+'/checkpoint-error.json',JSON.stringify({body:JSON.parse(String(init.body)),error},null,2));console.log(`Native checkpoint rejected: ${error}`)}if(route==='/checkpoints'&&replyGate){const gate=replyGate;replyGate=null;gate.arrive();await gate.wait}return response}
async function json(route:string){const response=await request(route);assert.ok(response.ok,`${route}: ${response.status}`);return response.json()}
function engine(doc:Y.Doc){
 const store=new SemanticBlockStore(doc,schema),errors:unknown[]=[],plugin=semanticStructureBinding(store,{canWrite:()=>true,onError:error=>errors.push(error)})
 let current=EditorState.create({schema,plugins:[blockIdentityPlugin(),sourceIdentityPlugin(),plugin]}),binding:any
 const view={get state(){return current},dispatch(tr:any){const previous=current;current=current.applyTransaction(tr).state;binding?.update?.(view,previous)}}
 binding=plugin.spec.view!(view as any);return{store,errors,get:()=>current,dispatch:view.dispatch,close:()=>binding.destroy?.()}
}
function exchange(a:Y.Doc,b:Y.Doc){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bu);Y.applyUpdate(b,au)}
const a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),projection=await json('/editor')
sa.initialize(schema.nodeFromJSON(projectionToJson(projection)));a.getMap('hcdSchema').set('typography',2);a.getMap('hcdSchema').set('sourceIdentity',1)
const legacy=TiptapTransformer.toYdoc(projectionToJson(projection),'default',schemaExtensions)
legacy.getMap('hcdSchema').set('typography',2);legacy.getMap('hcdSchema').set('sourceIdentity',1)
const legacyBytes=Y.encodeStateAsUpdate(legacy),stored=await request('/collaboration/state',{method:'PUT',headers:{'X-HCD-Coordinator-Version':'4','X-HCD-State-Hash':'none'},body:legacyBytes})
assert.equal(stored.status,200,'legacy source state must be persisted before migration');const sourceHash=(await stored.json()).stateHash
const migrationBytes=Y.encodeStateAsUpdate(a),migrationHeaders={'X-HCD-Coordinator-Version':'4','X-HCD-State-Hash':sourceHash,'X-HCD-Target-Protocol':'hcd-semantic-blocks/3','X-HCD-Base-Revision':String(projection.revision),'X-HCD-Migration-Id':randomUUID().replaceAll('-','')}
const migratedResponse=await request('/collaboration/migrate',{method:'POST',headers:migrationHeaders,body:migrationBytes});assert.equal(migratedResponse.status,200,'clean legacy projection migration must succeed');const migrated=await migratedResponse.json()
currentEpoch=migrated.collaborationEpoch;currentProtocol=migrated.collaborationProtocol
assert.equal(currentEpoch,1);assert.equal(currentProtocol,'hcd-semantic-blocks/3')
const oldWrite=await request('/collaboration/state',{method:'PUT',headers:{'X-HCD-Coordinator-Version':'4','X-HCD-State-Hash':sourceHash,'X-HCD-Collaboration-Epoch':'0'},body:legacyBytes});assert.equal(oldWrite.status,409,'old epoch must be fenced')
const noProtocol=await fetch(config.apiUrl+'/collaboration/state',{headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config['hcd-collaboration']}`,'X-HCD-Collaboration-Epoch':String(currentEpoch)},signal:AbortSignal.timeout(60_000)});assert.equal(noProtocol.status,426,'new epoch without matching protocol must be fenced')
const unversionedHeaders={Authorization:`Bearer ${config['hcd-collaboration']}`,'X-HCD-Collaboration-Epoch':String(currentEpoch),'X-HCD-Coordinator-Version':'4','Content-Type':'application/json'}
const [wrongPut,wrongCheckpoint,wrongProject]=await Promise.all([
 fetch(config.apiUrl+'/collaboration/state',{method:'PUT',headers:{...unversionedHeaders,'X-HCD-State-Hash':migrated.migration.stateHash},body:legacyBytes,signal:AbortSignal.timeout(60_000)}),
 fetch(config.apiUrl+'/checkpoints',{method:'POST',headers:unversionedHeaders,body:JSON.stringify({typographyVersion:2,coordinatorVersion:4,expectedRevision:projection.revision,blocks:[]}),signal:AbortSignal.timeout(60_000)}),
 fetch(config.apiUrl+'/project',{method:'POST',headers:unversionedHeaders,body:JSON.stringify({expectedRevision:projection.revision}),signal:AbortSignal.timeout(60_000)}),
]);for(const [route,response] of [['state',wrongPut],['checkpoint',wrongCheckpoint],['project',wrongProject]] as const){assert.equal(response.status,426,`${route}: a new epoch without protocol must not accept legacy writes`);await response.arrayBuffer()}
const recoveryList=await json('/collaboration/recovery'),sourceRecovery=await request('/collaboration/recovery/'+recoveryList.recoveries[0]);assert.ok(Buffer.from(await sourceRecovery.arrayBuffer()).equals(Buffer.from(legacyBytes)),'migration must preserve exact source recovery bytes');legacy.destroy()
Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const ea=engine(a),eb=engine(b),history=sa.undoManager(),coordinator=new SemanticSaveCoordinator({documentId:'doc',epoch:currentEpoch,document:a,structure:sa,secret:config.secret,stateHash:migrated.migration.stateHash,request,broadcast:()=>{}})
const evidence:any={version:'hcd-structural-save-api/1',storageProtocol:'hcd-semantic-blocks/3',textFlowProtocol:'hcd-text-flow/1',protocolMigration:{cleanLegacyProjection:true,sourceRecoveryVerified:true,oldEpochRejected:true,missingProtocolRejected:true,missingProtocolWritesRejected:['state','checkpoint','project'],fromEpoch:0,toEpoch:currentEpoch},scope:'Headless production PM binding + two in-process Yjs replicas + real native API and actual exported files. No browser or Hocuspocus migration claim.',files:[]}
async function exportPhase(name:string,revision:number,order:string[],formats=['docx']){
 for(const format of formats){const response=await request(`/export/${format}?revision=${revision}`);assert.ok(response.ok,`export ${format}: ${response.status} ${response.ok?'':await response.text()}`);const filename=`${name}.${format}`;await writeFile(config.root+'/'+filename,Buffer.from(await response.arrayBuffer()));evidence.files.push({name:filename,revision,order})}
}
try{
 await coordinator.initialize(projection);await Promise.resolve();assert.equal(coordinator.state().status,'saved')
 evidence.originalAssetHash=(await json('/images')).entries[0].assetHash
 const nodes=['Block A','Block B','Block C'].map(text=>schema.nodes.paragraph.createChecked(null,schema.text(text)))
 ea.dispatch(ea.get().tr.insert(ea.get().doc.content.size,nodes));exchange(a,b);history.stopCapturing()
 const index=rootBlocks(ea.get().doc).findIndex(block=>block.node.textContent==='Block A'),state=ea.get(),tr=state.tr,key=sa.blocks()[index].key,text=sa.contents.get(key)!.get(0)
 assert.equal(transformBlocks(tr,'block.down',undefined,blockTarget(state,rootBlocks(state.doc).slice(index,index+1))!),true);ea.dispatch(tr)
 const peer=rootBlocks(eb.get().doc).find(block=>block.node.textContent==='Block A')!;eb.dispatch(eb.get().tr.setSelection(TextSelection.create(eb.get().doc,peer.to-1)).insertText(' Peer!'))
 exchange(a,b);assert.ok(ea.get().doc.eq(eb.get().doc),'replicas must have identical projected documents');assert.equal(eb.get().selection.$from.parent.textContent,'Block A Peer!')
 coordinator.changed({userId:'alice',displayName:'Alice'});coordinator.changed({userId:'bob',displayName:'Bob'});const moved=await coordinator.save();assert.equal(moved.status,'saved');assert.equal(moved.pending,false)
 assert.equal(sa.contents.get(key)!.get(0),text);assert.match(sa.content(key).attrs.hcdBlockId,/^n_[a-f0-9]{32}$/)
 await exportPhase('moved',moved.revision!,['Block B','Block A Peer!','Block C'],['docx','md','pdf'])
 history.undo();coordinator.changed({userId:'alice'});const undo=await coordinator.save();assert.equal(undo.pending,false);await exportPhase('undo',undo.revision!,['Block A Peer!','Block B','Block C'])
 history.redo();coordinator.changed({userId:'alice'});const redo=await coordinator.save();assert.equal(redo.pending,false);await exportPhase('redo',redo.revision!,['Block B','Block A Peer!','Block C'])
 exchange(a,b);history.stopCapturing()
 const current=ea.get(),first=rootBlocks(current.doc).findIndex(block=>block.node.textContent==='Block B'),quote=current.tr
 assert.equal(transformBlocks(quote,'block.quote',undefined,blockTarget(current,rootBlocks(current.doc).slice(first,first+2))!),true);ea.dispatch(quote)
 const oldPeer=rootBlocks(eb.get().doc).find(block=>block.node.textContent==='Block A Peer!')!;eb.dispatch(eb.get().tr.insertText(' More!',oldPeer.to-1));exchange(a,b)
 coordinator.changed({userId:'alice'});const quoted=await coordinator.save();assert.equal(quoted.pending,false);await exportPhase('quote',quoted.revision!,['Block B','Block A Peer! More!','Block C'],['docx','md','pdf'])
 exchange(a,b)
 const locate=(state:EditorState,key:string)=>{let position=-1;state.doc.descendants((node,pos)=>{if(node.attrs.hcdStructureKey===key)position=pos+1+node.content.size});assert.ok(position>=0);return position}
 ea.dispatch(ea.get().tr.insertText(' Saved!',locate(ea.get(),key)));coordinator.changed({userId:'alice'})
 let arrived!:()=>void,release!:()=>void;const waiting=new Promise<void>(done=>{arrived=done}),gate=new Promise<void>(done=>{release=done});replyGate={arrive:arrived,wait:gate}
 const pending=coordinator.save();await waiting
 const wrapped=ea.get(),at=rootBlocks(wrapped.doc).findIndex(block=>block.node.type.name==='blockquote'),plain=wrapped.tr
 assert.equal(transformBlocks(plain,'block.paragraph',undefined,blockTarget(wrapped,rootBlocks(wrapped.doc).slice(at,at+1))!),true);ea.dispatch(plain)
 eb.dispatch(eb.get().tr.insertText(' Late!',locate(eb.get(),key)));exchange(a,b);release();assert.equal((await pending).pending,true)
 coordinator.changed({userId:'bob'});const final=await coordinator.save();assert.equal(final.status,'saved');assert.equal(final.pending,false)
 const merged=sa.content(key).textContent;assert.ok(['Block A Peer! More! Saved! Late!','Block A Peer! More! Late! Saved!'].includes(merged),merged);exchange(a,b);assert.ok(ea.get().doc.eq(eb.get().doc),'replicas must have identical projected documents');evidence.concurrentInsertText=merged
 await exportPhase('unwrapped',final.revision!,['Block B',merged,'Block C'],['docx','md','pdf'])
 evidence.wrapAndLateReceiptVerified=true
 history.stopCapturing()
 const codeState=ea.get(),codeFirst=rootBlocks(codeState.doc).findIndex(block=>block.node.textContent==='Block B'),code=codeState.tr
 assert.equal(transformBlocks(code,'block.code',undefined,blockTarget(codeState,rootBlocks(codeState.doc).slice(codeFirst,codeFirst+2))!),true);ea.dispatch(code)
 const beforeJoin=rootBlocks(eb.get().doc).find(block=>block.node.textContent===merged)!
 eb.dispatch(eb.get().tr.setSelection(TextSelection.create(eb.get().doc,beforeJoin.to-1)).insertText(' Join!'));exchange(a,b)
 const joinedText=merged+' Join!';assert.ok(ea.get().doc.eq(eb.get().doc),'replicas must have identical projected documents');assert.equal(eb.get().selection.$from.parent.textContent,'Block B\n'+joinedText)
 coordinator.changed({userId:'alice'});coordinator.changed({userId:'bob'});const codeSaved=await coordinator.save();assert.equal(codeSaved.pending,false)
 assert.ok((await json('/editor')).blocks.some((block:any)=>block.content.kind==='code_block'),'native projection must contain the joined code block')
 await exportPhase('joined-code',codeSaved.revision!,['Block B',joinedText,'Block C'],['docx','md','pdf'])
 history.undo();exchange(a,b);coordinator.changed({userId:'alice'});const codeUndone=await coordinator.save();assert.equal(codeUndone.pending,false)
 assert.ok(!ea.get().doc.content.content.some(node=>node.type.name==='codeBlock'),'undo must restore paragraphs')
 await exportPhase('joined-code-undo',codeUndone.revision!,['Block B',joinedText,'Block C'])
 exchange(a,b);history.stopCapturing()
 const joinRoots=rootBlocks(ea.get().doc),joinRight=joinRoots.find(block=>block.node.textContent===joinedText)!
 ea.dispatch(ea.get().tr.join(joinRight.from))
 const combinedRoot=rootBlocks(ea.get().doc).find(block=>block.node.textContent==='Block B'+joinedText)!
 ea.dispatch(ea.get().tr.split(combinedRoot.from+1+'Block B'.length))
 const lateRoot=rootBlocks(eb.get().doc).find(block=>block.node.textContent===joinedText)!
 eb.dispatch(eb.get().tr.setSelection(TextSelection.create(eb.get().doc,lateRoot.to-1)).insertText(' Split!'));exchange(a,b)
 const splitText=joinedText+' Split!';assert.equal(eb.get().selection.$from.parent.textContent,splitText);assert.ok(ea.get().doc.eq(eb.get().doc),'replicas must have identical projected documents')
 coordinator.changed({userId:'alice'});coordinator.changed({userId:'bob'});const splitSaved=await coordinator.save();assert.equal(splitSaved.pending,false)
 await exportPhase('joined-and-split',splitSaved.revision!,['Block B',splitText,'Block C'],['docx','md','pdf'])
 assert.ok(!JSON.stringify(ea.get().doc.toJSON()).includes('hcdTextBoundary'),'internal text boundaries must not enter the projected document');evidence.flowJoinSplitVerified=true;evidence.offlineInputAfterJoinAndSplit=splitText
 assert.deepEqual(ea.errors,[]);assert.deepEqual(eb.errors,[]);evidence.samePhysicalTextIdentity=sa.contents.get(key)!.get(0)===text
 await coordinator.close();const beforeReplay=await request('/collaboration/state'),hashBeforeReplay=beforeReplay.headers.get('x-hcd-state-hash');await beforeReplay.arrayBuffer()
 const replay=await request('/collaboration/migrate',{method:'POST',headers:{...migrationHeaders,'X-HCD-Collaboration-Epoch':'0','X-HCD-Collaboration-Protocol':'hcd-default/1'},body:migrationBytes});assert.equal(replay.status,200);assert.equal((await replay.json()).idempotentReplay,true)
 const response=await request('/collaboration/state');assert.equal(response.headers.get('x-hcd-state-hash'),hashBeforeReplay);evidence.protocolMigration.lostReplyRetryPreservedNewerState=true;assert.ok(response.ok);const recovered=new Y.Doc();Y.applyUpdate(recovered,new Uint8Array(await response.arrayBuffer()));const restored=new SemanticBlockStore(recovered,schema)
 const restarted=new SemanticSaveCoordinator({documentId:'doc',epoch:currentEpoch,document:recovered,structure:restored,secret:config.secret,stateHash:response.headers.get('x-hcd-state-hash')!,request,broadcast:()=>{}})
 try{
  const canonical=await json('/editor');await restarted.initialize(canonical);assert.equal(restarted.state().status,'saved');assert.equal(restarted.state().pending,false)
  assert.equal(checkpointContents(jsonToSnapshot(restored.project().toJSON())),checkpointContents(jsonToSnapshot(projectionToJson(canonical))))
  assert.deepEqual(restored.keys(),sa.keys());evidence.restartRevision=restarted.state().revision;evidence.canonicalProjectionMatches=true;evidence.rootKeysRetained=true;evidence.cursorStayedInMovedBlock=true
 }finally{await restarted.close();recovered.destroy()}
 await writeFile(config.root+'/structural-save-evidence.json',JSON.stringify(evidence,null,2)+'\n')
 console.log('PASS binding -> Yjs concurrent move/input -> native canonical save -> undo/redo -> raw-state restart')
}finally{await coordinator.close();history.destroy();ea.close();eb.close();a.destroy();b.destroy()}
