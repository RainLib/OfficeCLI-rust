import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {WordCheckpointJournal,wordSaveCapsule} from '../examples/hdoc/editor/src/wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,wordCheckpointContents} from '../examples/hdoc/editor/src/wordRegionStore.ts'
import {WordRoomLease} from '../examples/hdoc/editor/src/wordRoomLease.ts'
import {CollaborativeImageDraftStore,captureImages,imageIntents} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {wordImageRegions} from '../examples/hdoc/editor/src/wordImages.ts'
import {wordDraftObservation} from '../examples/hdoc/editor/src/wordDraftObservation.ts'
import {recoverCommittedWordLayout,submitPreparedWordLayout} from '../examples/hdoc/editor/src/wordLayoutRecovery.ts'
import {recoverPreparedWordCheckpoint} from '../examples/hdoc/editor/src/wordCheckpointRecovery.ts'

const [stage,root,fixturePath]=process.argv.slice(2),fixture=JSON.parse(await readFile(fixturePath,'utf8')),secret=process.env.HCD_TOKEN_SECRET
if(!secret||!['prepare','ack','verify','recover','resume','submit','submit-resume','checkpoint-v2','checkpoint-drop','checkpoint-ack-drop','checkpoint-resume','checkpoint-late-save','checkpoint-noop-drop','checkpoint-noop-resume'].includes(stage))throw Error('invalid isolated test')
const journal=new WordCheckpointJournal(root,'http://localhost','region-test',0,'e'.repeat(32),secret,true),schema=wordRegionSchema(),old=fixture.previous,next=fixture.next,request=fixture.request
if(stage==='prepare'){
 const doc=new Y.Doc(),model=new WordRegionStore(doc,schema,'region-test',old.flowLayout,old.flowLayoutHash);model.initialize(old)
 const base={revision:old.revision,rootHash:fixture.previousRoot,layoutHash:old.flowLayoutHash,digest:createHash('sha256').update(model.contents()).digest('hex')}
 const header=old.flowLayout.stories.find((story:any)=>story.kind==='header'),before=model.region(header.id)
 model.reconcile(header.id,before,[...before,{node:schema.nodes.paragraph.createChecked(null,schema.text('签名日志中的迟到输入 😀'))}])
 const actor={...request.actor,generation:1},capsule=wordSaveCapsule(journal.scope,model,base,[actor]);capsule.version=2;capsule.pendingLayout={actor,request}
 const tip=await journal.save(capsule,'none');doc.destroy();process.stdout.write(JSON.stringify({tip,header:header.id}))
}else if(stage==='ack'){
 const current=await journal.load();assert.ok(current?.capsule.pendingLayout);const result=await journal.acknowledgeLayout(fixture.record,fixture.receipt,old,next,current.hash,()=>{})
 const restored=new Y.Doc();Y.applyUpdate(restored,Buffer.from(result.capsule.document,'base64'));const model=new WordRegionStore(restored,schema,'region-test',next.flowLayout,next.flowLayoutHash)
 assert.match(model.project(fixture.header).textContent,/签名日志中的迟到输入/);assert.equal(result.capsule.base.revision,request.expectedRevision+1);assert.equal(result.capsule.pendingLayout,undefined)
 restored.destroy();process.stdout.write(JSON.stringify({tip:result.tip,revision:result.capsule.base.revision,lateTextPreserved:true}))
}else if(stage==='verify'){
 const current=await journal.load();assert.ok(current);assert.equal(current.capsule.version,2);assert.equal(current.capsule.pendingLayout,undefined);assert.equal(current.capsule.base.revision,request.expectedRevision+1);assert.deepEqual(current.capsule.layoutAcknowledgement?.receipt,fixture.receipt)
 await assert.rejects(new WordCheckpointJournal(root,'http://localhost','region-test',0,'e'.repeat(32),secret).load(),/word-journal-invalid/)
 const doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(current.capsule.document,'base64'));const model=new WordRegionStore(doc,schema,'region-test',next.flowLayout,next.flowLayoutHash)
 assert.match(model.project(fixture.header).textContent,/签名日志中的迟到输入/);doc.destroy();process.stdout.write(JSON.stringify({revision:current.capsule.base.revision,lateTextPreserved:true,legacyReaderRejected:true}))
}else{
 const token=process.env.HCD_TEST_TOKEN;if(!token)throw Error('missing test token')
 const loaded=await journal.load();assert.ok(loaded);let records=0,receiptCalls=0,tcpDropped=false,checkpointReplayed=false,receiptProjection:any
 // Forward to the actual native service, then close the downstream socket
 // only after its second owner-record response has been received and checked.
 const proxy=stage==='recover'||stage==='submit'||stage==='checkpoint-drop'||stage==='checkpoint-ack-drop'||stage==='checkpoint-noop-drop'?createServer(async(req,res)=>{
  try{
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks),upstreamHeaders=new Headers()
   for(const [key,value]of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(key))upstreamHeaders.set(key,Array.isArray(value)?value.join(', '):value)
   const upstream=await fetch(fixture.apiUrl+req.url,{method:req.method,headers:upstreamHeaders,...(body.length?{body}: {})}),bytes=Buffer.from(await upstream.arrayBuffer())
   if(['recover','checkpoint-ack-drop'].includes(stage)&&req.url==='/collaboration/word-owner'&&body.length&&JSON.parse(body.toString()).action==='record'&&++records===2){const accepted=JSON.parse(bytes.toString());assert.equal(upstream.status,200);assert.equal(accepted.journalHash,JSON.parse(body.toString()).journalHashes.at(-1));tcpDropped=true;res.socket!.destroy();return}
   if(stage==='submit'&&req.url==='/word/layout-transactions'){const accepted=JSON.parse(bytes.toString());assert.equal(upstream.status,200);assert.equal(accepted.revision,fixture.request.expectedRevision+1);assert.equal(accepted.idempotentReplay,false);tcpDropped=true;res.socket!.destroy();return}
   if(stage==='checkpoint-drop'&&req.url==='/word/checkpoints'&&JSON.parse(body.toString()).coordinatorVersion===6){const accepted=JSON.parse(bytes.toString());assert.equal(upstream.status,200);assert.equal(accepted.revision,fixture.request.expectedRevision+2);tcpDropped=true;res.socket!.destroy();return}
   if(stage==='checkpoint-noop-drop'&&req.url==='/word/checkpoints'){const accepted=JSON.parse(bytes.toString());assert.equal(upstream.status,200);assert.equal(accepted.saveMode,'word-regions-unchanged');assert.equal(accepted.revision,fixture.request.expectedRevision+3);assert.ok(accepted.unchangedReceipt?.signature);tcpDropped=true;res.socket!.destroy();return}
   res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});res.end(bytes)
  }catch{res.destroy()}
 }):undefined
 if(proxy)await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve))
 const target=proxy?`http://127.0.0.1:${(proxy.address() as {port:number}).port}`:fixture.apiUrl
 const protocol=fixture.protocol??'hcd-word-regions/1'
 const headers={Authorization:`Bearer ${token}`,'X-HCD-Collaboration-Epoch':'0','X-HCD-Collaboration-Protocol':protocol,'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1'}
 const transport=async(route:string,init:RequestInit={})=>{
  const requestHeaders=new Headers(init.headers);for(const [key,value]of Object.entries(headers))requestHeaders.set(key,value)
  const response=await fetch(target+route,{...init,headers:requestHeaders})
  if(route==='/word/layout-receipt'){receiptCalls++;if(response.ok)receiptProjection=(await response.clone().json()).projection}
  if(route==='/word/checkpoints'&&response.ok)checkpointReplayed=(await response.clone().json()).idempotentReplay===true
  return response
 }
 const lease=new WordRoomLease({epoch:0,storeId:fixture.storeId??'b'.repeat(32),autoRenew:false,journalHashes:journal.knownHashes(),request:transport})
 const request=async(route:string,init:RequestInit={})=>transport(route,['/word/layout-receipt','/word/layout-transactions','/word/checkpoints','/word/checkpoint-receipt'].includes(route)||route.startsWith('/editor')?{...init,headers:{...init.headers,...lease.headers()}}:init)
 try{
  await lease.acquire();const options={journal,lease,request,protocol,assertStopped:()=>{}},run=()=>recoverCommittedWordLayout(options)
  if(stage==='checkpoint-noop-resume'){
   assert.ok(loaded.capsule.pending);const recovered=await recoverPreparedWordCheckpoint(options);assert.equal(recovered.capsule.base.revision,fixture.request.expectedRevision+3);assert.ok(recovered.capsule.unchangedAcknowledgement);assert.equal(recovered.capsule.pending,undefined)
   const again=new WordCheckpointJournal(root,'http://localhost','region-test',0,'e'.repeat(32),secret,true),reopened=await again.load();assert.equal(reopened!.hash,recovered.tip);assert.ok(reopened!.capsule.unchangedAcknowledgement)
   const proof=reopened!.capsule.unchangedAcknowledgement!
   for(const change of [(value:any)=>{value.signature='x'.repeat(43)},(value:any)=>{value.rootHash='0'.repeat(64)},(value:any)=>{value.epoch=1},(value:any)=>{value.journalHash='0'.repeat(64)},(value:any)=>{value.patchId=value.patchId.replace('hcdsave6','hcdsave5')}]){const bad=structuredClone(proof.receipt) as any;change(bad);assert.equal(again.verifyUnchangedReceipt(bad,proof.request,proof.journalHash,recovered.capsule.base.rootHash),false)}
   const altered=structuredClone(proof.request);altered.contributors[0].displayName='Mallory';assert.equal(again.verifyUnchangedReceipt(proof.receipt,altered,proof.journalHash,recovered.capsule.base.rootHash),false)
   process.stdout.write(JSON.stringify({revision:recovered.capsule.base.revision,noNewRevision:true,signedReceiptVerified:true,pendingCleared:true,separateProcessRecovered:true}))
  }else if(stage==='checkpoint-noop-drop'){
   assert.ok(loaded.capsule.checkpointAcknowledgement);await lease.recordJournal(journal.knownHashes());const response=await request('/editor',{headers:{'X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'}});assert.equal(response.status,200);const projection=await response.json(),draft=new Y.Doc();Y.applyUpdate(draft,Buffer.from(loaded.capsule.document,'base64'));const model=new WordRegionStore(draft,schema,'region-test',projection.flowLayout,projection.flowLayoutHash),capture=model.capture();assert.equal(imageIntents(draft).length,0)
   const actors=[{userId:'alice',displayName:'Alice',generation:1}],payload={coordinatorVersion:6 as const,coordinatorId:journal.scope.lineage,checkpointId:'5'.repeat(32),coordinatorDigest:createHash('sha256').update(wordCheckpointContents(capture)).digest('hex'),expectedRevision:projection.revision,layoutHash:capture.layoutHash,typographyVersion:2 as const,extensionVersion:1 as const,referenceVersion:1 as const,regions:capture.regions.map(region=>({...region,images:[]})),contributors:actors.map(({userId,displayName})=>({userId,displayName}))}
   const capsule=structuredClone(loaded.capsule);delete capsule.checkpointAcknowledgement;capsule.pending={request:payload,capture,actors,images:[]};const tip=await journal.save(capsule,loaded.hash,()=>lease.assert());await lease.recordJournal(journal.knownHashes());draft.destroy()
   await assert.rejects(recoverPreparedWordCheckpoint(options),/fetch failed|socket|closed/i);assert.equal(tcpDropped,true);assert.equal((await journal.load())!.hash,tip);process.stdout.write(JSON.stringify({tcpResponseDropped:true,pendingPreserved:true}))
  }else if(stage==='checkpoint-late-save'){
   assert.ok(loaded.capsule.checkpointAcknowledgement);assert.ok(fixture.images);await lease.recordJournal(journal.knownHashes())
   const headers={'X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'},response=await request('/editor',{headers});assert.equal(response.status,200);const projection=await response.json();assert.equal(projection.revision,loaded.capsule.base.revision)
   const draft=new Y.Doc();Y.applyUpdate(draft,Buffer.from(loaded.capsule.document,'base64'));const model=new WordRegionStore(draft,schema,'region-test',projection.flowLayout,projection.flowLayoutHash),capture=model.capture(),regions=wordImageRegions(projection),images=captureImages(draft).map(value=>({...value,regionId:regions.get(value.change.nodeId)!}));assert.equal(images.length,1);assert.equal(images[0].change.geometry.width,fixture.image.lateWidth);assert.equal(images[0].change.assetHash,undefined)
   const actors=[{userId:'alice',displayName:'Alice',generation:1}],payload={coordinatorVersion:6 as const,coordinatorId:journal.scope.lineage,checkpointId:'6'.repeat(32),coordinatorDigest:createHash('sha256').update(wordCheckpointContents(capture)).digest('hex'),expectedRevision:projection.revision,layoutHash:capture.layoutHash,typographyVersion:2 as const,extensionVersion:1 as const,referenceVersion:1 as const,regions:capture.regions.map(region=>({...region,images:images.filter(value=>value.regionId===region.regionId).map(value=>value.change)})),contributors:actors.map(({userId,displayName})=>({userId,displayName}))}
   const capsule=structuredClone(loaded.capsule);delete capsule.checkpointAcknowledgement;capsule.pending={request:payload,capture,actors,images};const prepared=await journal.save(capsule,loaded.hash,()=>lease.assert());await lease.recordJournal(journal.knownHashes());draft.destroy()
   const recovered=await recoverPreparedWordCheckpoint(options);assert.equal(recovered.capsule.base.revision,projection.revision+1);assert.equal(recovered.capsule.pending,undefined);assert.ok(recovered.capsule.checkpointAcknowledgement)
   const imageResponse=await request(`/images/${fixture.image.nodeId}?revision=${recovered.capsule.base.revision}`);assert.equal(imageResponse.status,200);const image=(await imageResponse.json()).image;assert.equal(image.geometry.width,fixture.image.lateWidth);assert.equal(image.assetHash,fixture.image.assetHash)
   const clean=new Y.Doc();Y.applyUpdate(clean,Buffer.from(recovered.capsule.document,'base64'));assert.equal(imageIntents(clean).length,0);clean.destroy();assert.notEqual(prepared,recovered.tip)
   process.stdout.write(JSON.stringify({revision:recovered.capsule.base.revision,lateWidthSaved:true,assetReused:true,imageIntentsCleared:true}))
  }else if(stage==='checkpoint-ack-drop'){
   assert.ok(loaded.capsule.pending)
   await assert.rejects(recoverPreparedWordCheckpoint({...options,assertStopped:()=>{throw Error('room-active')}}),/room-active/)
   await assert.rejects(recoverPreparedWordCheckpoint({...options,request:(route,init)=>route==='/auth'?Promise.resolve(Response.json({scope:'read',collaborationEpoch:0,collaborationProtocol:protocol})):request(route,init)}),/word-authority-changed/)
   assert.equal((await journal.load())!.hash,loaded.hash)
   await assert.rejects(recoverPreparedWordCheckpoint(options),/fetch failed|socket|closed/i);const current=await journal.load();assert.ok(current?.capsule.checkpointAcknowledgement);assert.equal(tcpDropped,true);assert.equal(checkpointReplayed,true)
   const proof=current.capsule.checkpointAcknowledgement,altered=structuredClone(proof.request);altered.contributors[0].displayName='Mallory';assert.equal(journal.verifyCheckpointReceipt(proof.receipt,proof.record,altered,proof.journalHash),false)
   if(fixture.images){const changed=structuredClone(proof.request),image=changed.regions.flatMap(region=>region.images)[0];assert.ok(image);image.geometry.width+=1;assert.equal(journal.verifyCheckpointReceipt(proof.receipt,proof.record,changed,proof.journalHash),false)}
   process.stdout.write(JSON.stringify({tcpResponseDropped:true,tip:current.hash,acknowledgementPreserved:true,activeRoomAndReadScopeRejected:true,checkpointReplayVerified:true,requestFieldsBound:true}))
  }else if(stage==='checkpoint-resume'){
   assert.ok(loaded.capsule.pending||loaded.capsule.checkpointAcknowledgement);const recovered=await recoverPreparedWordCheckpoint(options);assert.equal(recovered.capsule.base.revision,fixture.request.expectedRevision+2);assert.ok(recovered.capsule.checkpointAcknowledgement);assert.equal(recovered.capsule.pending,undefined)
   const modelHeaders={'X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'},response=await request('/editor',{headers:modelHeaders});assert.equal(response.status,200);const projection=await response.json(),beforeResponse=await request(`/editor?revision=${fixture.request.expectedRevision+1}`,{headers:modelHeaders});assert.equal(beforeResponse.status,200);const before=await beforeResponse.json()
   const layoutWithoutAnchors=(layout:any)=>({...layout,sections:layout.sections.map(({canonicalEndBlockId:_,...section}:any)=>section)});assert.deepEqual(layoutWithoutAnchors(projection.flowLayout),layoutWithoutAnchors(before.flowLayout))
   const draft=new Y.Doc();Y.applyUpdate(draft,Buffer.from(recovered.capsule.document,'base64'));const model=new WordRegionStore(draft,schema,'region-test',projection.flowLayout,projection.flowLayoutHash);assert.match(model.project(fixture.header).textContent,/Late after v2 capture/)
   if(fixture.attribution==='bound'){assert.deepEqual(recovered.capsule.actors,[{userId:'bob',displayName:'Bob',generation:2}]);assert.equal(recovered.capsule.observation,wordDraftObservation(model))}
   if(fixture.attribution==='same'){assert.deepEqual(recovered.capsule.actors,[{userId:'alice',displayName:'Alice',generation:2}]);assert.equal(recovered.capsule.observation,wordDraftObservation(model))}
   if(fixture.attribution==='unbound'){assert.deepEqual(recovered.capsule.actors,[{userId:'alice',displayName:'Alice',generation:1},{userId:'bob',displayName:'Bob',generation:2}]);assert.equal(recovered.capsule.observation,'0'.repeat(64));assert.notEqual(recovered.capsule.observation,wordDraftObservation(model))}
   let image:any;if(fixture.images){const expected=fixture.image,intents=imageIntents(draft);assert.equal(intents.length,1);assert.equal(intents[0].base.nodeId,expected.nodeId);assert.equal(intents[0].base.geometry.width,expected.committedWidth);assert.equal(intents[0].geometry.width,expected.lateWidth);assert.equal(intents[0].revision,recovered.capsule.base.revision)
    const response=await request(`/images/${expected.nodeId}?revision=${recovered.capsule.base.revision}`);assert.equal(response.status,200);const actual=await response.json();assert.equal(actual.image.geometry.width,expected.committedWidth);assert.equal(actual.image.assetHash,expected.assetHash);image={...expected,lateResizePreserved:true,immutableImageVerified:true}}
   draft.destroy();process.stdout.write(JSON.stringify({revision:recovered.capsule.base.revision,paperSettingsPreserved:true,layoutHashChanged:projection.flowLayoutHash!==before.flowLayoutHash,checkpointAcknowledged:true,lateInputPreserved:true,differentProcessRecovered:true,...(fixture.attribution==='bound'?{capturedAuthorRetired:true,lateAuthorAndObservationPreserved:true}:fixture.attribution==='same'?{newerGenerationPreserved:true}:fixture.attribution==='unbound'?{unboundObservationPreserved:true,unconfirmedAuthorsRetained:true}:{}),...(image?{image}:{})}))
  }else if(stage==='checkpoint-v2'||stage==='checkpoint-drop'){
   assert.ok(loaded.capsule.layoutAcknowledgement);await lease.recordJournal(journal.knownHashes())
   const modelHeaders={...lease.headers(),'X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'}
   const view=await request('/editor',{headers:modelHeaders});assert.equal(view.status,200);const projection=await view.json(),restored=new Y.Doc();Y.applyUpdate(restored,Buffer.from(loaded.capsule.document,'base64'))
   const model=new WordRegionStore(restored,schema,'region-test',projection.flowLayout,projection.flowLayoutHash)
   for(const region of model.capture().regions){const before=model.region(region.regionId);model.reconcile(region.regionId,before,[...before,{node:schema.nodes.paragraph.createChecked(null,schema.text(`V2 text ${region.regionId}`))}])}
   let image:any,store:CollaborativeImageDraftStore|undefined,capturedImages:any[]=[]
   if(fixture.images){const response=await request(`/images?revision=${projection.revision}`);assert.equal(response.status,200);image=(await response.json()).entries[0];assert.ok(image?.assetHash);assert.equal(wordImageRegions(projection).get(image.nodeId),fixture.header);store=new CollaborativeImageDraftStore(restored);store.edit(image,projection.revision,{...image.geometry,width:Math.round(image.geometry.width*.8)},undefined,'width')
    const upload=store.prepareReplacement(image,projection.revision),writer=process.env.HCD_TEST_WRITER;assert.ok(writer);const uploadResponse=await fetch(fixture.apiUrl+'/staged-assets?extension=png',{method:'POST',headers:{Authorization:`Bearer ${writer}`,'Content-Type':'application/octet-stream'},body:await readFile(fixture.replacementPath)});assert.equal(uploadResponse.status,200,await uploadResponse.clone().text());const uploaded=await uploadResponse.json();assert.equal(uploaded.hash,fixture.replacementHash);upload.commit(uploaded.hash);upload.finish();capturedImages=captureImages(restored).map(value=>({...value,regionId:fixture.header}))}
   const capture=model.capture(),payload={coordinatorVersion:6 as const,coordinatorId:journal.scope.lineage,checkpointId:'7'.repeat(32),coordinatorDigest:createHash('sha256').update(wordCheckpointContents(capture)).digest('hex'),expectedRevision:projection.revision,layoutHash:capture.layoutHash,typographyVersion:2 as const,extensionVersion:1 as const,referenceVersion:1 as const,regions:capture.regions.map(region=>({...region,images:capturedImages.filter(value=>value.regionId===region.regionId).map(value=>value.change)})),contributors:[{userId:'alice',displayName:'Alice'}]}
   const promoted=await journal.promoteLayoutAcknowledgement(loaded.hash,()=>lease.assert()),capsule=structuredClone(promoted.capsule)
   const lateBefore=model.region(fixture.header);model.reconcile(fixture.header,lateBefore,[...lateBefore,{node:schema.nodes.paragraph.createChecked(null,schema.text('Late after v2 capture'))}])
   if(store)store.edit(image,projection.revision,{...image.geometry,width:Math.round(image.geometry.width*1.25)},undefined,'width')
   capsule.document=Buffer.from(Y.encodeStateAsUpdate(restored)).toString('base64');capsule.pending={request:payload,capture,actors:[{userId:'alice',displayName:'Alice',generation:1}],images:capturedImages}
   if(fixture.attribution){capsule.actors=fixture.attribution==='same'?[{userId:'alice',displayName:'Alice',generation:2}]:[{userId:'alice',displayName:'Alice',generation:1},{userId:'bob',displayName:'Bob',generation:2}];capsule.observation=fixture.attribution==='unbound'?'0'.repeat(64):wordDraftObservation(model)}
   const prepared=await journal.save(capsule,promoted.tip,()=>lease.assert());await lease.recordJournal(journal.knownHashes())
   const send=(body:unknown)=>request('/word/checkpoints',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify(body)})
   assert.equal((await send({...payload,coordinatorVersion:5})).status,426)
   if(stage==='checkpoint-drop'){
    await assert.rejects(send(payload),/fetch failed|socket|closed/i);assert.equal(tcpDropped,true);const current=await journal.load();assert.equal(current!.hash,prepared);assert.deepEqual(current!.capsule.pending?.request,payload);restored.destroy();process.stdout.write(JSON.stringify({tcpResponseDropped:true,tip:prepared,pendingPreserved:true,...(image?{image:{nodeId:image.nodeId,assetHash:fixture.replacementHash,committedWidth:Math.round(image.geometry.width*.8),lateWidth:Math.round(image.geometry.width*1.25),replacement:true}}:{})}))
   }else{
   const result=await send(payload);assert.equal(result.status,200,await result.clone().text());const saved=await result.json();assert.equal(saved.revision,projection.revision+1)
   const layoutWithoutAnchors=(layout:any)=>({...layout,sections:layout.sections.map(({canonicalEndBlockId:_,...section}:any)=>section)})
   assert.deepEqual(layoutWithoutAnchors(saved.projection.flowLayout),layoutWithoutAnchors(projection.flowLayout),'checkpoint changed Word settings or bindings')
   const recordResponse=await request(`/revisions/${saved.revision}`);assert.equal(recordResponse.status,200);const record=await recordResponse.json();assert.equal(journal.verifyCheckpointRecord(record,payload),true)
   const receiptRequest=(body:unknown)=>request('/word/checkpoint-receipt',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify(body)})
   const proofResponse=await receiptRequest(payload);assert.equal(proofResponse.status,200,await proofResponse.clone().text());const proof=await proofResponse.json();assert.equal(journal.verifyCheckpointReceipt(proof,record,payload,prepared),true)
   const altered=structuredClone(payload);altered.contributors[0].displayName='Mallory';assert.equal(journal.verifyCheckpointReceipt(proof,record,altered,prepared),false);assert.equal((await receiptRequest(altered)).status,409)
   const alteredRegion=structuredClone(payload);alteredRegion.regions[0].blocks[0].content.inlines[0].text+=' forged';assert.equal(journal.verifyCheckpointReceipt(proof,record,alteredRegion,prepared),false);assert.equal((await receiptRequest(alteredRegion)).status,409)
   const alteredReference=structuredClone(payload);(alteredReference as any).referenceAuthors=[{mentionId:'m_'+'a'.repeat(32),userId:'alice'}];assert.equal(journal.verifyCheckpointReceipt(proof,record,alteredReference,prepared),false);assert.equal((await receiptRequest(alteredReference)).status,409)
   const replay=await send(payload);assert.equal(replay.status,200);assert.equal((await replay.json()).idempotentReplay,true);assert.equal((await journal.load())!.hash,prepared)
   const baseResponse=await request(`/revisions/${projection.revision}`);assert.equal(baseResponse.status,200);const baseRecord=await baseResponse.json()
   await assert.rejects(journal.acknowledgeCheckpoint(record,proof,{...baseRecord,rootHash:'0'.repeat(64)},projection,saved.projection,[],prepared,()=>lease.assert()),/word-checkpoint-receipt-invalid/)
   const changedLayout=structuredClone(saved.projection);changedLayout.flowLayout.sections[0].page.widthTwips+=1
   await assert.rejects(journal.acknowledgeCheckpoint(record,proof,baseRecord,projection,changedLayout,[],prepared,()=>lease.assert()),/wordRegionLayoutChanged/)
   const changedBody=structuredClone(saved.projection),paragraph=changedBody.blocks.find((block:any)=>block.content?.kind==='paragraph'&&block.content.inlines?.length);assert.ok(paragraph);paragraph.content.inlines[0].text+=' forged'
   await assert.rejects(journal.acknowledgeCheckpoint(record,proof,baseRecord,projection,changedBody,[],prepared,()=>lease.assert()),/word-checkpoint-content-mismatch/);assert.equal((await journal.load())!.hash,prepared)
   await assert.rejects(journal.acknowledgeCheckpoint(record,proof,baseRecord,projection,saved.projection,[{} as any],prepared,()=>lease.assert()),/Incomplete image receipt/)
   const acknowledged=await journal.acknowledgeCheckpoint(record,proof,baseRecord,projection,saved.projection,[],prepared,()=>lease.assert());await lease.recordJournal(journal.knownHashes());assert.equal(acknowledged.capsule.pending,undefined)
   const reopened=new WordCheckpointJournal(root,'http://localhost','region-test',0,'e'.repeat(32),secret,true),recovered=await reopened.load();assert.equal(recovered!.hash,acknowledged.tip)
   const draft=new Y.Doc();Y.applyUpdate(draft,Buffer.from(recovered!.capsule.document,'base64'));const rebound=new WordRegionStore(draft,schema,'region-test',saved.projection.flowLayout,saved.projection.flowLayoutHash);assert.match(rebound.project(fixture.header).textContent,/Late after v2 capture/);draft.destroy();restored.destroy()
   process.stdout.write(JSON.stringify({revision:saved.revision,paperSettingsPreserved:true,layoutHashChanged:saved.projection.flowLayoutHash!==projection.flowLayoutHash,oldCheckpointRejected:true,exactReplay:true,regionCount:capture.regions.length,signedJournalPrepared:true,nativeCheckpointSignatureVerified:true,checkpointAcknowledged:true,lateInputPreserved:true,reopened:true}))
   }
  }else if(stage==='submit'){
   await assert.rejects(submitPreparedWordLayout(options),/fetch failed|socket|closed/i);const current=await journal.load();assert.ok(current?.capsule.pendingLayout);assert.equal(current.hash,loaded.hash);assert.equal(tcpDropped,true)
   process.stdout.write(JSON.stringify({tip:current.hash,tcpResponseDropped:true,pendingPreserved:true}))
  }else if(stage==='submit-resume'){
   const recovered=await submitPreparedWordLayout(options);assert.ok(recovered.capsule.layoutAcknowledgement);assert.equal(receiptCalls,1)
   const response=await request(`/editor?revision=${recovered.capsule.base.revision}`,{headers:{...lease.headers(),'X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'}});assert.equal(response.status,200);const projection=await response.json()
   assert.deepEqual(projection,receiptProjection);assert.equal(projection.revision,recovered.capsule.base.revision)
   const restored=new Y.Doc();Y.applyUpdate(restored,Buffer.from(recovered.capsule.document,'base64'));const model=new WordRegionStore(restored,schema,'region-test',projection.flowLayout,projection.flowLayoutHash)
   assert.match(model.project(fixture.header).textContent,/签名日志中的迟到输入/);restored.destroy();process.stdout.write(JSON.stringify({tip:recovered.tip,revision:recovered.capsule.base.revision,receiptCalls,lateTextPreserved:true,fencedProjection:true}))
  }else
  if(stage==='recover'){
   await assert.rejects(run(),/fetch failed|socket|closed/i);const current=await journal.load();assert.ok(current?.capsule.layoutAcknowledgement);assert.equal(receiptCalls,1);assert.equal(tcpDropped,true)
   process.stdout.write(JSON.stringify({tip:current.hash,receiptCalls,tcpResponseDropped:true}))
  }else{
   const recovered=await run();assert.ok(recovered.capsule.layoutAcknowledgement);assert.equal(receiptCalls,0)
   const restored=new Y.Doc();Y.applyUpdate(restored,Buffer.from(recovered.capsule.document,'base64'));const model=new WordRegionStore(restored,schema,'region-test',next.flowLayout,next.flowLayoutHash)
   assert.match(model.project(fixture.header).textContent,/签名日志中的迟到输入/);restored.destroy();process.stdout.write(JSON.stringify({tip:recovered.tip,revision:recovered.capsule.base.revision,receiptCalls,lateTextPreserved:true}))
  }
 }finally{await lease.close();if(proxy)await new Promise<void>(resolve=>proxy.close(()=>resolve()))}
}
