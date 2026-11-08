/** Explicit stopped-owner acceptance across separate Node processes. No
 * member link-submit route or live room replacement is simulated here. */
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash,createHmac,randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {WordCheckpointJournal} from '../examples/hdoc/editor/src/wordCheckpointJournal.ts'
import {WordRoomLease,wordRecoveryStoreId} from '../examples/hdoc/editor/src/wordRoomLease.ts'
import {WordRegionStore,wordRegionSchema} from '../examples/hdoc/editor/src/wordRegionStore.ts'
import {wordDraftObservation} from '../examples/hdoc/editor/src/wordDraftObservation.ts'
import {wordSidecarRequestModel,wordSidecarHeaders} from '../examples/hdoc/editor/src/wordSidecarTransport.ts'
import {submitPreparedWordLink,recoverCommittedWordLink,promoteRecoveredWordLink} from '../examples/hdoc/editor/src/wordLinkRecovery.ts'
import {WordSaveCoordinator} from '../examples/hdoc/editor/src/wordSaveCoordinator.ts'
import type {WordPendingLink} from '../examples/hdoc/editor/src/wordLinkProof.ts'
const root=resolve(process.argv[2]),out=resolve(process.argv[3]),phase=process.argv[4],c=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
assert.equal(c.root,root);assert.equal(c.clean,true);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/);assert.ok(['commit-drop','recover-save','historical-check'].includes(phase));await mkdir(out,{recursive:true})
const lineage=createHmac('sha256',c.secret).update(`word-room/1:${c.origin}:region-test:1`).digest('hex').slice(0,32),journal=new WordCheckpointJournal(root+'/sidecar',c.origin,'region-test',1,lineage,c.secret,true,true,true)
await journal.load()
async function raw(route:string,init:RequestInit={},person='service'){
 const headers=new Headers({'Authorization':'Bearer '+c[person],'X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1','X-HCD-Flow-Layout-Version':'2','X-HCD-Collaboration-Epoch':'1','X-HCD-Collaboration-Protocol':'hcd-word-regions/2',...(route==='/collaboration/word-owner'?{'X-HCD-Word-Story-Recovery':'1'}:{})});new Headers(init.headers).forEach((value,key)=>headers.set(key,value))
 return fetch(c.origin+'/v1/documents/region-test'+route,{...init,headers,signal:init.signal??AbortSignal.timeout(30000)})
}
const lease=new WordRoomLease({epoch:1,storeId:await wordRecoveryStoreId(root+'/sidecar',c.origin,c.secret),journalHashes:journal.knownHashes(),request:raw}),documents:Y.Doc[]=[]
let proxy:ReturnType<typeof createServer>|undefined,coordinator:WordSaveCoordinator|undefined,commitCalls=0
const request=async(route:string,init:RequestInit={})=>{
 lease.assert();const model=await wordSidecarRequestModel(route,'region-test',()=>raw(''),()=>lease.assert())
 const headers=wordSidecarHeaders(route,init.headers,lease.headers(),model)
 if(proxy&&route==='/word/link-transactions')return fetch(`http://127.0.0.1:${(proxy.address() as {port:number}).port}/commit`,{...init,headers,signal:init.signal})
 return raw(route,{...init,headers})
}
const json=async(route:string,init?:RequestInit)=>{const response=await request(route,init);assert.equal(response.status,200,route+': '+await response.clone().text());return response.json()}
let stopped=true
const options={journal,lease,request,assertStopped:()=>{assert.equal(stopped,true);lease.assert()},protocol:'hcd-word-regions/2' as const,authorize:async()=>{const response=await raw('/auth',{},'alice');assert.equal(response.status,200);const auth=await response.json();return{scope:auth.scope,userId:auth.userId,displayName:auth.displayName}}}
try{
 await lease.acquire();await lease.recordJournal(journal.knownHashes())
 if(phase==='commit-drop'){
  const saved=(await journal.load())!;assert.equal(saved.capsule.version,3);const previous=await json(`/editor?revision=${saved.capsule.base.revision}`),doc=new Y.Doc();documents.push(doc);Y.applyUpdate(doc,Buffer.from(saved.capsule.document,'base64'))
  const model=new WordRegionStore(doc,wordRegionSchema(),'region-test',previous.flowLayout,previous.flowLayoutHash),region=previous.flowLayout.sections[0].id,blocks=model.region(region),block=blocks.find(b=>b.node.type.name==='paragraph'&&b.node.firstChild?.isText)!;assert.ok(block)
  const marker='Link journal private draft '+randomUUID().slice(0,8),node=block.node.type.createChecked(block.node.attrs,model.schema.text(block.node.textContent+' · '+marker,block.node.firstChild!.marks));model.reconcile(region,blocks,blocks.map(b=>b.key===block.key?{key:b.key,node}:b))
  const auth=await options.authorize();assert.equal(auth.scope,'write');const actor={userId:auth.userId,displayName:auth.displayName,generation:1}
  const draft={...saved.capsule,actors:[actor],observation:wordDraftObservation(model),document:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')},tip=await journal.save(draft,saved.hash,()=>lease.assert());await lease.recordJournal(journal.knownHashes())
  const section=previous.flowLayout.sections[1],transaction={schemaVersion:'hcd-word-story-link/1' as const,documentId:'region-test',transactionId:randomUUID().replaceAll('-',''),expectedRevision:previous.revision,actor:{userId:actor.userId,displayName:actor.displayName},link:{baseLayoutHash:previous.flowLayoutHash,sectionId:section.id,kind:'header' as const,variant:'even' as const,expectedDirectStoryId:section.headers.even!}}
  const preview=await json('/word/link-preflight',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'7','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Story-Version':'1','X-HCD-Word-Link-Version':'1'},body:JSON.stringify({coordinatorId:lineage,transaction})})
  const pending:WordPendingLink={request:transaction,actor,candidateLayoutHash:preview.candidateLayoutHash,reviewHash:preview.reviewHash};await journal.prepareLink(pending,tip,()=>lease.assert());await lease.recordJournal(journal.knownHashes())
  await writeFile(join(root,'link-marker.json'),JSON.stringify({marker,transactionId:transaction.transactionId}),{mode:0o600})
  proxy=createServer(async(req,res)=>{try{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));commitCalls++;const response=await raw('/word/link-transactions',{method:'POST',headers:req.headers as HeadersInit,body:Buffer.concat(chunks)});const bytes=await response.arrayBuffer();assert.equal(response.status,200,Buffer.from(bytes).toString());res.socket!.destroy()}catch{res.socket?.destroy()}})
  await new Promise<void>(resolve=>proxy!.listen(0,'127.0.0.1',resolve))
  await assert.rejects(submitPreparedWordLink(options));assert.equal(commitCalls,1);const head=await json('/revisions?limit=1');assert.equal(head.headRevision,previous.revision+1)
  const unknown=(await journal.load())!;assert.deepEqual(unknown.capsule.pendingLink,pending);await writeFile(join(out,'commit-drop.json'),JSON.stringify({scope:'real native commit; TCP proxy drops successful response before stopped coordinator receives it',initial:previous.revision,linkRevision:head.headRevision,transactionId:transaction.transactionId,marker,commitCalls,pendingRetained:true,journalVersion:unknown.capsule.version,normalLinkUI:false,activeRoomReplacement:false,production:false},null,2)+'\n')
 }else{
  const saved=(await journal.load())!;assert.equal(saved.capsule.version,5);const pending=saved.capsule.pendingLink!;assert.ok(pending)
  const result=await recoverCommittedWordLink(options);assert.ok(result.capsule.linkAcknowledgement)
  if(phase==='historical-check'){
   assert.equal(result.historical,true);const head=await json('/revisions?limit=1');assert.equal(head.headRevision,result.headRevision)
   await assert.rejects(promoteRecoveredWordLink(options,pending),/historical-review-required/)
   const {marker}=JSON.parse(await readFile(join(root,'link-marker.json'),'utf8')),doc=new Y.Doc();documents.push(doc);Y.applyUpdate(doc,Buffer.from(result.capsule.document,'base64'));const projection=await json(`/editor?revision=${result.capsule.base.revision}`),model=new WordRegionStore(doc,wordRegionSchema(),'region-test',projection.flowLayout,projection.flowLayoutHash)
   assert.ok(model.capture().regions.some(region=>model.project(region.regionId).textContent.includes(marker)));assert.equal((await journal.load())!.capsule.version,5);assert.equal((await json('/revisions?limit=1')).headRevision,head.headRevision)
   await writeFile(join(out,'historical.json'),JSON.stringify({scope:'actual native historical receipt after canonical restore; retain signed draft and forbid stale promotion',initial:pending.request.expectedRevision,linkRevision:result.capsule.base.revision,headRevision:head.headRevision,transactionId:pending.request.transactionId,marker,historical:true,nativeSignatureVerified:true,promotionRefused:true,signedDraftRetained:true,canonicalHeadUnchanged:true,normalLinkUI:false,activeRoomReplacement:false,production:false},null,2)+'\n')
  }else{
  assert.equal(result.historical,false);const promoted=await promoteRecoveredWordLink(options,pending);assert.equal(promoted.capsule.version,3)
  stopped=false
  coordinator=await WordSaveCoordinator.open({journal,protocol:'hcd-word-regions/2',layoutAwareLive:true,autoSave:false,assertOwnership:()=>lease.assert(),maintainOwnership:()=>lease.renew(),recordDurable:(_hash,hashes)=>lease.recordJournal(hashes),request})
  const {marker}=JSON.parse(await readFile(join(root,'link-marker.json'),'utf8')),text=coordinator.model.capture().regions.map(region=>coordinator!.model.project(region.regionId).textContent).join('\n');assert.ok(text.includes(marker))
  const status=await coordinator.save();assert.equal(status.status,'saved');assert.equal(status.revision,pending.request.expectedRevision+2)
  const latest=await json(`/editor?revision=${status.revision}`);assert.equal(latest.flowLayout.sections[1].headers.even,undefined)
  await writeFile(join(out,'recovered-save.json'),JSON.stringify({scope:'new Node owner after native restart; signed journal/native proof recovery and ordinary coordinator save',initial:pending.request.expectedRevision,linkRevision:result.capsule.base.revision,finalRevision:status.revision,transactionId:pending.request.transactionId,marker,pendingRetainedBeforeRecovery:true,nativeSignatureVerified:true,modelPromotedTo:promoted.capsule.version,privateDraftSaved:true,linkStillApplied:true,linkCommitResubmitted:false,normalLinkUI:false,activeRoomReplacement:false,production:false},null,2)+'\n')
  }
 }
 console.log(JSON.stringify({phase,complete:true,commitCalls}))
}finally{coordinator?.dispose();for(const doc of documents)doc.destroy();if(proxy){proxy.closeAllConnections();await new Promise<void>(resolve=>proxy!.close(()=>resolve()))}await lease.close()}
