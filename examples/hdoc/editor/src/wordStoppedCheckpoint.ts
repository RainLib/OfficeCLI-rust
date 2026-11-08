/** Prepare a version-6 checkpoint from a durable, stopped layout-aware room.
 * This does not reopen the room or submit a document revision. */
import {createHash,randomUUID} from 'node:crypto'
import * as Y from 'yjs'
import {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,wordCheckpointContents,wordRegionStoreField,type WordRegionProjection} from './wordRegionStore.ts'
import {ReferenceAuthorLedger} from './referenceAuthors.ts'
import {wordDraftObservation} from './wordDraftObservation.ts'
import {businessDraftProblem} from './businessDrafts.ts'
import {imageDraftContents,imageDraftMap,imageReceiptMap,imageIntents,captureImages,reconcileImageBaseline} from './collaborativeImages.ts'
import {validGeometry,type PositionedImage} from './imageDrafts.ts'
import {wordImageRegions} from './wordImages.ts'
import {semanticBlockFields} from './semanticBlockStore.ts'
import {textFlowFields} from './semanticTextFlow.ts'
import {nodeEditFields} from './extensionEdits.ts'
import {referenceEditField} from './referenceEdits.ts'
import {deletionReviewField} from './deletionReview.ts'
import {inlineDeletionField} from './inlineDeletionReview.ts'

