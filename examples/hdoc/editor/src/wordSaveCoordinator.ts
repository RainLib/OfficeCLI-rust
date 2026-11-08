/** Server-only regional save owner. Room admission/migration is deliberately
 * separate; importing this class never starts a room or an autosave timer. */
import {createHash,randomUUID} from 'node:crypto'
import * as Y from 'yjs'
import type {Schema} from '@tiptap/pm/model'
import {WordRegionStore,wordRegionSchema,wordRegionStoreField,wordCheckpointContents,wordReceiptContents,type WordRegionProjection} from './wordRegionStore.ts'
import {WordCheckpointJournal,wordSaveCapsule,type WordPendingCheckpoint,type WordSaveBase} from './wordCheckpointJournal.ts'
import {ReferenceAuthorLedger,actorName,validActorId,type AuthenticatedContributor} from './referenceAuthors.ts'
import {businessDraftProblem} from './businessDrafts.ts'
import {semanticBlockFields} from './semanticBlockStore.ts'
import {textFlowFields} from './semanticTextFlow.ts'
import {nodeEditFields} from './extensionEdits.ts'
import {referenceEditField} from './referenceEdits.ts'
import {deletionReviewField} from './deletionReview.ts'
import {inlineDeletionField} from './inlineDeletionReview.ts'
import {imageDraftMap,imageReceiptMap,imageDraftContents,imageIntents,captureImages,reconcileImageBaseline,acknowledgeImages,applyImageReplacement} from './collaborativeImages.ts'
import {validGeometry,type PositionedImage} from './imageDrafts.ts'
import {wordImageRegions,type WordCapturedImage} from './wordImages.ts'
import {WordUploadLedger,type WordUploadActor} from './wordUploads.ts'
import {wordDraftObservation} from './wordDraftObservation.ts'
import {wordCanonicalSources} from './wordCanonicalSources.ts'
import {confirmPreparedWordCheckpoint} from './wordCheckpointRecovery.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'