type Lease={assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>}
type Options={journal:WordCheckpointJournal;lease:Lease;request:(route:string,init?:RequestInit)=>Promise<Response>;assertStopped:()=>void;initiator?:{userId:string;displayName:string};checkpointId?:string}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const allowed=new Set([wordRegionStoreField,'hcdSchema',...Object.values(semanticBlockFields),...Object.values(textFlowFields),referenceEditField,...Object.values(nodeEditFields),deletionReviewField,inlineDeletionField,imageDraftMap,imageReceiptMap])
export async function prepareStoppedWordCheckpoint({journal,lease,request,assertStopped,initiator:inputInitiator,checkpointId}:Options){
 if(checkpointId!==undefined&&!/^[a-f0-9]{32}$/.test(checkpointId))throw new Error('word-checkpoint-id-invalid')
 const initiator=inputInitiator?structuredClone(inputInitiator):undefined
 const guard=()=>{assertStopped();lease.assert()}
 const maintain=async()=>{guard();await lease.renew();guard()}
 const json=async(route:string)=>{const response=await request(route);if(!response.ok)throw new Error(`word-checkpoint-prepare:${response.status}`);return response.json()}
 const authority=async()=>{const auth=await json('/auth');guard();if(auth.scope!=='write'||auth.collaborationEpoch!==journal.scope.epoch||auth.collaborationProtocol!=='hcd-word-regions/2')throw new Error('word-authority-changed')}
 const head=async(revision:number)=>{if((await json('/revisions?limit=1')).headRevision!==revision)throw new Error('canonical-changed');guard()}
 guard();const saved=await journal.load();guard()
 if(!saved||saved.capsule.version!==3||saved.capsule.pending)throw new Error('word-checkpoint-pending-unresolved')
 if(checkpointId&&await journal.checkpointAbandoned(checkpointId))throw new Error('word-checkpoint-cancelled')
 if(checkpointId&&await journal.checkpointUsed(checkpointId,guard))throw new Error('word-checkpoint-id-used')
 if(saved.capsule.uploads?.some(upload=>['reserved','staged','interrupted'].includes(upload.phase)))throw new Error('word-upload-interrupted')
 await maintain();await authority();await lease.recordJournal(journal.knownHashes());guard();await head(saved.capsule.base.revision)
 const revision=saved.capsule.base.revision,[projection,record]=await Promise.all([json(`/editor?revision=${revision}`),json(`/revisions/${revision}`)]) as [WordRegionProjection,{revision:number;rootHash:string}]
 guard();if(record.revision!==revision||record.rootHash!==saved.capsule.base.rootHash||projection.documentId!==journal.scope.documentId||projection.revision!==revision||projection.flowLayoutHash!==saved.capsule.base.layoutHash)throw new Error('word-checkpoint-baseline-invalid')
 const schema=wordRegionSchema(),canonicalDoc=new Y.Doc(),draftDoc=new Y.Doc()
 try{
  const canonical=new WordRegionStore(canonicalDoc,schema,journal.scope.documentId,projection.flowLayout,projection.flowLayoutHash);canonical.initialize(projection)
  if(hash(canonical.contents())!==saved.capsule.base.digest)throw new Error('word-checkpoint-baseline-invalid')
  Y.applyUpdate(draftDoc,Buffer.from(saved.capsule.document,'base64'));const model=new WordRegionStore(draftDoc,schema,journal.scope.documentId,projection.flowLayout,projection.flowLayoutHash)
  for(const [field,value]of draftDoc.share)if(!allowed.has(field)&&(value instanceof Y.Map?value.size:value instanceof Y.Array||value instanceof Y.Text||value instanceof Y.XmlFragment?value.length:1))throw new Error('word-unknown-shared-data')
  const problem=businessDraftProblem(draftDoc,model.structure.project());if(problem)throw new Error(problem)
  const bound=saved.capsule.observation===wordDraftObservation(model),regions=wordImageRegions(projection),entries=imageIntents(draftDoc)
  if((hash(model.contents())!==saved.capsule.base.digest||entries.length)&&(!bound||!saved.capsule.actors.length))throw new Error('contributors-unbound')
  const current=new Map<string,PositionedImage>(),originals=new Map<string,PositionedImage>(),lookups=new Map<string,Promise<PositionedImage>>()
  const imageAt=(nodeId:string,at:number)=>{const key=`${at}:${nodeId}`;let work=lookups.get(key);if(!work){work=(async()=>{const value=await json(`/images/${encodeURIComponent(nodeId)}?revision=${at}`),image=value.image as PositionedImage|undefined;guard();if(value.revision!==at||image?.nodeId!==nodeId||!hex(image.visualHash)||image.assetHash!=null&&!hex(image.assetHash)||!image.geometry||!['pt','emu'].includes(image.geometry.unit)||!validGeometry(image.geometry))throw new Error('word-image-baseline-invalid');return image})();lookups.set(key,work)}return work}
  for(let start=0;start<entries.length;start+=4){await maintain();await Promise.all(entries.slice(start,start+4).map(async entry=>{if(!regions.has(entry.base.nodeId)||entry.revision>revision)throw new Error('word-image-baseline-invalid');const image=await imageAt(entry.base.nodeId,revision);current.set(image.nodeId,image);if(entry.base.visualHash!==image.visualHash)originals.set(entry.intentId,await imageAt(entry.base.nodeId,entry.revision))}));guard()}
  const beforeImages=imageDraftContents(draftDoc)
  try{for(const image of current.values())reconcileImageBaseline(draftDoc,image,revision,originals,{kind:'word-image-baseline'})}catch{throw new Error('word-image-baseline-invalid')}
  const images=captureImages(draftDoc).map(image=>({...image,regionId:regions.get(image.change.nodeId)!}))
  if(hash(model.contents())===saved.capsule.base.digest&&!images.length)return{prepared:false as const,tip:saved.hash}
  const capture=model.capture(),ledger=new ReferenceAuthorLedger(capture.regions.flatMap(region=>region.blocks),canonical.capture().regions.flatMap(region=>region.blocks));ledger.restore(saved.capsule.references??[])
  const authors=ledger.capture(capture.regions.flatMap(region=>region.blocks)),people=new Map(saved.capsule.actors.map(actor=>[actor.userId,actor]));for(const actor of authors.contributors)if((people.get(actor.userId)?.generation??-1)<actor.generation)people.set(actor.userId,actor)
  const actors=[...people.values()].sort((a,b)=>a.userId.localeCompare(b.userId)),payload={coordinatorVersion:6 as const,coordinatorId:journal.scope.lineage,checkpointId:checkpointId??randomUUID().replaceAll('-',''),coordinatorDigest:hash(wordCheckpointContents(capture)),expectedRevision:revision,layoutHash:capture.layoutHash,typographyVersion:2 as const,extensionVersion:1 as const,referenceVersion:1 as const,referenceAuthors:authors.referenceAuthors,regions:capture.regions.map(region=>({...region,images:images.filter(image=>image.regionId===region.regionId).map(image=>image.change)})),contributors:actors.map(({userId,displayName})=>({userId,displayName}))}
  const capsule=structuredClone(saved.capsule);delete capsule.checkpointAcknowledgement;delete capsule.unchangedAcknowledgement;delete capsule.staleRebase;capsule.actors=actors;capsule.document=Buffer.from(Y.encodeStateAsUpdate(draftDoc)).toString('base64');if(bound&&beforeImages!==imageDraftContents(draftDoc))capsule.observation=wordDraftObservation(model);capsule.pending={request:payload,capture,actors,images,...(initiator?{initiator}:{})}
  await maintain();await authority();await head(revision);guard();if(checkpointId&&await journal.checkpointAbandoned(checkpointId))throw new Error('word-checkpoint-cancelled');guard();const tip=await journal.save(capsule,saved.hash,guard)
  guard();await lease.recordJournal(journal.knownHashes());guard();return{prepared:true as const,tip}
 }finally{canonicalDoc.destroy();draftDoc.destroy()}
}