type Actor={userId:string;displayName?:string;scope:'write'}
export type WordSaveStatus={stateId:string;stateSequence:number;status:'editing'|'saving'|'saved'|'failed'|'conflict';revision:number;pending:boolean;digest:string;imageDigest?:string;uploads?:{active:number;interrupted:number;running:number};problem?:string}
type Options={journal:WordCheckpointJournal;protocol:string;request:(route:string,init?:RequestInit)=>Promise<Response>;document?:Y.Doc;assertOwnership?:()=>void;maintainOwnership?:()=>Promise<void>;recordDurable?:(hash:string,ancestors:readonly string[])=>Promise<void>;schema?:Schema;actorForOrigin?:(origin:unknown)=>Actor|undefined;uploadActorAuthorized?:(actor:WordUploadActor)=>Promise<boolean>;uploadRequest?:(actor:WordUploadActor,route:string,init?:RequestInit)=>Promise<Response>;uploadTimeoutMs?:number;broadcast?:(state:WordSaveStatus)=>void;autoSave?:boolean;idleMs?:number;maxMs?:number;experimentalLayoutDraftOnly?:boolean;layoutAwareLive?:boolean}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const number=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0
const flatten=(model:WordRegionStore)=>model.capture().regions.flatMap(region=>region.blocks)
const allowed=new Set([wordRegionStoreField,'hcdSchema',...Object.values(semanticBlockFields),...Object.values(textFlowFields),referenceEditField,...Object.values(nodeEditFields),deletionReviewField,inlineDeletionField,imageDraftMap,imageReceiptMap])
export class WordSaveCoordinator{
 private readonly stateId=randomUUID().replaceAll('-','')
 private stateSequence=0
 readonly model:WordRegionStore
 readonly uploads:WordUploadLedger
 private base:WordSaveBase
 private attempt:WordPendingCheckpoint|undefined
 private readonly people=new Map<string,AuthenticatedContributor>()
 private readonly ledger:ReferenceAuthorLedger
 private observation:string|undefined
 private lastDigest:string
 private lastObservation:string
 private maintaining=false
 private imageRegions:Map<string,string>
 private canonicalSources:ReturnType<typeof wordCanonicalSources>
 private imageLookups=new Map<string,Promise<PositionedImage>>()
 private recoveries=new Set<string>()
 private decisions:import('./wordCheckpointJournal.ts').WordRecoveryDecision[]=[]
 private generation=0
 private tip:string
 private writes:Promise<unknown>=Promise.resolve()
 private stores:Promise<unknown>=Promise.resolve()
 private confirmingLayout=false
 private readonly layoutWait=new AbortController()
 private problem:string|undefined
 private lastFailure:string|undefined
 private storageFailed=false
 private saving=false
 private fenced=false
 private closed=false
 private draining=false
 private topologyHeld=false
 private topologySealed=false
 private topologySnapshot:string|undefined
 private timer:ReturnType<typeof setTimeout>|undefined
 private firstDirty=0
 private trustedOrigins=new WeakMap<object,Actor>()
 private observer:(_bytes:Uint8Array,origin:unknown)=>void
 private constructor(private options:Options,model:WordRegionStore,base:WordSaveBase,canonical:WordRegionStore,projection:WordRegionProjection,tip:string,restored?:import('./wordCheckpointJournal.ts').WordSaveCapsule){
  this.decisions=structuredClone(restored?.decisions??[])
  for(const id of restored?.recoveries??[])this.recoveries.add(id)
  this.model=model;this.base=base;this.tip=tip;this.attempt=restored?.pending
  for(const actor of restored?.actors??[])this.people.set(actor.userId,actor)
  this.generation=Math.max(0,...[...this.people.values()].map(actor=>actor.generation));this.lastDigest=this.digest()
  this.imageRegions=wordImageRegions(projection);this.canonicalSources=wordCanonicalSources(canonical);this.lastObservation=this.observed()
  this.observation=restored?restored.observation??(this.lastDigest===base.digest&&!this.hasImages()?this.lastObservation:undefined):this.lastObservation
  this.ledger=new ReferenceAuthorLedger(flatten(model),flatten(canonical));this.ledger.restore(restored?.references??[])
  this.uploads=new WordUploadLedger({request:(actor,route,init)=>{if(!options.uploadRequest)throw new Error('word-upload-transport-required');return options.uploadRequest(actor,route,init)},authorize:options.uploadActorAuthorized&&options.uploadRequest?async actor=>{await this.authority();return options.uploadActorAuthorized!(actor)}:undefined,available:()=>!this.closed&&!this.draining&&!this.topologyHeld&&!this.fenced&&!this.problem,timeoutMs:options.uploadTimeoutMs,
   capture:nodeId=>{const regionId=this.imageRegions.get(nodeId);if(!regionId)throw new Error('word-image-region-unknown');return{regionId,revision:this.base.revision,clientId:this.model.document.clientID,seen:imageIntents(this.model.document).filter(entry=>entry.base.nodeId===nodeId)}},
   imageAt:(id,revision)=>this.imageAt(id,revision),persist:()=>this.persist(),changed:()=>{this.emit();if(!this.uploads.pending&&this.state().pending)this.schedule()},
   apply:(record,capture)=>this.change({...record.actor,scope:'write'},()=>{applyImageReplacement(this.model.document,capture,record.assetHash,undefined,record.id)})},restored?.uploads)
  this.observer=(_bytes,origin)=>this.changed(origin);model.document.on('update',this.observer)
 }
 static async open(options:Options){
  options.assertOwnership?.()
  const cooperate=async()=>{try{await options.maintainOwnership?.()}finally{options.assertOwnership?.()}}
  const saved=await options.journal.load(),scope=options.journal.scope
  if(options.layoutAwareLive&&(options.experimentalLayoutDraftOnly||options.protocol!=='hcd-word-regions/2'||saved&&saved.capsule.version!==3))throw new Error('word-layout-coordinator-required')
  if(options.layoutAwareLive&&(!options.assertOwnership||!options.maintainOwnership||!options.recordDurable))throw new Error('word-layout-owner-required')
  if(saved?.capsule.version!==undefined&&saved.capsule.version!==1&&!(saved.capsule.version===3&&(options.experimentalLayoutDraftOnly||options.layoutAwareLive)&&options.protocol==='hcd-word-regions/2'&&(!saved.capsule.pending||options.layoutAwareLive)))throw new Error('word-layout-coordinator-required')
  if(options.experimentalLayoutDraftOnly&&(saved?.capsule.version!==3||options.protocol!=='hcd-word-regions/2'))throw new Error('word-layout-coordinator-required')
  const archives=await options.journal.recoverySnapshots(),handled=new Set(saved?.capsule.recoveries??[])
  for(const archive of archives)if(!handled.has(archive.id)){if(!options.journal.snapshotRecorded(archive.capsule))throw new Error('word-owner-recovery-required');handled.add(archive.id)}
  if(saved)saved.capsule.recoveries=[...handled]
  const json=async(route:string)=>{const response=await options.request(route);if(!response.ok)throw new Error(`word-open:${response.status}`);return response.json()}
  const auth=await json('/auth');if(auth.scope!=='write'||auth.collaborationEpoch!==scope.epoch||auth.collaborationProtocol!==options.protocol)throw new Error('word-authority-changed')
  const revision=saved?.capsule.base.revision??(await json('/revisions?limit=1')).headRevision
  if(!number(revision))throw new Error('word-receipt-invalid')
  const projection=await json(`/editor?revision=${revision}`) as WordRegionProjection,record=await json(`/revisions/${revision}`)
  if(record.revision!==revision||!hex(record.rootHash)||projection.documentId!==scope.documentId||projection.revision!==revision)throw new Error('word-receipt-invalid')
  const schema=options.schema??wordRegionSchema(),document=options.document??new Y.Doc(),cleanDocument=new Y.Doc()
  try{
   await cooperate()
   const canonical=new WordRegionStore(cleanDocument,schema,scope.documentId,projection.flowLayout,projection.flowLayoutHash);canonical.initialize(projection)
   const canonicalBase={revision,rootHash:record.rootHash,layoutHash:projection.flowLayoutHash,digest:hash(canonical.contents())}
   await cooperate()
   if(saved&&(['revision','rootHash','layoutHash','digest'] as const).some(key=>saved.capsule.base[key]!==canonicalBase[key]))throw new Error('word-baseline-invalid')
   const model=new WordRegionStore(document,schema,scope.documentId,projection.flowLayout,projection.flowLayoutHash)
   const emptyDocument=new Y.Doc(),existing=Y.encodeStateAsUpdate(document),empty=Y.encodeStateAsUpdate(emptyDocument);emptyDocument.destroy()
   if(options.document&&!Buffer.from(existing).equals(Buffer.from(empty))&&(!saved||!Buffer.from(existing).equals(Buffer.from(saved.capsule.document,'base64'))))throw new Error('word-host-state-unbound')
   if(saved)Y.applyUpdate(document,Buffer.from(saved.capsule.document,'base64'));else model.initialize(projection)
   await cooperate()
   const owner=new WordSaveCoordinator(options,model,canonicalBase,canonical,projection,saved?.hash??'none',saved?.capsule)
   try{await cooperate();if(!owner.attempt){try{await owner.head()}catch(error){if(error instanceof Error&&error.message==='canonical-changed')owner.problem='canonical-changed';else throw error}}await owner.persist();if(owner.state().pending)owner.schedule();return owner}catch(error){owner.dispose();throw error}
  }catch(error){if(!options.document)document.destroy();throw error}finally{cleanDocument.destroy()}
 }
 private digest(){return hash(this.model.contents())}
 private capsuleVersion():1|3{return this.options.experimentalLayoutDraftOnly||this.options.layoutAwareLive?3:1}
 /** Yield between bounded model phases so the owner can renew before the next
  * CPU-heavy capture. The lease still rejects any already-expired receipt. */
 private async maintainOwnership(){try{await this.options.maintainOwnership?.()}finally{this.options.assertOwnership?.()}}
 imageRegion(nodeId:string){return this.imageRegions.get(nodeId)}
 canonicalBlockRegion(id:string){return this.canonicalSources.block(id)}
 canonicalTextRegion(id:string){return this.canonicalSources.text(id)}
 /** Called immediately before a room packet is applied, after any async
  * authentication. A frozen or disposed coordinator cannot accept it. */
 assertAcceptingPackets(){if(this.closed||this.fenced||this.topologyHeld)throw new Error('word-owner-lost')}
 ownsJournal(journal:WordCheckpointJournal){return this.options.journal===journal}
 isTopologyHeld(){return this.topologyHeld}
 isTopologySealed(){return this.topologyHeld&&this.topologySealed}
 heldSnapshotRecorded(){
  this.assertTopologyHeld()
  const capsule=wordSaveCapsule(this.options.journal.scope,this.model,this.base,[...this.people.values()],this.attempt,{observation:this.observation??'0'.repeat(64),references:this.ledger.proof(),uploads:this.uploads.snapshot(),recoveries:[...this.recoveries],decisions:this.decisions},this.capsuleVersion())
  return this.options.journal.snapshotRecorded(capsule)
 }
 isExperimentalLayoutDraftOnly(){return this.options.experimentalLayoutDraftOnly===true}
 isLayoutAwareLive(){return this.options.layoutAwareLive===true}
 isAutoSaveEnabled(){return this.options.autoSave===true}
 /** A replacement is staged with automatic writes disabled. The trusted host
  * enables them only after publishing the verified room and releasing admission. */
 enableLayoutAutoSave(assertAdmissionReleased:()=>void){
  if(!this.isLayoutAwareLive()||this.closed||this.fenced||this.topologyHeld||this.saving||this.attempt)throw new Error('word-layout-activation-unavailable')
  const proof=assertAdmissionReleased() as unknown
  if(proof&&typeof (proof as PromiseLike<unknown>).then==='function'){void Promise.resolve(proof).catch(()=>{});throw new Error('word-layout-activation-proof-must-be-synchronous')}
  this.options.assertOwnership?.();this.options.autoSave=true
  if(this.state().pending)this.schedule()
 }
 /** Caller must first block packet admission and await drain(). */
 holdForTopology(){this.options.assertOwnership?.();if(this.closed||this.fenced||this.draining||this.topologyHeld||this.attempt||this.uploads.pending||this.storageFailed||this.problem||this.saving||this.state().problem)throw new Error('word-topology-room-not-ready');this.topologySnapshot=hash(Buffer.from(Y.encodeStateAsUpdate(this.model.document)).toString('base64'));this.topologyHeld=true;clearTimeout(this.timer);this.timer=undefined}
 assertTopologyHeld(){this.options.assertOwnership?.();if(!this.topologyHeld||this.closed||this.fenced)throw new Error('word-topology-room-not-held');if(this.topologySnapshot!==hash(Buffer.from(Y.encodeStateAsUpdate(this.model.document)).toString('base64')))throw new Error('word-topology-room-changed')}
 sealTopologyHold(){this.assertTopologyHeld();this.topologySealed=true}
 /** Only safe before a topology request has been durably prepared. */
 releaseTopologyHold(){this.assertTopologyHeld();if(this.topologySealed)throw new Error('word-topology-room-sealed');this.topologyHeld=false;this.topologySnapshot=undefined;if(this.state().pending)this.schedule()}
 private hasImages(){return this.model.document.getMap(imageDraftMap).size>0}
 private imageDigest(){return hash(imageDraftContents(this.model.document))}
 private observed(){
  return wordDraftObservation(this.model)
 }
 /** Canonical rebindings/rebases alter bookkeeping, never author generations.
  * Preserve an unbound observation rather than laundering an unknown edit. */
 private maintain(work:()=>void){
  const bound=this.observation===this.observed();this.maintaining=true
  try{work()}finally{this.maintaining=false;this.lastDigest=this.digest();this.lastObservation=this.observed();if(bound)this.observation=this.lastObservation}
 }
 private changed(origin:unknown){
  if(this.closed||this.maintaining)return
  try{
   const digest=this.digest(),observation=this.observed();if(observation===this.lastObservation){const state=this.emit();if(!this.saving&&state.pending)this.schedule();return}
   const wasBound=this.observation===this.lastObservation
   const actor=(origin&&typeof origin==='object'?this.trustedOrigins.get(origin):undefined)??this.options.actorForOrigin?.(origin)
   const trusted=wasBound&&actor?.scope==='write'&&validActorId(actor.userId)?{userId:actor.userId,displayName:actorName(actor.displayName??actor.userId),generation:++this.generation}:undefined
   this.lastDigest=digest;this.lastObservation=observation;this.observation=trusted?observation:undefined
   if(trusted)this.people.set(trusted.userId,trusted)
   this.ledger.observe(flatten(this.model),trusted);this.emit();this.schedule()
  }catch{this.problem='word-model-invalid';this.emit()}
 }
 /** Only a trusted host may use this mutation helper. Remote packets instead
  * supply actorForOrigin from authenticated server connection objects. */
 change(actor:Actor,work:()=>void){
  this.options.assertOwnership?.()
  if(this.closed||this.draining||this.topologyHeld||this.fenced||this.problem||actor.scope!=='write'||!validActorId(actor.userId))throw new Error('word-change-unavailable')
  const origin={};this.trustedOrigins.set(origin,actor)
  try{this.model.document.transact(work,origin)}finally{this.trustedOrigins.delete(origin)}
 }
 private contentProblem(){
  try{captureImages(this.model.document)}catch(error){return error instanceof Error&&['image-drafts-conflict','image-drafts-not-ready'].includes(error.message)?error.message:'word-image-schema-invalid'}
  for(const [field,value]of this.model.document.share)if(!allowed.has(field)&&(value instanceof Y.Map?value.size:value instanceof Y.Array||value instanceof Y.Text||value instanceof Y.XmlFragment?value.length:1))return 'word-unknown-shared-data'
  return businessDraftProblem(this.model.document,this.model.structure.project())
 }
 state():WordSaveStatus{
  let digest=this.lastDigest,problem=this.fenced?'word-owner-lost':this.problem??this.lastFailure
  try{this.options.assertOwnership?.()}catch{problem??='word-owner-lost'}
  if(this.uploads.summary.interrupted)problem??='word-upload-interrupted'
  try{digest=this.digest();problem??=this.contentProblem();if((digest!==this.base.digest||this.hasImages())&&this.observation!==this.observed())problem??='contributors-unbound'}catch{problem??='word-model-invalid'}
  const pending=!!this.attempt||digest!==this.base.digest||this.hasImages()||this.uploads.pending||this.storageFailed||!!problem
  let imageDigest:string|undefined;try{imageDigest=this.imageDigest()}catch{/* Invalid schema already reports a pending failure. */}
  return{stateId:this.stateId,stateSequence:++this.stateSequence,status:this.saving?'saving':problem?problem==='canonical-changed'||problem==='word-authority-changed'||problem==='word-journal-changed'||problem==='word-owner-lost'?'conflict':'failed':this.storageFailed?'failed':pending?'editing':'saved',revision:this.base.revision,pending,digest,imageDigest,uploads:this.uploads.summary,...(problem?{problem}:this.storageFailed?{problem:'word-journal-write-failed'}:{})}
 }
 private emit(){const state=this.state();if(!this.closed)this.options.broadcast?.(state);return state}
 private schedule(delay?:number){
  if(!this.options.autoSave||this.options.experimentalLayoutDraftOnly||this.closed||this.draining||this.topologyHeld||this.fenced||this.problem||this.uploads.pending)return
  if(!this.firstDirty)this.firstDirty=Date.now()
  clearTimeout(this.timer)
  const due=delay??Math.max(0,Math.min(this.options.idleMs??30_000,this.firstDirty+(this.options.maxMs??60_000)-Date.now()))
  this.timer=setTimeout(()=>{this.timer=undefined;void this.save().catch(()=>{})},due)
 }
 persist():Promise<void>{
  const work=this.stores.catch(()=>{}).then(()=>this.persistNow())
  this.stores=work;return work
 }
 private async persistNow(){
   // Once fenced, this owner must never resume writing even if the lease
   // callback later starts succeeding. Recovery belongs to a new owner.
   if(this.fenced)throw new Error('word-owner-lost')
   if(this.topologyHeld)throw new Error('word-topology-room-held')
   this.options.assertOwnership?.()
   for(const archive of await this.options.journal.recoverySnapshots())if(!this.recoveries.has(archive.id)){if(!this.options.journal.snapshotRecorded(archive.capsule)){this.problem='word-owner-recovery-required';throw new Error('word-owner-recovery-required')}this.recoveries.add(archive.id)}
   const capsule=wordSaveCapsule(this.options.journal.scope,this.model,this.base,[...this.people.values()],this.attempt,{observation:this.observation??'0'.repeat(64),references:this.ledger.proof(),uploads:this.uploads.snapshot(),recoveries:[...this.recoveries],decisions:this.decisions},this.capsuleVersion())
   try{const tip=this.options.layoutAwareLive&&this.tip==='none'?await this.options.journal.initializeLayout(capsule,this.options.assertOwnership!):await this.options.journal.save(capsule,this.tip,this.options.assertOwnership);await this.options.recordDurable?.(tip,this.options.journal.knownHashes());this.options.assertOwnership?.();this.tip=tip;this.storageFailed=false}
   catch(error){this.storageFailed=true;if(error instanceof Error&&error.message==='word-journal-published-fence-lost')this.freeze();else if(error instanceof Error&&error.message==='word-journal-changed')this.problem='word-journal-changed';throw error}
 }
 private async json(route:string){const response=await this.options.request(route);if(!response.ok)throw new Error(`word-read:${response.status}`);return response.json()}
 private async authority(){const auth=await this.json('/auth');if(auth.scope!=='write'||auth.collaborationEpoch!==this.options.journal.scope.epoch||auth.collaborationProtocol!==this.options.protocol)throw new Error('word-authority-changed')}
 private async head(){const head=await this.json('/revisions?limit=1');if(head.headRevision!==this.base.revision)throw new Error('canonical-changed')}
 private imageAt(nodeId:string,revision:number){
  const key=`${revision}:${nodeId}`,existing=this.imageLookups.get(key);if(existing)return existing
  const lookup=(async()=>{
   const response=await this.options.request(`/images/${encodeURIComponent(nodeId)}?revision=${revision}`)
   if(response.status===401||response.status===403)throw new Error('word-authority-changed')
   if(!response.ok)throw new Error(response.status>=400&&response.status<500&&![408,429].includes(response.status)?'word-image-baseline-invalid':`word-image-read:${response.status}`)
   const value=await response.json(),image=value.image as PositionedImage|undefined
   if(value.revision!==revision||image?.nodeId!==nodeId||!hex(image.visualHash)||image.assetHash!=null&&!hex(image.assetHash)||!image.geometry||!['pt','emu'].includes(image.geometry.unit)||!validGeometry(image.geometry))throw new Error('word-image-baseline-invalid');return image
  })().catch(error=>{this.imageLookups.delete(key);throw error})
  this.imageLookups.set(key,lookup);if(this.imageLookups.size>2048)this.imageLookups.delete(this.imageLookups.keys().next().value!);return lookup
 }
 private async prepareImages():Promise<WordCapturedImage[]>{
  const before=imageDraftContents(this.model.document),entries=imageIntents(this.model.document),current=new Map<string,PositionedImage>(),originals=new Map<string,PositionedImage>()
  for(let start=0;start<entries.length;start+=4)await Promise.all(entries.slice(start,start+4).map(async entry=>{
   if(!this.imageRegions.has(entry.base.nodeId))throw new Error('word-image-region-unknown')
   if(entry.revision>this.base.revision)throw new Error('word-image-baseline-invalid')
   const saved=await this.imageAt(entry.base.nodeId,this.base.revision);current.set(saved.nodeId,saved)
   if(entry.base.visualHash!==saved.visualHash)originals.set(entry.intentId,await this.imageAt(entry.base.nodeId,entry.revision))
  }))
  if(this.closed)throw new Error('word-owner-closed')
  if(imageDraftContents(this.model.document)!==before)throw new Error('word-images-changed')
  try{this.maintain(()=>{for(const saved of current.values())reconcileImageBaseline(this.model.document,saved,this.base.revision,originals,{kind:'word-image-baseline'})})}catch{throw new Error('word-image-baseline-invalid')}
  return captureImages(this.model.document).map(image=>({...image,regionId:this.imageRegions.get(image.change.nodeId)!}))
 }
 private async confirmedImages(captured:WordCapturedImage[],revision:number){
  const images:PositionedImage[]=[]
  for(let start=0;start<captured.length;start+=4)images.push(...await Promise.all(captured.slice(start,start+4).map(image=>this.imageAt(image.change.nodeId,revision))))
  return images
 }
 private async layoutRequest(route:string,init:RequestInit={}){
  const signal=AbortSignal.any([this.layoutWait.signal,AbortSignal.timeout(30_000),...(init.signal?[init.signal]:[])])
  const response=await awaitRecoveryResponse(()=>this.options.request(route,{...init,signal}),signal)
  if(!response.ok){void response.body?.cancel().catch(()=>{});return new Response(null,{status:response.status,statusText:response.statusText,headers:response.headers})}
  const bytes=await readBoundedResponse(response,16*1024*1024,signal,'word-layout-response-limit')
  return new Response(bytes.length?bytes:null,{status:response.status,statusText:response.statusText,headers:response.headers})
 }
 private assertLayoutConfirmation(pending:WordPendingCheckpoint){
  this.options.assertOwnership?.()
  if(!this.confirmingLayout||this.closed||this.fenced||this.topologyHeld||this.attempt!==pending)throw new Error('word-owner-lost')
 }
 private async saveLayoutCapture(pending:WordPendingCheckpoint){
  const init={method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify(pending.request)}
  // Keep the journal writer available during submission, so onStoreDocument
  // can durably record late input with the exact unchanged pending identity.
  let response=await this.layoutRequest('/word/checkpoint-receipt',init)
  if(response.status===404)response=await this.layoutRequest('/word/checkpoints',init)
  if(!response.ok){
   if(response.status===401||response.status===403)throw new Error('word-authority-changed')
   if(response.status===409){await this.head();throw new Error('word-layout-request-retry')}
   throw new Error(`word-layout-request:${response.status}`)
  }
  // Read and authenticate the result again at the serialized journal boundary.
  // The first response may be bound to a tip preceding another durable input.
  void response.body?.cancel().catch(()=>{})
  const work=this.stores.catch(()=>{}).then(async()=>{
   this.confirmingLayout=true
   try{
    await this.persistNow();this.assertLayoutConfirmation(pending)
    const result=await confirmPreparedWordCheckpoint({journal:this.options.journal,
     lease:{assert:()=>this.assertLayoutConfirmation(pending),renew:()=>this.maintainOwnership(),recordJournal:async hashes=>{await this.options.recordDurable!(hashes.at(-1)!,hashes)}},
     request:(route,init)=>this.layoutRequest(route,init),assertJournalExclusive:()=>this.assertLayoutConfirmation(pending),receiptFirst:true})
    this.assertLayoutConfirmation(pending)
    const projection=result.projection;if(!projection)throw new Error('word-checkpoint-receipt-invalid')
    const acknowledged=new Y.Doc(),canonicalDoc=new Y.Doc()
    try{
     Y.applyUpdate(acknowledged,Buffer.from(result.capsule.document,'base64'))
     const canonical=new WordRegionStore(canonicalDoc,this.model.schema,this.model.documentId,projection.flowLayout,projection.flowLayoutHash);canonical.initialize(projection)
     const sources=wordCanonicalSources(canonical),regions=wordImageRegions(projection)
     const bound=this.observation===this.observed()
     this.maintain(()=>{Y.applyUpdate(this.model.document,Y.encodeStateAsUpdate(acknowledged));this.model.syncLayout(projection.flowLayout,projection.flowLayoutHash)})
     this.tip=result.tip;this.base=result.capsule.base;this.imageRegions=regions;this.canonicalSources=sources
     this.ledger.commit(pending.capture.regions.flatMap(region=>region.blocks))
     if(bound)for(const actor of pending.actors)if((this.people.get(actor.userId)?.generation??-1)<=actor.generation)this.people.delete(actor.userId)
     this.attempt=undefined
     if(result.headAdvanced)this.problem='canonical-changed'
     await this.persistNow()
    }finally{acknowledged.destroy();canonicalDoc.destroy()}
   }catch(error){
    // Once an acknowledgement was published, an old in-memory owner cannot
    // append over it. Preserve its newest replica separately for recovery.
    let uncertain=false;try{uncertain=(await this.options.journal.load())?.hash!==this.tip}catch{uncertain=true}
    if(uncertain){try{await this.archiveRecovery('word-owner-layout-ack')}catch{this.freeze()}}
    throw error
   }finally{this.confirmingLayout=false}
  })
  this.stores=work;await work
 }
 save(requestedDigest?:string,requestedImages?:string):Promise<WordSaveStatus>{
  if(this.options.experimentalLayoutDraftOnly)return Promise.reject(new Error('word-layout-live-save-unavailable'))
  if(this.draining||this.topologyHeld)return Promise.reject(new Error('word-owner-draining'))
  const work=this.writes.catch(()=>{}).then(()=>this.saveNow(requestedDigest,requestedImages));this.writes=work;return work
 }
 private async saveNow(requestedDigest?:string,requestedImages?:string):Promise<WordSaveStatus>{
  if(this.closed)throw new Error('word-owner-closed')
  clearTimeout(this.timer);this.timer=undefined
  if(this.fenced||this.problem)return this.emit()
  if(requestedDigest&&requestedDigest!==this.digest()||requestedImages&&requestedImages!==this.imageDigest())return{...this.state(),status:'editing',problem:'sync-required'}
  this.lastFailure=undefined;this.saving=true;this.emit()
  try{
   await this.maintainOwnership()
   await this.authority()
   if(!this.attempt){
    if(this.uploads.pending){await this.persist();return this.finish()}
    await this.head()
    const problem=this.contentProblem();if(problem)throw new Error(problem)
    if(this.digest()!==this.base.digest||this.hasImages()){
     if(this.observation!==this.observed()||!this.people.size)throw new Error('contributors-unbound')
     const images=await this.prepareImages()
     if(this.uploads.pending){await this.persist();return this.finish()}
     if(this.observation!==this.observed())throw new Error('contributors-unbound')
     if(requestedDigest&&requestedDigest!==this.digest()||requestedImages&&requestedImages!==this.imageDigest())return{...this.finish(),status:'editing',problem:'sync-required'}
     const capture=this.model.capture(),authors=this.ledger.capture(capture.regions.flatMap(region=>region.blocks)),people=new Map([...this.people])
     for(const actor of authors.contributors){const current=people.get(actor.userId);if(!current||current.generation<actor.generation)people.set(actor.userId,actor)}
     const actors=[...people.values()].sort((a,b)=>a.userId.localeCompare(b.userId))
     this.attempt={capture,actors,images,request:{coordinatorVersion:this.options.layoutAwareLive?6:5,coordinatorId:this.options.journal.scope.lineage,checkpointId:randomUUID().replaceAll('-',''),coordinatorDigest:hash(wordCheckpointContents(capture)),expectedRevision:this.base.revision,layoutHash:capture.layoutHash,typographyVersion:2,extensionVersion:1,referenceVersion:1,referenceAuthors:authors.referenceAuthors,regions:capture.regions.map(region=>({...region,images:images.filter(image=>image.regionId===region.regionId).map(image=>image.change)})),contributors:actors.map(({userId,displayName})=>({userId,displayName}))}}
    }
   }
   // This also retries a failed post-acknowledgement backup before allowing a
   // new canonical request. A journal error never reports the room as saved.
   await this.maintainOwnership();await this.persist()
   if(!this.attempt){this.firstDirty=0;return this.finish()}
   if(this.options.layoutAwareLive){await this.saveLayoutCapture(this.attempt);await this.head();this.firstDirty=0;return this.finish()}
   this.options.assertOwnership?.()
   const pending=this.attempt,response=await this.options.request('/word/checkpoints',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending.request)})
   if(this.closed)throw new Error('word-owner-closed')
   if(!response.ok)throw new Error(response.status===409?'canonical-changed':response.status===401||response.status===403?'word-authority-changed':`word-save:${response.status}`)
   const saved=await response.json() as {saved:boolean;revision:number;rootHash:string;projection:WordRegionProjection;saveMode?:string},record=number(saved.revision)?await this.json(`/revisions/${saved.revision}`):null
   if(saved.saved!==true||!hex(saved.rootHash)||saved.projection?.revision!==saved.revision||record?.rootHash!==saved.rootHash)throw new Error('word-receipt-invalid')
   if(saved.revision===this.base.revision){if(saved.saveMode!=='word-regions-unchanged'||saved.rootHash!==this.base.rootHash)throw new Error('word-receipt-invalid')}
   else if(!this.options.journal.verifyCheckpointRecord(record,pending.request))throw new Error('word-receipt-invalid')
   const capturedImages=pending.images??[],images=await this.confirmedImages(capturedImages,saved.revision),canonicalDocument=new Y.Doc()
   let canonicalDigest:string,nextSources:ReturnType<typeof wordCanonicalSources>
   try{await this.maintainOwnership();const canonical=new WordRegionStore(canonicalDocument,this.model.schema,this.model.documentId,saved.projection.flowLayout,saved.projection.flowLayoutHash);canonical.initialize(saved.projection);canonicalDigest=hash(canonical.contents());if(canonicalDigest!==pending.request.coordinatorDigest&&wordReceiptContents(canonical.capture())!==wordReceiptContents(pending.capture))throw new Error('word-receipt-content-mismatch');nextSources=wordCanonicalSources(canonical)}finally{canonicalDocument.destroy()}
   await this.maintainOwnership()
   // Validate all image acknowledgements against the live late intents before
   // rebinding any real text sources. An invalid receipt changes neither.
   const probe=new Y.Doc();try{Y.applyUpdate(probe,Y.encodeStateAsUpdate(this.model.document));acknowledgeImages(probe,capturedImages,images,saved.revision,{kind:'word-image-probe'})}catch{throw new Error('word-image-receipt-invalid')}finally{probe.destroy()}
   const imageRegions=wordImageRegions(saved.projection)
   if(capturedImages.some(image=>imageRegions.get(image.change.nodeId)!==image.regionId))throw new Error('word-image-receipt-invalid')
   if(this.closed)throw new Error('word-owner-closed')
   this.options.assertOwnership?.()
   this.maintain(()=>{this.model.acceptSources(pending.capture,saved.projection);acknowledgeImages(this.model.document,capturedImages,images,saved.revision,{kind:'word-image-receipt'})});this.imageRegions=imageRegions;this.canonicalSources=nextSources
   const currentDigest=this.digest(),hasBusiness=[...Object.values(nodeEditFields),referenceEditField,deletionReviewField,inlineDeletionField].some(field=>this.model.document.getMap(field).size)
   if(currentDigest===canonicalDigest&&!this.hasImages()&&(!hasBusiness||this.observation===this.lastObservation)){this.observation=this.observed();this.lastDigest=currentDigest}
   this.ledger.commit(pending.capture.regions.flatMap(region=>region.blocks))
   for(const actor of pending.actors)if((this.people.get(actor.userId)?.generation??-1)<=actor.generation)this.people.delete(actor.userId)
   this.base={revision:saved.revision,rootHash:saved.rootHash,layoutHash:saved.projection.flowLayoutHash,digest:canonicalDigest};this.attempt=undefined
   await this.persist();await this.head();this.firstDirty=0
   return this.finish()
  }catch(error){
   const reason=error instanceof Error?error.message:'word-save-failed';this.lastFailure=reason
   if(['canonical-changed','word-authority-changed','word-receipt-invalid','word-receipt-content-mismatch','word-journal-changed','word-model-invalid','word-image-baseline-invalid','word-image-region-unknown','word-image-receipt-invalid','word-owner-lost','word-checkpoint-receipt-invalid','word-checkpoint-content-mismatch','word-checkpoint-projection-invalid','word-checkpoint-baseline-invalid'].includes(reason)||/^word-(?:save|layout-request):4(?!08$|29$)\d\d$/.test(reason))this.problem=reason
   // Unknown network outcomes keep exactly the prepared request. Persist late
   // updates even after a rejected/revoked request, but never invent a retry ID.
   try{await this.persist()}catch{/* The previous durable chain remains intact. */}
   this.saving=false;this.emit();if(!this.problem)this.schedule(5000);throw error
  }
 }
 private finish(){clearTimeout(this.timer);this.timer=undefined;this.saving=false;const state=this.emit();if(state.pending)this.schedule();return state}
 freeze(){this.fenced=true;this.problem='word-owner-lost';this.layoutWait.abort(new Error('word-owner-lost'));clearTimeout(this.timer);this.timer=undefined;this.uploads.dispose();this.emit()}
 async archiveRecovery(reason='word-owner-lost'){this.freeze();const capsule=wordSaveCapsule(this.options.journal.scope,this.model,this.base,[...this.people.values()],this.attempt,{observation:this.observation??'0'.repeat(64),references:this.ledger.proof(),uploads:this.uploads.snapshot(),recoveries:[...this.recoveries],decisions:this.decisions},this.capsuleVersion());return this.options.journal.archiveSnapshot(capsule,reason)}
 async drain(){this.draining=true;clearTimeout(this.timer);this.timer=undefined;try{await this.uploads.drain();await this.writes.catch(()=>{});await this.persist()}finally{clearTimeout(this.timer);this.timer=undefined;this.draining=false}}
 dispose(){this.closed=true;this.layoutWait.abort(new Error('word-owner-closed'));this.uploads.dispose();clearTimeout(this.timer);this.model.document.off('update',this.observer)}
}
