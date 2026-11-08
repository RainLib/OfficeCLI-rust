/** Server-only durable preparation. Nothing here activates a browser room or
 * supplies distributed ownership; native revision CAS remains authoritative. */
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto'
import * as fs from 'node:fs/promises'
import {constants} from 'node:fs'
import {join,resolve} from 'node:path'
import {gzip,gunzip} from 'node:zlib'
import {promisify} from 'node:util'
import * as Y from 'yjs'
import {wordCheckpointContents,wordReceiptContents,wordRegionStoreField,WordRegionStore,wordRegionSchema,verifyWordStoryReceipt,verifyWordLinkReceipt,wordContainsBaseline,type WordRegionCapture,type WordRegionProjection} from './wordRegionStore.ts'
import {validateSourceLeaf} from './semanticSourceBindings.ts'
import {ReferenceAuthorLedger,validContributor,type AuthenticatedContributor,type ReferenceAuthor,type ReferenceAuthorEntry} from './referenceAuthors.ts'
import {wordDraftObservation} from './wordDraftObservation.ts'
import {readInlineReference} from './inlineReference.ts'
import {validateCapturedImages,acknowledgeImages,type CapturedImage} from './collaborativeImages.ts'
import {wordImageRegions} from './wordImages.ts'
import type {ImageNode} from './ImagePanel.tsx'
import type {WordCapturedImage} from './wordImages.ts'
import {validateWordUploads,type WordUploadRecord} from './wordUploads.ts'
import {projectionToJson,type Block} from './schema.ts'
import type {WordStory} from './wordRegions.ts'
import type {WordStoryUnlinkIntent} from './wordLayoutTransition.ts'
import {readWordPendingLink,verifyWordLinkReceipt as verifyLinkSignature,type WordPendingLink,type WordLinkAcknowledgement} from './wordLinkProof.ts'
import {prepareLinkCapsule,promoteLinkCapsule,assertWordLinkJournalTransition,type WordLinkJournalAction} from './wordLinkJournalState.ts'

const compress=promisify(gzip),decompress=promisify(gunzip),limit=32*1024*1024
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex')
const hex=(value:unknown,size=64):value is string=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${size}}$`).test(value)
const safeInt=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0
const fingerprint=(capsule:WordSaveCapsule)=>{const{recoveries:_,...value}=capsule;return hash(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item))}
/** Region fence identities are immutable until an authenticated topology
 * transaction has a dedicated recovery protocol. A normal save may update
 * layout fields, but cannot silently install a different set of carriers. */
function topologyFingerprint(capsule:WordSaveCapsule){
 const doc=new Y.Doc();try{Y.applyUpdate(doc,Buffer.from(capsule.document,'base64'));return hash(JSON.stringify(doc.getMap(wordRegionStoreField).get('regions'),(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item))}finally{doc.destroy()}
}
const cleanLayoutGenesis=(capsule:WordSaveCapsule)=>capsule.version===3&&!capsule.pending&&!capsule.pendingLayout&&!capsule.pendingStory&&!capsule.pendingLink&&!capsule.linkAcknowledgement&&!capsule.layoutAcknowledgement&&!capsule.storyAcknowledgement&&!capsule.checkpointAcknowledgement&&!capsule.unchangedAcknowledgement&&!capsule.staleRebase&&capsule.actors.length===0&&(capsule.references?.length??0)===0&&(capsule.uploads?.length??0)===0&&(capsule.recoveries?.length??0)===0&&(capsule.decisions?.length??0)===0&&hex(capsule.observation)
const promoteLayout=(capsule:WordSaveCapsule)=>{const next=structuredClone(capsule);next.version=3;delete next.layoutAcknowledgement;return next}
const prepareLayoutCapsule=(capsule:WordSaveCapsule,pending:WordLayoutPending)=>{const next=structuredClone(capsule);next.version=2;delete next.checkpointAcknowledgement;delete next.unchangedAcknowledgement;delete next.staleRebase;next.pendingLayout=structuredClone(pending);return next}
const prepareStoryCapsule=(capsule:WordSaveCapsule,pending:WordPendingStory)=>{const next=structuredClone(capsule);next.version=4;delete next.checkpointAcknowledgement;delete next.unchangedAcknowledgement;delete next.staleRebase;next.pendingStory=structuredClone(pending);return next}
const promoteStoryCapsule=(capsule:WordSaveCapsule)=>{const next=structuredClone(capsule);next.version=3;delete next.storyAcknowledgement;return next}
const regionBlocks=(model:WordRegionStore)=>model.capture().regions.flatMap(region=>region.blocks)
function checkpointAttribution(current:WordSaveCapsule,pending:WordPendingCheckpoint,draft:WordRegionStore,canonical:WordRegionStore,mutate:()=>void){
 const before=wordDraftObservation(draft),bound=current.observation===before
 const ledger=new ReferenceAuthorLedger(regionBlocks(draft),regionBlocks(canonical));ledger.restore(current.references??[])
 mutate();ledger.commit(pending.capture.regions.flatMap(region=>region.blocks))
 // Only retire captured generations when the original observation was
 // authenticated. Unbound drafts retain all authors for explicit review.
 const actors=bound?current.actors.filter(actor=>!pending.actors.some(saved=>saved.userId===actor.userId&&actor.generation<=saved.generation)):current.actors
 return{actors,references:ledger.proof(),...(bound?{observation:wordDraftObservation(draft)}:{})}
}
const fail=()=>{throw new Error('word-journal-invalid')}
export type WordCheckpointRequest={coordinatorVersion:5|6;coordinatorId:string;checkpointId:string;coordinatorDigest:string;expectedRevision:number;layoutHash:string;typographyVersion:2;extensionVersion?:1;referenceVersion?:1;referenceAuthors?:ReferenceAuthor[];regions:Array<WordRegionCapture['regions'][number]&{images:CapturedImage['change'][]}>;contributors:Array<{userId:string;displayName:string}>}
/** Hash the exact UTF-8 JSON bytes the coordinator transmits. */
export function wordCheckpointRequestHash(request:WordCheckpointRequest){
 return hash(JSON.stringify(request))
}
export type WordSaveBase={revision:number;rootHash:string;layoutHash:string;digest:string}
export type WordPendingCheckpoint={request:WordCheckpointRequest;capture:WordRegionCapture;actors:AuthenticatedContributor[];images?:WordCapturedImage[];initiator?:{userId:string;displayName:string}}
export type WordRecoveryDecision={requestId:string;archiveId:string;reviewHash:string;action:'merge'|'keep-current';userId:string;displayName:string}
export type WordLayoutPending={request:{schemaVersion:'hcd-word-layout-transaction/1';documentId:string;transactionId:string;baseRevision:number;expectedRevision:number;actor:{userId:string;displayName:string};edits:{schemaVersion:'hcd-word-layout-edits/1';baseLayoutHash:string;changes:Array<{sectionId?:string;field:string;expected:string|number|boolean|null;value:string|number|boolean|null}>}};actor:AuthenticatedContributor}
export type WordStoryReceiptRequest={documentId:string;transactionId:string;expectedRevision:number;baseLayoutHash:string;candidateHash:string;actor:{userId:string;displayName:string}}
export type WordPendingStory={request:WordStoryReceiptRequest;actor:AuthenticatedContributor;intent:WordStoryUnlinkIntent;story:WordStory;blocks:Block[];copyChoices?:{referenceIds:string[];extensions:unknown[]}}
export function wordStoryPendingHash(pending:WordPendingStory){return hash(JSON.stringify(pending,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item))}
/** Mirrors the native SHA-256 of (candidate commitment, sorted actor map). */
export function wordStoryRequestHash(request:WordStoryReceiptRequest){return hash(JSON.stringify([request.candidateHash,{displayName:request.actor.displayName,userId:request.actor.userId}]))}
export function matchesWordStoryRecord(input:unknown,request:WordStoryReceiptRequest){
 const record=input as {documentId?:unknown;revision?:unknown;patchBaseRevision?:unknown;patchId?:unknown;patchHash?:unknown;rootHash?:unknown;structuralChange?:unknown;wordLayoutChange?:unknown;authorId?:unknown;authorName?:unknown}
 return !!request&&Object.keys(request).sort().join(',')==='actor,baseLayoutHash,candidateHash,documentId,expectedRevision,transactionId'&&typeof request.documentId==='string'&&hex(request.transactionId,32)&&hex(request.baseLayoutHash)&&hex(request.candidateHash)&&safeInt(request.expectedRevision)&&safeInt(request.expectedRevision+1)&&!!request.actor&&Object.keys(request.actor).sort().join(',')==='displayName,userId'&&validContributor({...request.actor,generation:0})&&!!record&&record.documentId===request.documentId&&record.authorId===request.actor.userId&&record.authorName===request.actor.displayName&&record.revision===request.expectedRevision+1&&record.patchBaseRevision===request.expectedRevision&&record.patchId===`word-story-unlink-${request.transactionId}`&&record.patchHash===wordStoryRequestHash(request)&&hex(record.rootHash)&&record.structuralChange===true&&(record.wordLayoutChange===undefined||record.wordLayoutChange===false)
}
/** Match the native serde representation byte-for-byte for a previously
 * validated pending request. This is not a signature or acceptance proof. */
export function wordLayoutRequestHash(request:WordLayoutPending['request']){
 const value={schemaVersion:request.schemaVersion,documentId:request.documentId,transactionId:request.transactionId,baseRevision:request.baseRevision,expectedRevision:request.expectedRevision,actor:{displayName:request.actor.displayName,userId:request.actor.userId},edits:{schemaVersion:request.edits.schemaVersion,baseLayoutHash:request.edits.baseLayoutHash,changes:request.edits.changes.map(change=>({...(change.sectionId===undefined?{}:{sectionId:change.sectionId}),field:change.field,expected:change.expected,value:change.value}))}}
 return hash(JSON.stringify(value))
}
/** The caller must separately authenticate the native revision and fence room
 * ownership. Do not clear the journal on this check alone. */
export function matchesWordLayoutRecord(input:unknown,request:WordLayoutPending['request']){
 const record=input as {documentId?:unknown;revision?:unknown;patchBaseRevision?:unknown;patchId?:unknown;patchHash?:unknown;rootHash?:unknown;wordLayoutChange?:unknown;authorId?:unknown;authorName?:unknown}
 return !!record&&record.documentId===request.documentId&&record.authorId===request.actor.userId&&record.authorName===request.actor.displayName&&record.revision===request.expectedRevision+1&&record.patchBaseRevision===request.baseRevision&&record.patchId===`word-layout-${request.transactionId}`&&record.patchHash===wordLayoutRequestHash(request)&&hex(record.rootHash)&&record.wordLayoutChange===true
}
export type WordLayoutAcknowledgement={request:WordLayoutPending['request'];record:unknown;receipt:unknown;journalHash:string}
export type WordCheckpointAcknowledgement={request:WordCheckpointRequest;record:unknown;receipt:unknown;journalHash:string}
export type WordUnchangedAcknowledgement={request:WordCheckpointRequest;receipt:unknown;journalHash:string;requestJournalHash?:string}
export type WordStoryAcknowledgement={pending:WordPendingStory;record:unknown;receipt:unknown;journalHash:string;initialUpdate:string}
export type WordStaleRebaseProof={sourceTip:string;checkpointId:string;baseRevision:number;actor:{userId:string;displayName:string}}
export type WordSaveCapsule={version:1|2|3|4|5;apiHash:string;documentId:string;epoch:number;lineage:string;base:WordSaveBase;document:string;actors:AuthenticatedContributor[];observation?:string;references?:ReferenceAuthorEntry[];uploads?:WordUploadRecord[];recoveries?:string[];decisions?:WordRecoveryDecision[];pending?:WordPendingCheckpoint;pendingLayout?:WordLayoutPending;pendingStory?:WordPendingStory;pendingLink?:WordPendingLink;linkAcknowledgement?:WordLinkAcknowledgement;storyAcknowledgement?:WordStoryAcknowledgement;layoutAcknowledgement?:WordLayoutAcknowledgement;checkpointAcknowledgement?:WordCheckpointAcknowledgement;unchangedAcknowledgement?:WordUnchangedAcknowledgement;staleRebase?:WordStaleRebaseProof}
type Scope={apiHash:string;documentId:string;epoch:number;lineage:string}
function actors(value:unknown):asserts value is AuthenticatedContributor[]{
 if(!Array.isArray(value)||value.length>1000||new Set(value.map(person=>person?.userId)).size!==value.length||!value.every(validContributor))fail()
}
export function validateWordSaveCapsule(input:unknown,scope:Scope,allowLayout=false,allowStory=false,allowLink=false):WordSaveCapsule{
 const value=input as WordSaveCapsule
 if(!value||value.version!==1&&!(allowLayout&&(value.version===2||value.version===3))&&!(allowStory&&value.version===4)&&!(allowLayout&&allowStory&&allowLink&&value.version===5)||Object.keys(value).some(key=>!['version','apiHash','documentId','epoch','lineage','base','document','actors','observation','references','uploads','recoveries','decisions','pending','pendingLayout','pendingStory','pendingLink','linkAcknowledgement','storyAcknowledgement','layoutAcknowledgement','checkpointAcknowledgement','unchangedAcknowledgement','staleRebase'].includes(key))||value.version!==2&&(value.pendingLayout!==undefined||value.layoutAcknowledgement!==undefined)||value.version===2&&(!!value.pendingLayout===!!value.layoutAcknowledgement||!!value.pending)||value.version!==3&&(value.checkpointAcknowledgement!==undefined||value.unchangedAcknowledgement!==undefined||value.staleRebase!==undefined)||value.version===5&&(!!value.pendingLink===!!value.linkAcknowledgement||!!value.pending)||value.version!==5&&(value.pendingLink!==undefined||value.linkAcknowledgement!==undefined)||value.version===4&&(!!value.pendingStory===!!value.storyAcknowledgement||!!value.pending)||value.version!==4&&(value.pendingStory!==undefined||value.storyAcknowledgement!==undefined)||(value.checkpointAcknowledgement||value.unchangedAcknowledgement||value.staleRebase)&&value.pending||value.checkpointAcknowledgement&&value.unchangedAcknowledgement||value.staleRebase&&(value.checkpointAcknowledgement||value.unchangedAcknowledgement)||value.apiHash!==scope.apiHash||value.documentId!==scope.documentId||value.epoch!==scope.epoch||value.lineage!==scope.lineage||!safeInt(value.epoch)||!hex(value.lineage,32)||!value.base||!safeInt(value.base.revision)||![value.base.rootHash,value.base.layoutHash,value.base.digest].every(v=>hex(v)))fail()
 if(value.staleRebase){const p=value.staleRebase;if(Object.keys(p).sort().join(',')!=='actor,baseRevision,checkpointId,sourceTip'||!hex(p.sourceTip)||!hex(p.checkpointId,32)||!safeInt(p.baseRevision)||p.baseRevision>=value.base.revision||!p.actor||Object.keys(p.actor).sort().join(',')!=='displayName,userId'||!validContributor({...p.actor,generation:0}))fail()}
 if(value.linkAcknowledgement){
  const proof=value.linkAcknowledgement,record=proof.record as {revision?:unknown;rootHash?:unknown}
  if(Object.keys(proof).sort().join(',')!=='initialUpdate,journalHash,pending,receipt,record'||!hex(proof.journalHash)||record?.revision!==value.base.revision||record?.rootHash!==value.base.rootHash||typeof proof.initialUpdate!=='string'||proof.initialUpdate.length>12*1024*1024)fail()
  const pending=readWordPendingLink(proof.pending,scope.documentId),bytes=Buffer.from(proof.initialUpdate,'base64')
  if(pending.request.expectedRevision+1!==value.base.revision||pending.candidateLayoutHash!==value.base.layoutHash||!bytes.length||bytes.length>8*1024*1024||bytes.toString('base64')!==proof.initialUpdate)fail()
 }
 if(value.storyAcknowledgement){const proof=value.storyAcknowledgement,record=proof.record as {revision?:unknown;rootHash?:unknown};if(Object.keys(proof).sort().join(',')!=='initialUpdate,journalHash,pending,receipt,record'||!hex(proof.journalHash)||!proof.pending||record?.revision!==value.base.revision||record?.rootHash!==value.base.rootHash||typeof proof.initialUpdate!=='string'||proof.initialUpdate.length>12*1024*1024)fail();const bytes=Buffer.from(proof.initialUpdate,'base64');if(!bytes.length||bytes.length>8*1024*1024||bytes.toString('base64')!==proof.initialUpdate)fail()}
 if(value.checkpointAcknowledgement){const proof=value.checkpointAcknowledgement,record=proof.record as {revision?:unknown;rootHash?:unknown};if(Object.keys(proof).sort().join(',')!=='journalHash,receipt,record,request'||!hex(proof.journalHash)||!proof.request||proof.request.coordinatorVersion!==6||record?.revision!==value.base.revision||record?.rootHash!==value.base.rootHash)fail()}
 if(value.unchangedAcknowledgement){const proof=value.unchangedAcknowledgement,receipt=proof.receipt as {revision?:unknown;rootHash?:unknown};if(Object.keys(proof).sort().join(',')!==(proof.requestJournalHash===undefined?'journalHash,receipt,request':'journalHash,receipt,request,requestJournalHash')||!hex(proof.journalHash)||proof.requestJournalHash!==undefined&&(!hex(proof.requestJournalHash)||proof.requestJournalHash===proof.journalHash)||!proof.request||proof.request.coordinatorVersion!==6||receipt?.revision!==value.base.revision||receipt?.rootHash!==value.base.rootHash)fail()}
 if(value.layoutAcknowledgement){const proof=value.layoutAcknowledgement,record=proof.record as {revision?:unknown;rootHash?:unknown};if(Object.keys(proof).sort().join(',')!=='journalHash,receipt,record,request'||!hex(proof.journalHash)||!proof.request||record?.revision!==value.base.revision||record?.rootHash!==value.base.rootHash)fail()}
 if(typeof value.document!=='string'||value.document.length>12*1024*1024)fail()
 const bytes=Buffer.from(value.document,'base64');if(!bytes.length||bytes.length>8*1024*1024||bytes.toString('base64')!==value.document)fail()
 const restored=new Y.Doc();let regionIds:Set<string>,sectionIds:Set<string>,regionKinds:Map<string,string>,regionSources:Set<string>
 try{Y.applyUpdate(restored,bytes);const meta=restored.getMap(wordRegionStoreField),schema=restored.getMap('hcdSchema');if(meta.get('version')!==1||meta.get('documentId')!==scope.documentId||meta.get('layoutHash')!==value.base.layoutHash||schema.get('typography')!==2||schema.get('sourceIdentity')!==1)fail();const regions=meta.get('regions') as Array<{regionId:string;kind:string;sourcePart:string}>;if(!Array.isArray(regions))fail();regionIds=new Set(regions.map(region=>region.regionId));sectionIds=new Set(regions.filter(region=>region.kind==='body').map(region=>region.regionId));regionKinds=new Map(regions.map(region=>[region.regionId,region.kind]));regionSources=new Set(regions.map(region=>region.sourcePart))}finally{restored.destroy()}
 if(value.recoveries!==undefined&&(!Array.isArray(value.recoveries)||value.recoveries.length>256||new Set(value.recoveries).size!==value.recoveries.length||value.recoveries.some(id=>!hex(id,32))))fail()
 if(value.decisions!==undefined){if(!Array.isArray(value.decisions)||value.decisions.length>256||new Set(value.decisions.map(entry=>entry?.requestId)).size!==value.decisions.length)fail();for(const entry of value.decisions){if(!entry||Object.keys(entry).sort().join(',')!=='action,archiveId,displayName,requestId,reviewHash,userId'||!hex(entry.requestId,32)||!hex(entry.archiveId,32)||!hex(entry.reviewHash)||!['merge','keep-current'].includes(entry.action)||!value.recoveries?.includes(entry.archiveId)||!validContributor({...entry,generation:0}))fail()}}
 actors(value.actors)
 if(value.pendingLink){const pending=readWordPendingLink(value.pendingLink,scope.documentId),request=pending.request;if(request.expectedRevision!==value.base.revision||request.link.baseLayoutHash!==value.base.layoutHash||!sectionIds.has(request.link.sectionId)||regionKinds.get(request.link.expectedDirectStoryId)!==request.link.kind)fail()}
 if(value.pendingStory){
  const pending=value.pendingStory,request=pending.request,intent=pending.intent,story=pending.story
  if(!['actor,blocks,intent,request,story','actor,blocks,copyChoices,intent,request,story'].includes(Object.keys(pending).sort().join(','))||!validContributor(pending.actor)||!request||Object.keys(request).sort().join(',')!=='actor,baseLayoutHash,candidateHash,documentId,expectedRevision,transactionId'||!request.actor||Object.keys(request.actor).sort().join(',')!=='displayName,userId'||request.documentId!==scope.documentId||request.expectedRevision!==value.base.revision||request.baseLayoutHash!==value.base.layoutHash||!hex(request.candidateHash)||!hex(request.transactionId,32)||request.actor.userId!==pending.actor.userId||request.actor.displayName!==pending.actor.displayName||!intent||Object.keys(intent).sort().join(',')!=='expectedInheritedStoryId,kind,sectionId,variant'||!sectionIds.has(intent.sectionId)||!['header','footer'].includes(intent.kind)||!['default','first','even'].includes(intent.variant)||!(intent.expectedInheritedStoryId===null||typeof intent.expectedInheritedStoryId==='string'&&regionKinds.get(intent.expectedInheritedStoryId)===intent.kind)||!story||Object.keys(story).sort().join(',')!=='id,kind,sourcePart'||!/^n_[a-f0-9]{32}$/.test(story.id)||regionIds.has(story.id)||story.kind!==intent.kind||!/^word\/[A-Za-z0-9_-]{1,200}\.xml$/.test(story.sourcePart)||regionSources.has(story.sourcePart)||!Array.isArray(pending.blocks)||!pending.blocks.length||pending.blocks.length>10000||Buffer.byteLength(JSON.stringify(pending))>1024*1024||new Set(pending.blocks.map(block=>block?.blockId)).size!==pending.blocks.length||pending.blocks.some(block=>!block||block.flowRegionId!==story.id||block.region!==story.kind||!/^n_[a-f0-9]{32}$/.test(block.blockId)||!hex(block.blockHash)||block.readOnly!==false||!block.content))fail()
  if(pending.copyChoices!==undefined){const choices=pending.copyChoices;if(!choices||Object.keys(choices).sort().join(',')!=='extensions,referenceIds'||!Array.isArray(choices.referenceIds)||choices.referenceIds.length>10000||choices.referenceIds.some(id=>typeof id!=='string'||id.length<1||id.length>256)||!Array.isArray(choices.extensions)||choices.extensions.length>10000||choices.extensions.some(node=>!node||typeof node!=='object'||Array.isArray(node)))fail()}
  try{wordRegionSchema().nodeFromJSON(projectionToJson({documentId:scope.documentId,revision:value.base.revision,blocks:pending.blocks})).check()}catch{fail()}
 }
 if(value.pendingLayout){
  const pending=value.pendingLayout,request=pending.request,edit=request?.edits
  if(!pending||Object.keys(pending).sort().join(',')!=='actor,request'||!validContributor(pending.actor)||!request||Object.keys(request).sort().join(',')!=='actor,baseRevision,documentId,edits,expectedRevision,schemaVersion,transactionId'||request.schemaVersion!=='hcd-word-layout-transaction/1'||request.documentId!==scope.documentId||!hex(request.transactionId,32)||request.baseRevision!==value.base.revision||request.expectedRevision!==value.base.revision||!request.actor||Object.keys(request.actor).sort().join(',')!=='displayName,userId'||request.actor.userId!==pending.actor.userId||request.actor.displayName!==pending.actor.displayName||!edit||Object.keys(edit).sort().join(',')!=='baseLayoutHash,changes,schemaVersion'||edit.schemaVersion!=='hcd-word-layout-edits/1'||edit.baseLayoutHash!==value.base.layoutHash||!Array.isArray(edit.changes)||!edit.changes.length||edit.changes.length>1024||Buffer.byteLength(JSON.stringify(request))>256*1024)fail()
  const fields=new Set(['widthTwips','heightTwips','orientation','marginTop','marginRight','marginBottom','marginLeft','marginHeader','marginFooter','marginGutter','numberStart','numberFormat','differentFirstPage','evenAndOddHeaders']),seen=new Set<string>()
  for(const change of edit.changes){
   if(!change||Object.keys(change).some(key=>!['sectionId','field','expected','value'].includes(key))||!fields.has(change.field)||!Object.hasOwn(change,'expected')||!Object.hasOwn(change,'value')||change.expected===change.value)fail()
   const global=change.field==='evenAndOddHeaders',key=`${change.sectionId??''}:${change.field}`
   if(global?change.sectionId!==undefined:typeof change.sectionId!=='string'||!sectionIds.has(change.sectionId))fail()
   if(seen.has(key))fail();seen.add(key)
   const valid=(item:unknown)=>{
    if(['differentFirstPage','evenAndOddHeaders'].includes(change.field))return typeof item==='boolean'
    if(item===null)return true
    if(change.field==='orientation')return item==='portrait'||item==='landscape'
    if(change.field==='numberFormat')return typeof item==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(item)
    if(!Number.isSafeInteger(item))return false
    const n=Number(item)
    if(change.field==='numberStart')return n>=0&&n<=2147483647
    if(['widthTwips','heightTwips'].includes(change.field))return n>=1&&n<=200000
    return n>= (['marginTop','marginBottom'].includes(change.field)?-200000:0)&&n<=200000
   }
   if(!valid(change.expected)||!valid(change.value))fail()
  }
 }
 validateWordUploads(value.uploads??[])
 if(value.uploads?.some(upload=>upload.revision>value.base.revision||!regionIds.has(upload.regionId)))fail()
 if(value.observation!==undefined&&!hex(value.observation))fail()
 if(value.references!==undefined){if(!Array.isArray(value.references)||value.references.length>10000)fail();for(const entry of value.references){if(!validContributor(entry)||typeof entry.present!=='boolean')fail();readInlineReference({type:'hcd.mention',version:1,mentionId:entry.mentionId,target:entry.target,snapshot:{label:'validation'}})}}
 if(value.pending){
  const pending=value.pending,request=pending.request,capture=pending.capture
  if(pending.initiator!==undefined&&(value.version!==3||Object.keys(pending.initiator).sort().join(',')!=='displayName,userId'||!validContributor({...pending.initiator,generation:0})))fail()
  actors(pending.actors);if(!pending.actors.length)fail()
  if(!request||!capture||request.coordinatorVersion!==(value.version===3?6:5)||request.coordinatorId!==scope.lineage||!hex(request.checkpointId,32)||request.expectedRevision!==value.base.revision||request.layoutHash!==value.base.layoutHash||capture.layoutHash!==value.base.layoutHash||request.typographyVersion!==2||request.extensionVersion!==undefined&&request.extensionVersion!==1||request.referenceVersion!==undefined&&request.referenceVersion!==1||!Array.isArray(capture.regions)||!capture.regions.length||capture.regions.length>12288||!Array.isArray(request.regions)||request.regions.length!==capture.regions.length||new Set(capture.regions.map(region=>region?.regionId)).size!==capture.regions.length||!Array.isArray(capture.sources))fail()
  let count=0
  for(const [index,region]of capture.regions.entries()){
   const sent=request.regions[index]
   if(!region||!/^n_[a-f0-9]{32}$/.test(region.regionId)||!Array.isArray(region.blocks)||!region.blocks.length||(count+=region.blocks.length)>1_000_000||!sent||sent.regionId!==region.regionId||!Array.isArray(sent.images)||JSON.stringify(sent.blocks)!==JSON.stringify(region.blocks))fail()
  }
  const images=pending.images??[];validateCapturedImages(images)
  if(images.some(image=>!capture.regions.some(region=>region.regionId===image.regionId)))fail()
  for(const region of request.regions)if(JSON.stringify(region.images)!==JSON.stringify(images.filter(image=>image.regionId===region.regionId).map(image=>image.change)))fail()
  if(capture.sources.length!==count||request.coordinatorDigest!==hash(wordCheckpointContents(capture)))fail()
  for(const target of capture.sources){
   if(target instanceof Y.XmlElement)return fail()
   if(!target||target.kind!=='structure-root'||typeof target.key!=='string'||!target.key||target.key.length>128||typeof target.owner!=='string'||!target.owner||target.owner.length>128||target.blockId!==null&&(typeof target.blockId!=='string'||target.blockId.length>256)||!Array.isArray(target.texts)||target.texts.some(key=>typeof key!=='string'||!key||key.length>128)||!Array.isArray(target.sourceIds)||target.sourceIds.some(id=>!/^n_[a-f0-9]{32}$/.test(id))||target.bindings?.length!==target.texts.length)fail()
   target.bindings!.forEach(binding=>validateSourceLeaf(binding))
  }
  if(!Array.isArray(request.contributors)||request.contributors.length!==pending.actors.length||request.contributors.some((person,index)=>person.userId!==pending.actors[index].userId||person.displayName!==pending.actors[index].displayName))fail()
  const current=new Map(value.actors.map(actor=>[actor.userId,actor]))
  if(pending.actors.some(actor=>(current.get(actor.userId)?.generation??-1)<actor.generation))fail()
 }
 return value
}
export function wordSaveCapsule(scope:Scope,model:WordRegionStore,base:WordSaveBase,people:AuthenticatedContributor[],pending?:WordPendingCheckpoint,metadata?:{observation:string;references:ReferenceAuthorEntry[];uploads?:WordUploadRecord[];recoveries?:string[];decisions?:WordRecoveryDecision[]},version:1|3=1):WordSaveCapsule{
 if(model.documentId!==scope.documentId||model.capture().layoutHash!==base.layoutHash)fail()
 return validateWordSaveCapsule(structuredClone({version,...scope,base,actors:people,...(metadata??{}),document:Buffer.from(Y.encodeStateAsUpdate(model.document)).toString('base64'),...(pending?{pending}:{})}),scope,version===3)
}
/** Immutable compressed chain: linking `previous.next` is an atomic CAS. A
 * crash never publishes a partial state, nor replaces another owner's file.
 * This is a private recovery log, NOT a cluster lease. History GC is deferred. */
export class WordCheckpointJournal{
 readonly scope:Scope
 readonly directory:string
 private tip:string|undefined
 private lastCapsule:WordSaveCapsule|undefined
 private snapshots=new Set<string>()
 private hashes=['none']
 private stateGeneration=0
 private writing=false
 constructor(root:string,apiUrl:string,documentId:string,epoch:number,lineage:string,private secret:string,private allowLayout=false,private allowStory=false,private allowLink=false){
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(documentId)||!safeInt(epoch)||!hex(lineage,32)||Buffer.byteLength(secret)<32)throw new Error('word-journal-scope')
  this.scope={apiHash:hash(apiUrl),documentId,epoch,lineage};this.directory=join(resolve(root),this.scope.apiHash,'word-checkpoints',documentId,String(epoch),lineage)
 }
 verifyCheckpointRecord(input:unknown,request:WordCheckpointRequest){
  const record=input as {revision:number;patchBaseRevision:number;patchId?:string;rootHash:string},parts=record?.patchId?.split(':')
  if(!record||record.revision!==request.expectedRevision+1||record.patchBaseRevision!==request.expectedRevision||!hex(record.rootHash)||!parts)return false
  return this.verifyCheckpointSignature(parts,request)
 }
 private verifyCheckpointSignature(parts:string[],request:WordCheckpointRequest){
  if(![5,6].includes(request.coordinatorVersion)||parts.length!==6||parts[0]!==`hcdsave${request.coordinatorVersion}`||parts[1]!==this.scope.lineage||parts[1]!==request.coordinatorId||parts[2]!==request.checkpointId||parts[3]!==request.coordinatorDigest||!hex(parts[4]))return false
  const expected=createHmac('sha256',this.secret).update(`${this.scope.documentId}:${this.scope.epoch}:${request.expectedRevision}:${parts.slice(0,5).join(':')}`).digest('base64url')
  return parts[5].length===expected.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(parts[5]))
 }
 verifyUnchangedReceipt(input:unknown,request:WordCheckpointRequest,journalHash:string,rootHash:string){
  const receipt=input as {schemaVersion?:unknown;documentId?:unknown;epoch?:unknown;journalHash?:unknown;requestHash?:unknown;revision?:unknown;rootHash?:unknown;patchId?:unknown;signature?:unknown}
  if(!receipt||receipt.schemaVersion!=='hcd-word-checkpoint-unchanged/2'||receipt.documentId!==this.scope.documentId||receipt.epoch!==this.scope.epoch||receipt.journalHash!==journalHash||receipt.requestHash!==wordCheckpointRequestHash(request)||receipt.revision!==request.expectedRevision||receipt.rootHash!==rootHash||!hex(journalHash)||!hex(rootHash)||typeof receipt.patchId!=='string'||typeof receipt.signature!=='string'||request.coordinatorVersion!==6||!this.verifyCheckpointSignature(receipt.patchId.split(':'),request))return false
  const message=`hcd-word-checkpoint-unchanged/2:${this.scope.documentId}:${this.scope.epoch}:${journalHash}:${receipt.requestHash}:${request.expectedRevision}:${rootHash}:${receipt.patchId}`,expected=createHmac('sha256',this.secret).update(message).digest('base64url')
  return receipt.signature.length===expected.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(receipt.signature))
 }
 verifyCheckpointReceipt(input:unknown,record:unknown,request:WordCheckpointRequest,journalHash:string){
  const receipt=input as {schemaVersion?:unknown;documentId?:unknown;epoch?:unknown;journalHash?:unknown;requestHash?:unknown;revision?:unknown;rootHash?:unknown;patchId?:unknown;signature?:unknown},revision=record as {revision?:unknown;rootHash?:unknown;patchId?:unknown}
  if(!this.verifyCheckpointRecord(record,request)||!receipt||receipt.schemaVersion!=='hcd-word-checkpoint-receipt/1'||receipt.documentId!==this.scope.documentId||receipt.epoch!==this.scope.epoch||receipt.journalHash!==journalHash||!hex(journalHash)||receipt.requestHash!==wordCheckpointRequestHash(request)||receipt.revision!==revision.revision||receipt.rootHash!==revision.rootHash||receipt.patchId!==revision.patchId||typeof receipt.signature!=='string')return false
  const message=`hcd-word-checkpoint-receipt/1:${this.scope.documentId}:${this.scope.epoch}:${journalHash}:${receipt.requestHash}:${receipt.revision}:${receipt.rootHash}:${receipt.patchId}`,expected=createHmac('sha256',this.secret).update(message).digest('base64url')
  return receipt.signature.length===expected.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(receipt.signature))
 }
 /** A valid signature still requires ownership, current authorization and
  * canonical layout verification before applying or clearing the request. */
 verifyLayoutReceipt(record:unknown,request:WordLayoutPending['request'],input:unknown,journalHash:string){
  const receipt=input as {schemaVersion?:unknown;documentId?:unknown;epoch?:unknown;coordinatorId?:unknown;journalHash?:unknown;expectedRevision?:unknown;revision?:unknown;transactionId?:unknown;requestHash?:unknown;rootHash?:unknown;signature?:unknown}
  const revision=record as {revision:number;rootHash:string}
  if(!matchesWordLayoutRecord(record,request)||!receipt||!hex(journalHash)||receipt.schemaVersion!=='hcd-layout-receipt/1'||receipt.documentId!==this.scope.documentId||receipt.epoch!==this.scope.epoch||receipt.coordinatorId!==this.scope.lineage||receipt.journalHash!==journalHash||receipt.expectedRevision!==request.expectedRevision||receipt.revision!==revision.revision||receipt.transactionId!==request.transactionId||receipt.requestHash!==wordLayoutRequestHash(request)||receipt.rootHash!==revision.rootHash||typeof receipt.signature!=='string')return false
  const message=`hcd-layout-receipt/1:${this.scope.documentId}:${this.scope.epoch}:${this.scope.lineage}:${journalHash}:${request.expectedRevision}:${revision.revision}:${request.transactionId}:${receipt.requestHash}:${revision.rootHash}`
  const expected=createHmac('sha256',this.secret).update(message).digest('base64url')
  return receipt.signature.length===expected.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(receipt.signature))
 }
 /** The HMAC proves the native record and initial Yjs state were bound to the
  * journal tip by the coordinator. It does not grant access or a room lease. */
 verifyStoryReceipt(record:unknown,pending:WordPendingStory,input:unknown,journalHash:string,initialUpdate:Uint8Array){
  const request=pending?.request,receipt=input as {schemaVersion?:unknown;documentId?:unknown;epoch?:unknown;coordinatorId?:unknown;journalHash?:unknown;expectedRevision?:unknown;revision?:unknown;transactionId?:unknown;requestHash?:unknown;pendingHash?:unknown;rootHash?:unknown;layoutHash?:unknown;initialUpdateHash?:unknown;signature?:unknown},revision=record as {revision:number;rootHash:string}
  if(!request||!matchesWordStoryRecord(record,request)||request.documentId!==this.scope.documentId||!receipt||Object.keys(receipt).sort().join(',')!=='coordinatorId,documentId,epoch,expectedRevision,initialUpdateHash,journalHash,layoutHash,pendingHash,requestHash,revision,rootHash,schemaVersion,signature,transactionId'||!hex(journalHash)||!(initialUpdate instanceof Uint8Array)||!initialUpdate.length||initialUpdate.length>8*1024*1024||receipt.schemaVersion!=='hcd-word-story-receipt/1'||receipt.documentId!==this.scope.documentId||receipt.epoch!==this.scope.epoch||receipt.coordinatorId!==this.scope.lineage||receipt.journalHash!==journalHash||receipt.expectedRevision!==request.expectedRevision||receipt.revision!==revision.revision||receipt.transactionId!==request.transactionId||receipt.requestHash!==wordStoryRequestHash(request)||receipt.pendingHash!==wordStoryPendingHash(pending)||receipt.rootHash!==revision.rootHash||!hex(receipt.layoutHash)||receipt.initialUpdateHash!==hash(initialUpdate)||typeof receipt.signature!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(receipt.signature))return false
  const message=JSON.stringify(['hcd-word-story-receipt/1',this.scope.apiHash,this.scope.documentId,this.scope.epoch,this.scope.lineage,journalHash,request.expectedRevision,revision.revision,request.transactionId,receipt.requestHash,receipt.pendingHash,revision.rootHash,request.baseLayoutHash,receipt.layoutHash,receipt.initialUpdateHash])
  const expected=createHmac('sha256',this.secret).update(message).digest('base64url')
  return receipt.signature.length===expected.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(receipt.signature))
 }
 verifyLinkReceipt(record:unknown,pending:WordPendingLink,input:unknown,journalHash:string,initialUpdate:Uint8Array){return verifyLinkSignature(this.scope,this.secret,record,pending,input,journalHash,initialUpdate)}
 private verifyCapsuleProof(capsule:WordSaveCapsule){
  const link=capsule.linkAcknowledgement
  if(link&&(!this.verifyLinkReceipt(link.record,link.pending,link.receipt,link.journalHash,Buffer.from(link.initialUpdate,'base64'))||(link.receipt as {layoutHash?:unknown}).layoutHash!==capsule.base.layoutHash))fail()
  if(link){const baseline=new Y.Doc(),current=new Y.Doc();try{Y.applyUpdate(baseline,Buffer.from(link.initialUpdate,'base64'));Y.applyUpdate(current,Buffer.from(capsule.document,'base64'));if(!wordContainsBaseline(current,baseline)||JSON.stringify(baseline.getMap(wordRegionStoreField).get('regions'))!==JSON.stringify(current.getMap(wordRegionStoreField).get('regions')))fail()}finally{baseline.destroy();current.destroy()}}

  const story=capsule.storyAcknowledgement
  if(story&&(!this.verifyStoryReceipt(story.record,story.pending,story.receipt,story.journalHash,Buffer.from(story.initialUpdate,'base64'))||(story.receipt as {layoutHash?:unknown}).layoutHash!==capsule.base.layoutHash))fail()
  if(story){const baseline=new Y.Doc(),current=new Y.Doc();try{Y.applyUpdate(baseline,Buffer.from(story.initialUpdate,'base64'));Y.applyUpdate(current,Buffer.from(capsule.document,'base64'));if(!wordContainsBaseline(current,baseline)||JSON.stringify(baseline.getMap(wordRegionStoreField).get('regions'))!==JSON.stringify(current.getMap(wordRegionStoreField).get('regions')))fail()}finally{baseline.destroy();current.destroy()}}
  const proof=capsule.layoutAcknowledgement
  if(proof&&!this.verifyLayoutReceipt(proof.record,proof.request,proof.receipt,proof.journalHash))fail()
  const checkpoint=capsule.checkpointAcknowledgement
  if(checkpoint&&!this.verifyCheckpointReceipt(checkpoint.receipt,checkpoint.record,checkpoint.request,checkpoint.journalHash))fail()
  const unchanged=capsule.unchangedAcknowledgement
  if(unchanged&&!this.verifyUnchangedReceipt(unchanged.receipt,unchanged.request,unchanged.requestJournalHash??unchanged.journalHash,capsule.base.rootHash))fail()
  return capsule
 }
 private path(previous:string){if(previous!=='none'&&!hex(previous))fail();return join(this.directory,`${previous}.next`)}
 private async safeDirectory(create=false){
  if(create)await fs.mkdir(this.directory,{recursive:true,mode:0o700})
  for(let path=this.directory,count=0;count<5;count++,path=resolve(path,'..')){const stat=await fs.lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())fail()}
 }
 private async sync(){if(process.platform!=='win32'){const fd=await fs.open(this.directory,'r');try{await fd.sync()}finally{await fd.close()}}}
 private sign(previous:string,payload:string){return createHmac('sha256',this.secret).update(previous+'\0'+payload).digest('hex')}
 private async read(previous:string):Promise<{capsule:WordSaveCapsule;hash:string}|undefined>{
  let fd:fs.FileHandle
  try{const path=this.path(previous),stat=await fs.lstat(path);if(!stat.isFile()||stat.isSymbolicLink())fail();fd=await fs.open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
  try{
   const stat=await fd.stat();if(!stat.isFile()||stat.size>16*1024*1024)fail()
   const bytes=await fd.readFile(),decoded=await decompress(bytes,{maxOutputLength:limit*2}),record=JSON.parse(decoded.toString('utf8'))
   if(!record||Object.keys(record).sort().join(',')!=='payload,previous,signature,version'||record.version!==1||record.previous!==previous||typeof record.payload!=='string'||Buffer.byteLength(record.payload)>limit||!hex(record.signature))fail()
   const expected=this.sign(previous,record.payload);if(!timingSafeEqual(Buffer.from(expected),Buffer.from(record.signature)))fail()
   const capsule=this.verifyCapsuleProof(validateWordSaveCapsule(JSON.parse(record.payload),this.scope,this.allowLayout,this.allowStory,this.allowLink));return{capsule,hash:hash(bytes)}
  }finally{await fd.close()}
 }
 knownHashes(){return[...this.hashes]}
 /** Call after loading the signed chain under the stopped-room gate. */
 async checkpointUsed(checkpointId:string,guard:()=>void){
  if(!hex(checkpointId,32))throw new Error('word-checkpoint-id-invalid')
  const generation=this.stateGeneration
  for(let i=1;i<this.hashes.length;i++){
   const entry=await this.read(this.hashes[i-1]);guard();if(!entry||entry.hash!==this.hashes[i]||this.stateGeneration!==generation||this.writing)throw new Error('word-journal-changed')
   const c=entry.capsule;if([c.pending?.request.checkpointId,c.checkpointAcknowledgement?.request.checkpointId,c.unchangedAcknowledgement?.request.checkpointId].includes(checkpointId))return true
  }
  guard();return false
 }
 /** The caller holds the stopped-room gate and native owner lease. A sealed
  * checkpoint cannot subsequently be prepared by a compatible coordinator. */
 async checkpointAbandoned(checkpointId:string){
  if(!hex(checkpointId,32))throw new Error('word-checkpoint-id-invalid')
  try{await this.safeDirectory()}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
  let file:fs.FileHandle
  try{file=await fs.open(join(this.directory,`cancelled-checkpoint-${checkpointId}.json`),constants.O_RDONLY|(constants.O_NOFOLLOW??0))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
  try{const stat=await file.stat();if(!stat.isFile()||stat.size>4096)fail();const value=JSON.parse(await file.readFile('utf8')),payload=JSON.stringify({version:1,...this.scope,checkpointId});if(!value||Object.keys(value).sort().join(',')!=='payload,signature'||value.payload!==payload||!hex(value.signature)||!timingSafeEqual(Buffer.from(value.signature),Buffer.from(this.sign('cancel-checkpoint',payload))))fail();return true}finally{await file.close()}
 }
 async abandonUnpreparedCheckpoint(checkpointId:string,guard:()=>void){
  if(!this.allowLayout||!hex(checkpointId,32)||typeof guard!=='function')throw new Error('word-checkpoint-id-invalid')
  guard();const saved=await this.load(),generation=this.stateGeneration;guard()
  if(saved&&(saved.capsule.version!==3||saved.capsule.pending||saved.capsule.pendingLayout||saved.capsule.pendingStory))throw new Error('word-checkpoint-pending-unresolved')
  const handled=new Set(saved?.capsule.recoveries??[])
  for(const archive of await this.recoverySnapshots())if(!handled.has(archive.id)&&!this.snapshotRecorded(archive.capsule))throw new Error('word-owner-recovery-required')
  for(let i=1;i<this.hashes.length;i++){
   const entry=await this.read(this.hashes[i-1]);guard();if(!entry||entry.hash!==this.hashes[i]||this.stateGeneration!==generation||this.writing)throw new Error('word-journal-changed')
   const c=entry.capsule,ids=[c.pending?.request.checkpointId,c.checkpointAcknowledgement?.request.checkpointId,c.unchangedAcknowledgement?.request.checkpointId]
   if(ids.includes(checkpointId))throw new Error('word-checkpoint-already-prepared')
  }
  guard();if(await this.checkpointAbandoned(checkpointId)){guard();return}
  await this.safeDirectory(true);const names=await fs.readdir(this.directory);if(names.filter(name=>/^cancelled-checkpoint-[a-f0-9]{32}\.json$/.test(name)).length>=4096)throw new Error('word-checkpoint-cancellation-limit')
  const payload=JSON.stringify({version:1,...this.scope,checkpointId}),bytes=JSON.stringify({payload,signature:this.sign('cancel-checkpoint',payload)}),temporary=join(this.directory,`${randomUUID()}.tmp`),destination=join(this.directory,`cancelled-checkpoint-${checkpointId}.json`)
  try{const file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(bytes);await file.sync()}finally{await file.close()};guard();if(this.stateGeneration!==generation||this.writing)throw new Error('word-journal-changed');try{await fs.link(temporary,destination)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error};await this.sync();guard();if(this.stateGeneration!==generation||this.writing||!await this.checkpointAbandoned(checkpointId))throw new Error('word-journal-changed')}finally{await fs.rm(temporary,{force:true}).catch(()=>{})}
 }
 /** Durable cancellation is scoped and signed. A late request must check it
  * before preparing a layout or story transaction under the same owner gate. */
 async topologyAbandoned(transactionId:string){
  if(!hex(transactionId,32))throw new Error('word-topology-recovery-invalid')
  try{await this.safeDirectory()}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
  let file:fs.FileHandle
  try{file=await fs.open(join(this.directory,`cancelled-${transactionId}.json`),constants.O_RDONLY|(constants.O_NOFOLLOW??0))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
  try{
   const stat=await file.stat();if(!stat.isFile()||stat.size>4096)fail()
   const value=JSON.parse(await file.readFile('utf8')),payload=JSON.stringify({version:1,...this.scope,transactionId})
   if(!value||Object.keys(value).sort().join(',')!=='payload,signature'||value.payload!==payload||!hex(value.signature)||!timingSafeEqual(Buffer.from(value.signature),Buffer.from(this.sign('cancel-topology',payload))))fail()
   return true
  }finally{await file.close()}
 }
 /** Prove this exact identity has never entered the signed chain, then seal it.
  * Caller holds the stopped-room gate, a native owner lease and authorization. */
 async abandonUnpreparedTopology(transactionId:string,guard:()=>void){
  if(!this.allowLayout||!this.allowStory||!hex(transactionId,32)||typeof guard!=='function')throw new Error('word-topology-recovery-invalid')
  guard();const saved=await this.load(),generation=this.stateGeneration;guard()
  if(saved&&(saved.capsule.version!==3||saved.capsule.pending))throw new Error('word-topology-pending-unresolved')
  const handled=new Set(saved?.capsule.recoveries??[])
  for(const archive of await this.recoverySnapshots())if(!handled.has(archive.id)&&!this.snapshotRecorded(archive.capsule))throw new Error('word-owner-recovery-required')
  for(let i=1;i<this.hashes.length;i++){
   const entry=await this.read(this.hashes[i-1]);guard();if(!entry||entry.hash!==this.hashes[i]||this.stateGeneration!==generation||this.writing)throw new Error('word-journal-changed')
   const c=entry.capsule,ids=[c.pendingLayout?.request.transactionId,c.layoutAcknowledgement?.request.transactionId,c.pendingStory?.request.transactionId,c.storyAcknowledgement?.pending.request.transactionId,c.pendingLink?.request.transactionId,c.linkAcknowledgement?.pending.request.transactionId]
   if(ids.includes(transactionId))throw new Error('word-topology-already-prepared')
  }
  guard();if(await this.topologyAbandoned(transactionId)){guard();return}
  await this.safeDirectory(true);const names=await fs.readdir(this.directory);if(names.filter(name=>/^cancelled-[a-f0-9]{32}\.json$/.test(name)).length>=4096)throw new Error('word-topology-cancellation-limit')
  const payload=JSON.stringify({version:1,...this.scope,transactionId}),bytes=JSON.stringify({payload,signature:this.sign('cancel-topology',payload)}),temporary=join(this.directory,`${randomUUID()}.tmp`),destination=join(this.directory,`cancelled-${transactionId}.json`)
  try{const file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(bytes);await file.sync()}finally{await file.close()}
   guard();if(this.stateGeneration!==generation||this.writing)throw new Error('word-journal-changed')
   try{await fs.link(temporary,destination)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
   await this.sync();guard();if(this.stateGeneration!==generation||this.writing||!await this.topologyAbandoned(transactionId))throw new Error('word-journal-changed')
  }finally{await fs.rm(temporary,{force:true}).catch(()=>{})}
 }
 /** Recover the exact topology actor from the current signed transition or
  * its immediately promoted predecessor. Later edits/checkpoints invalidate
  * this lookup; they must not be mistaken for the reviewed transition. */
 async linkRecoveryIdentity(transactionId:string){
  if(!hex(transactionId,32))throw Error('word-link-pending-invalid')
  const saved=await this.load(),generation=this.stateGeneration;if(!saved)throw Error('word-link-pending-unresolved')
  let capsule=saved.capsule,promoted=false
  if(capsule.version===3&&!capsule.pending&&!capsule.checkpointAcknowledgement&&!capsule.unchangedAcknowledgement){
   const index=this.hashes.length-2;if(index>=1){const prior=await this.read(this.hashes[index-1]);if(this.writing||generation!==this.stateGeneration||prior?.hash!==this.hashes[index])throw Error('word-journal-changed');if(prior.capsule.version===5&&prior.capsule.linkAcknowledgement&&JSON.stringify(promoteLinkCapsule(prior.capsule))===JSON.stringify(capsule)){capsule=prior.capsule;promoted=true}}
  }
  const pending=capsule.pendingLink??capsule.linkAcknowledgement?.pending
  if(capsule.version!==5||!pending||pending.request.transactionId!==transactionId)throw Error('word-link-pending-unresolved')
  return{pending:structuredClone(pending),promoted,acknowledged:!!capsule.linkAcknowledgement,revision:saved.capsule.base.revision}
 }
 private async topologyPrepared(transactionId:string,guard:()=>void){
  const generation=this.stateGeneration
  for(let index=1;index<this.hashes.length;index++){
   const entry=await this.read(this.hashes[index-1]);guard();if(this.writing||generation!==this.stateGeneration||entry?.hash!==this.hashes[index])throw Error('word-journal-changed')
   const c=entry.capsule,ids=[c.pendingLayout?.request.transactionId,c.layoutAcknowledgement?.request.transactionId,c.pendingStory?.request.transactionId,c.storyAcknowledgement?.pending.request.transactionId,c.pendingLink?.request.transactionId,c.linkAcknowledgement?.pending.request.transactionId]
   if(ids.includes(transactionId))return true
  }
  return false
 }
 async topologyRecoveryIdentity(transactionId?:string){
  if(transactionId!==undefined&&!hex(transactionId,32))throw new Error('word-topology-recovery-invalid')
  const saved=await this.load(),generation=this.stateGeneration;if(!saved)throw new Error('word-topology-pending-unresolved')
  let capsule=saved.capsule,promoted=false
  if(capsule.version===3&&!capsule.pending&&!capsule.checkpointAcknowledgement&&!capsule.unchangedAcknowledgement){
   const index=this.hashes.length-2;if(index<1)throw new Error('word-topology-pending-unresolved')
   const previous=await this.read(this.hashes[index-1]);if(this.writing||generation!==this.stateGeneration||previous?.hash!==this.hashes[index])throw new Error('word-journal-changed')
   const prior=previous.capsule
   if(prior.version===2&&prior.layoutAcknowledgement&&JSON.stringify(promoteLayout(prior))===JSON.stringify(capsule)||prior.version===4&&prior.storyAcknowledgement&&JSON.stringify(promoteStoryCapsule(prior))===JSON.stringify(capsule)||prior.version===5&&prior.linkAcknowledgement&&JSON.stringify(promoteLinkCapsule(prior))===JSON.stringify(capsule)){capsule=prior;promoted=true}
  }
  const kind=capsule.version===2?'layout':capsule.version===4?'story':capsule.version===5?'link':undefined
  const layout=capsule.pendingLayout?.request??capsule.layoutAcknowledgement?.request,story=capsule.pendingStory??capsule.storyAcknowledgement?.pending,link=capsule.pendingLink??capsule.linkAcknowledgement?.pending
  const request=kind==='layout'?layout:kind==='story'?story?.request:kind==='link'?link?.request:undefined
  if(!kind||!request||transactionId!==undefined&&request.transactionId!==transactionId)throw new Error('word-topology-pending-unresolved')
  const details=kind==='layout'&&layout?{kind:'layout' as const,layoutHash:layout.edits.baseLayoutHash,changes:structuredClone(layout.edits.changes)}:kind==='story'&&story?{kind:'story' as const,layoutHash:story.request.baseLayoutHash,intent:structuredClone(story.intent),blockCount:story.blocks.length}:kind==='link'&&link?{kind:'link' as const,layoutHash:link.request.link.baseLayoutHash,link:structuredClone(link.request.link)}:undefined
  if(!details)throw new Error('word-topology-pending-unresolved')
  return{kind,transactionId:request.transactionId,initiator:structuredClone(request.actor),baseRevision:request.expectedRevision,revision:saved.capsule.base.revision,status:promoted?'promoted' as const:kind==='layout'?capsule.layoutAcknowledgement?'confirmed' as const:'pending' as const:(kind==='story'?capsule.storyAcknowledgement:capsule.linkAcknowledgement)?'confirmed' as const:'pending' as const,details}
 }
 /** Read the initiator from the signed parent of an acknowledged checkpoint.
  * This makes an HTTP response lost after acknowledgement safely retryable. */
 async checkpointRecoveryIdentity(checkpointId:string){
  if(!hex(checkpointId,32))throw new Error('word-checkpoint-recovery-invalid')
  const saved=await this.load(),generation=this.stateGeneration,capsule=saved?.capsule
  if(!capsule||capsule.version!==3)throw new Error('word-checkpoint-pending-unresolved')
  if(capsule.staleRebase){const proof=capsule.staleRebase;if(proof.checkpointId!==checkpointId)throw new Error('word-checkpoint-pending-unresolved');return{initiator:structuredClone(proof.actor),baseRevision:proof.baseRevision,acknowledged:true,revision:capsule.base.revision,rebased:true as const}}
  let pending=capsule.pending,acknowledged=false
  if(!pending){
   const proof=capsule.checkpointAcknowledgement??capsule.unchangedAcknowledgement
   if(!proof||proof.request.checkpointId!==checkpointId)throw new Error('word-checkpoint-pending-unresolved')
   const index=this.hashes.indexOf(proof.journalHash);if(index<1)throw new Error('word-checkpoint-receipt-invalid')
   const parent=await this.read(this.hashes[index-1]);if(this.writing||this.stateGeneration!==generation||parent?.hash!==proof.journalHash||JSON.stringify(parent.capsule.pending?.request)!==JSON.stringify(proof.request))throw new Error('word-journal-changed')
   pending=parent.capsule.pending;acknowledged=true
  }
  if(!pending||pending.request.checkpointId!==checkpointId||!pending.initiator)throw new Error('word-checkpoint-pending-unresolved')
  return{initiator:structuredClone(pending.initiator),baseRevision:pending.request.expectedRevision,acknowledged,revision:capsule.base.revision}
 }
 async load(signal?:AbortSignal):Promise<{capsule:WordSaveCapsule;hash:string}|undefined>{
  signal?.throwIfAborted();if(this.writing)throw new Error('word-journal-busy');const generation=this.stateGeneration,hashes=['none'],snapshots=new Set<string>()
  const publish=()=>{signal?.throwIfAborted();if(this.writing||this.stateGeneration!==generation)throw new Error('word-journal-changed');this.stateGeneration++}
  try{await this.safeDirectory()}catch(error){signal?.throwIfAborted();if((error as NodeJS.ErrnoException).code==='ENOENT'){publish();this.tip='none';this.hashes=hashes;this.snapshots=snapshots;this.lastCapsule=undefined;return}throw error}
  signal?.throwIfAborted()
  let previous='none',last:{capsule:WordSaveCapsule;hash:string}|undefined
  const prepared=new Map<string,string>()
  for(let count=0;count<4096;count++){
   const next=await this.read(previous);signal?.throwIfAborted();if(!next){publish();this.tip=previous;this.lastCapsule=last?.capsule;this.hashes=hashes;this.snapshots=snapshots;return last}
   snapshots.add(fingerprint(next.capsule))
   assertWordLinkJournalTransition(last?.capsule,next.capsule,previous,'load')
   const story=next.capsule.storyAcknowledgement,oldStory=last?.capsule.pendingStory
   if(last&&topologyFingerprint(last.capsule)!==topologyFingerprint(next.capsule)&&(!story||!oldStory||story.journalHash!==previous||JSON.stringify(story.pending)!==JSON.stringify(oldStory))&&!next.capsule.staleRebase)fail()
   if(story&&last?.capsule.pendingStory&&(!oldStory||story.journalHash!==previous||JSON.stringify(story.pending)!==JSON.stringify(oldStory)))fail()
   const proof=next.capsule.layoutAcknowledgement,pending=last?.capsule.pendingLayout,checkpoint=next.capsule.checkpointAcknowledgement,unchanged=next.capsule.unchangedAcknowledgement,prior=last?.capsule.pending
   if(proof&&(!pending||proof.journalHash!==previous||JSON.stringify(proof.request)!==JSON.stringify(pending.request)||next.capsule.base.digest!==last!.capsule.base.digest))fail()
   if(pending&&!proof&&JSON.stringify(pending)!==JSON.stringify(next.capsule.pendingLayout))fail()
   if(next.capsule.version===3&&!(last===undefined&&cleanLayoutGenesis(next.capsule))&&last?.capsule.version!==3&&!(last?.capsule.layoutAcknowledgement&&JSON.stringify(promoteLayout(last.capsule))===JSON.stringify(next.capsule))&&!(last?.capsule.storyAcknowledgement&&JSON.stringify(promoteStoryCapsule(last.capsule))===JSON.stringify(next.capsule))&&!(last?.capsule.linkAcknowledgement&&JSON.stringify(promoteLinkCapsule(last.capsule))===JSON.stringify(next.capsule)))fail()
   if(next.capsule.version===4&&last?.capsule.version!==4&&(!last||last.capsule.pending||last.capsule.pendingLayout||last.capsule.version===2||!next.capsule.pendingStory||JSON.stringify(prepareStoryCapsule(last.capsule,next.capsule.pendingStory))!==JSON.stringify(next.capsule)))fail()
   if(last?.capsule.version===4){
    if(next.capsule.version===3&&last.capsule.storyAcknowledgement&&JSON.stringify(promoteStoryCapsule(last.capsule))===JSON.stringify(next.capsule)){last=next;previous=next.hash;hashes.push(next.hash);continue}
    if(next.capsule.version!==4)fail()
    if(last.capsule.pendingStory){if(!story&&(JSON.stringify(last.capsule.pendingStory)!==JSON.stringify(next.capsule.pendingStory)||JSON.stringify(last.capsule.base)!==JSON.stringify(next.capsule.base)))fail()}
    else if(JSON.stringify(last.capsule.storyAcknowledgement)!==JSON.stringify(story)||JSON.stringify(last.capsule.base)!==JSON.stringify(next.capsule.base))fail()
   }
   if(last?.capsule.version===3&&next.capsule.version===2&&(!next.capsule.pendingLayout||last.capsule.pending||JSON.stringify(prepareLayoutCapsule(last.capsule,next.capsule.pendingLayout))!==JSON.stringify(next.capsule)))fail()
   if(last?.capsule.version===3&&next.capsule.version!==3&&next.capsule.version!==4&&next.capsule.version!==2&&next.capsule.version!==5||last?.capsule.layoutAcknowledgement&&next.capsule.version!==3)fail()
   if(checkpoint&&(!prior||checkpoint.journalHash!==previous||JSON.stringify(checkpoint.request)!==JSON.stringify(prior.request)))fail()
   if(unchanged&&(!prior||unchanged.journalHash!==previous||JSON.stringify(unchanged.request)!==JSON.stringify(prior.request)||JSON.stringify(last!.capsule.base)!==JSON.stringify(next.capsule.base)))fail()
   if(unchanged?.requestJournalHash&&(!last||prepared.get(unchanged.requestJournalHash)!==hash(JSON.stringify({base:last.capsule.base,pending:prior}))))fail()
   const rebase=next.capsule.staleRebase,oldAck=last?.capsule.checkpointAcknowledgement??last?.capsule.unchangedAcknowledgement,oldRebase=last?.capsule.staleRebase
   if(rebase&&(!last||last.capsule.pending||!oldAck&&!oldRebase||rebase.sourceTip!==previous||rebase.checkpointId!==(oldAck?.request.checkpointId??oldRebase?.checkpointId)||oldRebase&&JSON.stringify(rebase.actor)!==JSON.stringify(oldRebase.actor)||rebase.baseRevision!==last.capsule.base.revision||next.capsule.base.revision<=rebase.baseRevision||next.capsule.base.layoutHash!==last.capsule.base.layoutHash||!next.capsule.observation||JSON.stringify(last.capsule.actors)!==JSON.stringify(next.capsule.actors)||JSON.stringify(last.capsule.references??[])!==JSON.stringify(next.capsule.references??[])||JSON.stringify(last.capsule.uploads??[])!==JSON.stringify(next.capsule.uploads??[])||JSON.stringify(last.capsule.recoveries??[])!==JSON.stringify(next.capsule.recoveries??[])||JSON.stringify(last.capsule.decisions??[])!==JSON.stringify(next.capsule.decisions??[])))fail()
   if(last?.capsule.version===3&&prior&&!checkpoint&&!unchanged&&(JSON.stringify(prior)!==JSON.stringify(next.capsule.pending)||JSON.stringify(last.capsule.base)!==JSON.stringify(next.capsule.base)))fail()
   if(last?.capsule.version===3&&!checkpoint&&!rebase&&JSON.stringify(last.capsule.base)!==JSON.stringify(next.capsule.base))fail()
   if(next.capsule.pending)prepared.set(next.hash,hash(JSON.stringify({base:next.capsule.base,pending:next.capsule.pending})))
   last=next;previous=next.hash;hashes.push(next.hash)
  }
  throw new Error('word-journal-chain-limit')
 }
 async archiveSnapshot(input:WordSaveCapsule,reason:string){
  const capsule=this.verifyCapsuleProof(validateWordSaveCapsule(input,this.scope,this.allowLayout,this.allowStory,this.allowLink)),id=randomUUID().replaceAll('-',''),payload=JSON.stringify(capsule)
  if(!/^word-owner-[a-z-]{1,64}$/.test(reason)||Buffer.byteLength(payload)>limit)fail()
  await this.safeDirectory(true)
  const bytes=await compress(Buffer.from(JSON.stringify({version:1,id,reason,payload,signature:this.sign(`archive:${id}:${reason}`,payload)})))
  if(bytes.length>16*1024*1024)fail()
  const temporary=join(this.directory,`${id}.tmp`),destination=join(this.directory,`recovery-${id}.gz`)
  try{const file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(bytes);await file.sync()}finally{await file.close()}await fs.link(temporary,destination);await this.sync();return id}finally{await fs.rm(temporary,{force:true}).catch(()=>{})}
 }
 async recoverySnapshots(){
  try{await this.safeDirectory()}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error}
  const names=(await fs.readdir(this.directory)).filter(name=>/^recovery-[a-f0-9]{32}\.gz$/.test(name)).sort()
  if(names.length>256)throw new Error('word-recovery-limit')
  const records:Array<{id:string;reason:string;capsule:WordSaveCapsule}>=[]
  for(const name of names){
   const path=join(this.directory,name),file=await fs.open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
   try{const stat=await file.stat();if(!stat.isFile()||stat.size>16*1024*1024)fail();const bytes=await file.readFile(),value=JSON.parse((await decompress(bytes,{maxOutputLength:limit*2})).toString('utf8'))
    if(!value||Object.keys(value).sort().join(',')!=='id,payload,reason,signature,version'||value.version!==1||name!==`recovery-${value.id}.gz`||!hex(value.id,32)||typeof value.reason!=='string'||!/^word-owner-[a-z-]{1,64}$/.test(value.reason)||typeof value.payload!=='string'||Buffer.byteLength(value.payload)>limit||!hex(value.signature)||!timingSafeEqual(Buffer.from(value.signature),Buffer.from(this.sign(`archive:${value.id}:${value.reason}`,value.payload))))fail()
    records.push({id:value.id,reason:value.reason,capsule:this.verifyCapsuleProof(validateWordSaveCapsule(JSON.parse(value.payload),this.scope,this.allowLayout,this.allowStory,this.allowLink))})
   }finally{await file.close()}
  }
  return records
 }
 snapshotRecorded(capsule:WordSaveCapsule){return this.snapshots.has(fingerprint(this.verifyCapsuleProof(validateWordSaveCapsule(capsule,this.scope,this.allowLayout,this.allowStory,this.allowLink))))}
 async save(input:WordSaveCapsule,expectedHash:string,beforePublish?:()=>void):Promise<string>{
  return this.append(input,expectedHash,beforePublish,false)
 }
 /** The host must prove an empty journal, canonical head and owner lease first. */
 async initializeLayout(input:WordSaveCapsule,beforePublish:()=>void){
  if(!this.allowLayout||typeof beforePublish!=='function'||!cleanLayoutGenesis(input))throw new Error('word-layout-coordinator-required')
  return this.append(input,'none',beforePublish,false,false,false,false,false,false,false,true)
 }
 /** Persist an exact pending story request before any network submission. */
 private appendLink(capsule:WordSaveCapsule,expectedHash:string,guard:()=>void,action:WordLinkJournalAction){
  return this.append(capsule,expectedHash,guard,false,false,false,false,false,false,false,false,false,action)
 }
 /** Only a clean checkpoint owner may durably prepare this exact link. */
 async prepareLink(input:WordPendingLink,expectedHash:string,beforePublish:()=>void){
  if(!this.allowLayout||!this.allowStory||!this.allowLink||typeof beforePublish!=='function')throw Error('word-link-coordinator-required')
  const pending=readWordPendingLink(input,this.scope.documentId);beforePublish();if(this.tip===undefined)await this.load()
  if(await this.topologyAbandoned(pending.request.transactionId))throw Error('word-topology-cancelled');beforePublish()
  const current=this.lastCapsule
  if(this.tip!==expectedHash||current?.version!==3||current.pending)throw Error('word-link-pending-unresolved')
  if(await this.topologyPrepared(pending.request.transactionId,beforePublish))throw Error('word-topology-already-prepared');beforePublish()
  const capsule=prepareLinkCapsule(current,pending),tip=await this.appendLink(capsule,expectedHash,beforePublish,'prepare')
  return{tip,capsule:structuredClone(capsule)}
 }
 /** Build the sole layoutHash mutation on an isolated copy, then ask native
  * to sign its exact bytes. Callbacks receive bytes, never the mutable copy. */
 async acknowledgeLink(record:unknown,baseRecord:unknown,previous:WordRegionProjection,next:WordRegionProjection,expectedHash:string,beforePublish:()=>void,issueReceipt:(initialUpdate:Uint8Array)=>Promise<unknown>){
  if(!this.allowLayout||!this.allowStory||!this.allowLink||typeof beforePublish!=='function')throw Error('word-link-coordinator-required')
  beforePublish();if(this.tip===undefined)await this.load()
  const current=this.lastCapsule,pending=current?.pendingLink,base=baseRecord as {revision?:unknown;rootHash?:unknown},revision=record as {revision:number;rootHash:string}
  if(this.tip!==expectedHash||current?.version!==5||!pending)throw Error('word-link-pending-unresolved')
  if(base?.revision!==current.base.revision||base.rootHash!==current.base.rootHash||previous.documentId!==this.scope.documentId||previous.revision!==current.base.revision||previous.flowLayoutHash!==current.base.layoutHash||next.flowLayoutHash!==pending.candidateLayoutHash)throw Error('word-link-baseline-invalid')
  verifyWordLinkReceipt(previous,next,pending.request)
  const oldDoc=new Y.Doc(),newDoc=new Y.Doc(),draftDoc=new Y.Doc(),schema=wordRegionSchema()
  try{
   const oldCanonical=new WordRegionStore(oldDoc,schema,this.scope.documentId,previous.flowLayout,previous.flowLayoutHash);oldCanonical.initialize(previous)
   const newCanonical=new WordRegionStore(newDoc,schema,this.scope.documentId,next.flowLayout,next.flowLayoutHash);newCanonical.initialize(next)
   if(hash(oldCanonical.contents())!==current.base.digest||hash(newCanonical.contents())!==current.base.digest)throw Error('word-link-content-changed')
   Y.applyUpdate(draftDoc,Buffer.from(current.document,'base64'))
   const draft=new WordRegionStore(draftDoc,schema,this.scope.documentId,previous.flowLayout,previous.flowLayoutHash),bound=current.observation===wordDraftObservation(draft)
   draft.acceptLinkFields(current.base.layoutHash,next.flowLayout,next.flowLayoutHash,pending.request)
   const initialUpdate=Y.encodeStateAsUpdate(draftDoc),receipt=await issueReceipt(initialUpdate.slice());beforePublish()
   if(!this.verifyLinkReceipt(record,pending,receipt,expectedHash,initialUpdate))throw Error('word-link-receipt-invalid')
   const encoded=Buffer.from(initialUpdate).toString('base64'),capsule:WordSaveCapsule={...structuredClone(current),...(bound?{observation:wordDraftObservation(draft)}:{}),base:{...current.base,revision:revision.revision,rootHash:revision.rootHash,layoutHash:next.flowLayoutHash},document:encoded,linkAcknowledgement:{pending:structuredClone(pending),record:structuredClone(record),receipt:structuredClone(receipt),journalHash:expectedHash,initialUpdate:encoded}}
   delete capsule.pendingLink
   const tip=await this.appendLink(capsule,expectedHash,beforePublish,'acknowledge');return{tip,capsule:structuredClone(capsule)}
  }finally{oldDoc.destroy();newDoc.destroy();draftDoc.destroy()}
 }
 async promoteLinkAcknowledgement(expectedHash:string,beforePublish:()=>void){
  if(!this.allowLayout||!this.allowStory||!this.allowLink||typeof beforePublish!=='function')throw Error('word-link-coordinator-required')
  beforePublish();if(this.tip===undefined)await this.load()
  const current=this.lastCapsule
  if(this.tip!==expectedHash||current?.version!==5||!current.linkAcknowledgement)throw Error('word-link-pending-unresolved')
  const capsule=promoteLinkCapsule(current),tip=await this.appendLink(capsule,expectedHash,beforePublish,'promote');return{tip,capsule:structuredClone(capsule)}
 }
 async prepareStory(pending:WordPendingStory,expectedHash:string,beforePublish:()=>void){
  if(!this.allowStory||typeof beforePublish!=='function')throw new Error('word-story-coordinator-required')
  beforePublish();if(this.tip===undefined)await this.load()
  if(await this.topologyAbandoned(pending.request.transactionId))throw new Error('word-topology-cancelled');beforePublish()
  const current=this.lastCapsule
  if(this.tip!==expectedHash||!current||current.version===2||current.version===4||current.pending||current.pendingLayout)throw new Error('word-story-pending-unresolved')
  const capsule=prepareStoryCapsule(current,pending),tip=await this.append(capsule,expectedHash,beforePublish,false,false,false,true)
  return{tip,capsule:structuredClone(capsule)}
 }
 /** Freeze a layout request against the exact durable room state. */
 async prepareLayout(pending:WordLayoutPending,expectedHash:string,beforePublish:()=>void){
  if(!this.allowLayout||typeof beforePublish!=='function')throw new Error('word-layout-coordinator-required')
  beforePublish();if(this.tip===undefined)await this.load()
  if(await this.topologyAbandoned(pending.request.transactionId))throw new Error('word-topology-cancelled');beforePublish()
  const current=this.lastCapsule
  if(this.tip!==expectedHash||!current||current.version===2||current.version===4||current.pending||current.pendingLayout)throw new Error('word-layout-pending-unresolved')
  const capsule=prepareLayoutCapsule(current,pending),tip=await this.append(capsule,expectedHash,beforePublish,false,false,false,false,false,false,true)
  return{tip,capsule:structuredClone(capsule)}
 }
 /** Offline recovery with authenticated immutable native records and the
  * coordinator-signed initial room state. The caller holds ownership and head
  * fences throughout this operation; it does not mutate a live Y.Doc. */
 async acknowledgeStory(record:unknown,receipt:unknown,baseRecord:unknown,previous:WordRegionProjection,next:WordRegionProjection,initialUpdate:Uint8Array,expectedHash:string,beforePublish:()=>void){
  if(!this.allowStory||typeof beforePublish!=='function')throw new Error('word-story-coordinator-required')
  beforePublish();if(this.tip===undefined)await this.load()
  const current=this.lastCapsule,pending=current?.pendingStory,base=baseRecord as {revision?:unknown;rootHash?:unknown}
  if(this.tip!==expectedHash||!current||current.version!==4||!pending)throw new Error('word-story-pending-unresolved')
  if(base?.revision!==current.base.revision||base.rootHash!==current.base.rootHash||!this.verifyStoryReceipt(record,pending,receipt,expectedHash,initialUpdate))throw new Error('word-story-receipt-invalid')
  const revision=record as {revision:number;rootHash:string},proof=receipt as {layoutHash:string}
  if(previous.documentId!==this.scope.documentId||previous.revision!==current.base.revision||previous.flowLayoutHash!==current.base.layoutHash||next.documentId!==this.scope.documentId||next.revision!==revision.revision||next.flowLayoutHash!==proof.layoutHash)throw new Error('word-story-projection-invalid')
  verifyWordStoryReceipt(previous,next,pending.intent,pending.blocks)
  const oldDoc=new Y.Doc(),newDoc=new Y.Doc(),draftDoc=new Y.Doc(),schema=wordRegionSchema()
  try{
   const oldCanonical=new WordRegionStore(oldDoc,schema,this.scope.documentId,previous.flowLayout,previous.flowLayoutHash);oldCanonical.initialize(previous)
   const newCanonical=new WordRegionStore(newDoc,schema,this.scope.documentId,next.flowLayout,next.flowLayoutHash);newCanonical.initialize(next)
   if(hash(oldCanonical.contents())!==current.base.digest)throw new Error('word-story-base-changed')
   Y.applyUpdate(draftDoc,Buffer.from(current.document,'base64'))
   const draft=new WordRegionStore(draftDoc,schema,this.scope.documentId,previous.flowLayout,previous.flowLayoutHash),bound=current.observation===wordDraftObservation(draft)
   Y.applyUpdate(draftDoc,initialUpdate);draft.syncStoryReceipt(previous,next,pending.intent,pending.blocks,initialUpdate)
   const ledger=new ReferenceAuthorLedger(regionBlocks(draft),regionBlocks(newCanonical));ledger.restore(current.references??[])
   const capsule:WordSaveCapsule={...structuredClone(current),...(bound?{observation:wordDraftObservation(draft)}:{}),references:ledger.proof(),base:{revision:revision.revision,rootHash:revision.rootHash,layoutHash:next.flowLayoutHash,digest:hash(newCanonical.contents())},document:Buffer.from(Y.encodeStateAsUpdate(draftDoc)).toString('base64'),storyAcknowledgement:{pending:structuredClone(pending),record:structuredClone(record),receipt:structuredClone(receipt),journalHash:expectedHash,initialUpdate:Buffer.from(initialUpdate).toString('base64')}}
   delete capsule.pendingStory
   const tip=await this.append(capsule,expectedHash,beforePublish,false,false,false,false,true)
   return{tip,capsule:structuredClone(capsule)}
  }finally{oldDoc.destroy();newDoc.destroy();draftDoc.destroy()}
 }
 /** Advance to the normal checkpoint model while retaining the signed story
  * acknowledgement in its immutable parent record. */
 async promoteStoryAcknowledgement(expectedHash:string,beforePublish:()=>void){
  if(!this.allowStory||!this.allowLayout||typeof beforePublish!=='function')throw new Error('word-story-coordinator-required')
  beforePublish();if(this.tip===undefined)await this.load()
  const current=this.lastCapsule
  if(this.tip!==expectedHash||current?.version!==4||!current.storyAcknowledgement)throw new Error('word-story-pending-unresolved')
  const capsule=promoteStoryCapsule(current),tip=await this.append(capsule,expectedHash,beforePublish,false,false,false,false,false,true)
  return{tip,capsule:structuredClone(capsule)}
 }
 /** Adopt an already authenticated layout receipt into the layout-aware
  * checkpoint model. The first v3 record must be an exact copy of the
  * acknowledgement's state; the immutable parent retains the proof. */
 async promoteLayoutAcknowledgement(expectedHash:string,beforePublish:()=>void){
  if(!this.allowLayout||typeof beforePublish!=='function')throw new Error('word-layout-coordinator-required')
  beforePublish();if(this.tip===undefined)await this.load()
  const current=this.lastCapsule
  if(this.tip!==expectedHash||current?.version!==2||!current.layoutAcknowledgement)throw new Error('word-layout-pending-unresolved')
  const capsule=promoteLayout(current),tip=await this.append(capsule,expectedHash,beforePublish,false,true)
  return{tip,capsule:structuredClone(capsule)}
 }
 /** Offline recovery only: callers must stop the room and supply authenticated
  * immutable projections, a live lease/authority fence and its recorded tip.
  * Returns a new signed capsule; never replaces or mutates a live Y.Doc. */
 async acknowledgeLayout(record:unknown,receipt:unknown,previous:WordRegionProjection,next:WordRegionProjection,expectedHash:string,beforePublish:()=>void){
  if(!this.allowLayout||typeof beforePublish!=='function')throw new Error('word-layout-coordinator-required')
  beforePublish()
  if(this.tip===undefined)await this.load()
  const current=this.lastCapsule,pending=current?.pendingLayout
  if(this.tip!==expectedHash||!current||current.version!==2||!pending)throw new Error('word-layout-pending-unresolved')
  if(!this.verifyLayoutReceipt(record,pending.request,receipt,expectedHash))throw new Error('word-layout-receipt-invalid')
  const revision=record as {revision:number;rootHash:string},schema=wordRegionSchema()
  if(previous.documentId!==this.scope.documentId||previous.revision!==current.base.revision||previous.flowLayoutHash!==current.base.layoutHash||next.documentId!==this.scope.documentId||next.revision!==revision.revision||!hex(next.flowLayoutHash))throw new Error('word-layout-projection-invalid')
  const oldDoc=new Y.Doc(),newDoc=new Y.Doc(),draftDoc=new Y.Doc()
  try{
   const oldCanonical=new WordRegionStore(oldDoc,schema,this.scope.documentId,previous.flowLayout,previous.flowLayoutHash);oldCanonical.initialize(previous)
   const newCanonical=new WordRegionStore(newDoc,schema,this.scope.documentId,next.flowLayout,next.flowLayoutHash);newCanonical.initialize(next)
   if(hash(oldCanonical.contents())!==current.base.digest||hash(newCanonical.contents())!==current.base.digest)throw new Error('word-layout-content-changed')
   Y.applyUpdate(draftDoc,Buffer.from(current.document,'base64'))
   const draft=new WordRegionStore(draftDoc,schema,this.scope.documentId,previous.flowLayout,previous.flowLayoutHash)
   const bound=current.observation===wordDraftObservation(draft);draft.acceptLayoutFields(current.base.layoutHash,next.flowLayout,next.flowLayoutHash,pending.request)
   const capsule:WordSaveCapsule={...structuredClone(current),...(bound?{observation:wordDraftObservation(draft)}:{}),version:2,base:{...current.base,revision:revision.revision,rootHash:revision.rootHash,layoutHash:next.flowLayoutHash},document:Buffer.from(Y.encodeStateAsUpdate(draftDoc)).toString('base64'),layoutAcknowledgement:{request:structuredClone(pending.request),record:structuredClone(record),receipt:structuredClone(receipt),journalHash:expectedHash}}
   delete capsule.pendingLayout
   const tip=await this.append(capsule,expectedHash,beforePublish,true)
   return{tip,capsule:structuredClone(capsule)}
  }finally{oldDoc.destroy();newDoc.destroy();draftDoc.destroy()}
 }
 /** Stopped-room checkpoint recovery. Both projections, the base revision
  * record and each image must come from authenticated immutable native reads;
  * the caller fences authority, head and ownership throughout this operation. */
 async acknowledgeCheckpoint(record:unknown,receipt:unknown,baseRecord:unknown,previous:WordRegionProjection,next:WordRegionProjection,images:ImageNode[],expectedHash:string,beforePublish:()=>void){
  if(!this.allowLayout||typeof beforePublish!=='function')throw new Error('word-layout-coordinator-required')
  beforePublish();if(this.tip===undefined)await this.load()
  const current=this.lastCapsule,pending=current?.pending,base=baseRecord as {revision?:unknown;rootHash?:unknown}
  if(this.tip!==expectedHash||current?.version!==3||!pending)throw new Error('word-checkpoint-pending-unresolved')
  if(!this.verifyCheckpointReceipt(receipt,record,pending.request,expectedHash)||base?.revision!==current.base.revision||base.rootHash!==current.base.rootHash)throw new Error('word-checkpoint-receipt-invalid')
  const revision=record as {revision:number;rootHash:string}
  if(previous.documentId!==this.scope.documentId||previous.revision!==current.base.revision||previous.flowLayoutHash!==current.base.layoutHash||next.documentId!==this.scope.documentId||next.revision!==revision.revision||!hex(next.flowLayoutHash))throw new Error('word-checkpoint-projection-invalid')
  const oldDoc=new Y.Doc(),newDoc=new Y.Doc(),draftDoc=new Y.Doc(),schema=wordRegionSchema()
  try{
   const oldCanonical=new WordRegionStore(oldDoc,schema,this.scope.documentId,previous.flowLayout,previous.flowLayoutHash);oldCanonical.initialize(previous)
   const canonical=new WordRegionStore(newDoc,schema,this.scope.documentId,next.flowLayout,next.flowLayoutHash);canonical.initialize(next)
   const digest=hash(canonical.contents())
   if(hash(oldCanonical.contents())!==current.base.digest||digest!==pending.request.coordinatorDigest&&wordReceiptContents(canonical.capture())!==wordReceiptContents(pending.capture))throw new Error('word-checkpoint-content-mismatch')
   const captured=pending.images??[],oldRegions=wordImageRegions(previous),newRegions=wordImageRegions(next)
   if(captured.some(image=>oldRegions.get(image.change.nodeId)!==image.regionId||newRegions.get(image.change.nodeId)!==image.regionId))throw new Error('word-image-receipt-invalid')
   Y.applyUpdate(draftDoc,Buffer.from(current.document,'base64'))
   const draft=new WordRegionStore(draftDoc,schema,this.scope.documentId,previous.flowLayout,previous.flowLayoutHash)
   const attribution=checkpointAttribution(current,pending,draft,oldCanonical,()=>{draft.acceptSources(pending.capture,next);acknowledgeImages(draftDoc,captured,images,revision.revision,{kind:'word-checkpoint-recovery'})})
   const capsule:WordSaveCapsule={...structuredClone(current),...attribution,base:{revision:revision.revision,rootHash:revision.rootHash,layoutHash:next.flowLayoutHash,digest},document:Buffer.from(Y.encodeStateAsUpdate(draftDoc)).toString('base64'),checkpointAcknowledgement:{request:structuredClone(pending.request),record:structuredClone(record),receipt:structuredClone(receipt),journalHash:expectedHash}}
   delete capsule.pending
   const tip=await this.append(capsule,expectedHash,beforePublish,false,false,true)
   return{tip,capsule:structuredClone(capsule)}
  }finally{oldDoc.destroy();newDoc.destroy();draftDoc.destroy()}
 }
 /** Confirm an authenticated, unchanged native checkpoint without inventing
  * a revision. Its signed receipt is tied to the exact parent journal tip.
  * This keeps the old base even when the native head has advanced; callers
  * must fence further editing until the draft has been reconciled. */
 async acknowledgeUnchanged(receipt:unknown,baseRecord:unknown,projection:WordRegionProjection,expectedHash:string,beforePublish:()=>void){
  if(!this.allowLayout||typeof beforePublish!=='function')throw new Error('word-layout-coordinator-required')
  beforePublish();if(this.tip===undefined)await this.load()
  const current=this.lastCapsule,pending=current?.pending,base=baseRecord as {revision?:unknown;rootHash?:unknown}
  if(this.tip!==expectedHash||current?.version!==3||!pending)throw new Error('word-checkpoint-pending-unresolved')
  const requestJournalHash=(receipt as {journalHash?:unknown})?.journalHash
  if((pending.images??[]).length||base?.revision!==current.base.revision||base.rootHash!==current.base.rootHash||!hex(requestJournalHash)||!this.verifyUnchangedReceipt(receipt,pending.request,requestJournalHash,current.base.rootHash))throw new Error('word-checkpoint-receipt-invalid')
  if(requestJournalHash!==expectedHash){
   // The native no-op receipt is immutable and remains bound to the original
   // submission. Later durable input may advance the journal, but only an
   // authenticated ancestor with this exact pending capture may authorize it.
   const generation=this.stateGeneration,index=this.hashes.indexOf(requestJournalHash)
   if(index<1)throw new Error('word-checkpoint-receipt-invalid')
   const prepared=await this.read(this.hashes[index-1]);beforePublish()
   if(this.writing||this.stateGeneration!==generation||this.tip!==expectedHash||prepared?.hash!==requestJournalHash||JSON.stringify(prepared.capsule.base)!==JSON.stringify(current.base)||JSON.stringify(prepared.capsule.pending)!==JSON.stringify(pending))throw new Error('word-checkpoint-receipt-invalid')
  }
  if(projection.documentId!==this.scope.documentId||projection.revision!==current.base.revision||projection.flowLayoutHash!==current.base.layoutHash)throw new Error('word-checkpoint-projection-invalid')
  const canonicalDoc=new Y.Doc(),draftDoc=new Y.Doc(),schema=wordRegionSchema()
  try{
   const canonical=new WordRegionStore(canonicalDoc,schema,this.scope.documentId,projection.flowLayout,projection.flowLayoutHash);canonical.initialize(projection)
   if(hash(canonical.contents())!==current.base.digest||wordReceiptContents(canonical.capture())!==wordReceiptContents(pending.capture))throw new Error('word-checkpoint-content-mismatch')
   Y.applyUpdate(draftDoc,Buffer.from(current.document,'base64'));const draft=new WordRegionStore(draftDoc,schema,this.scope.documentId,projection.flowLayout,projection.flowLayoutHash)
   const attribution=checkpointAttribution(current,pending,draft,canonical,()=>draft.acceptSources(pending.capture,projection))
   const capsule:WordSaveCapsule={...structuredClone(current),...attribution,document:Buffer.from(Y.encodeStateAsUpdate(draftDoc)).toString('base64'),unchangedAcknowledgement:{request:structuredClone(pending.request),receipt:structuredClone(receipt),journalHash:expectedHash,...(requestJournalHash!==expectedHash?{requestJournalHash}:{})}}
   delete capsule.pending
   const tip=await this.append(capsule,expectedHash,beforePublish,false,false,true)
   return{tip,capsule:structuredClone(capsule)}
  }finally{canonicalDoc.destroy();draftDoc.destroy()}
 }
 /** Persist a rebuilt draft against a separately authenticated current head.
  * The caller must hold the stopped-room/owner fence and recheck authority and
  * head immediately before publication. No native document is written here. */
 async stageStaleRebase(previous:WordRegionProjection,previousRecord:{revision:number;rootHash:string},latest:WordRegionProjection,latestRecord:{revision:number;rootHash:string},expectedHash:string,actor:{userId:string;displayName:string},beforePublish:()=>void){
  if(!this.allowLayout||typeof beforePublish!=='function')throw new Error('word-layout-coordinator-required')
  beforePublish();const loaded=await this.load();beforePublish();if(!loaded)throw new Error('word-stale-rebase-invalid')
  const replay=loaded.capsule.staleRebase
  if(replay&&replay.sourceTip===expectedHash){if(replay.actor.userId!==actor.userId||replay.actor.displayName!==actor.displayName||loaded.capsule.base.revision!==latestRecord.revision||loaded.capsule.base.rootHash!==latestRecord.rootHash)throw new Error('word-stale-rebase-invalid');return{tip:loaded.hash,capsule:loaded.capsule,idempotentReplay:true}}
  const ack=loaded.capsule.checkpointAcknowledgement??loaded.capsule.unchangedAcknowledgement
  const checkpointId=ack?.request.checkpointId??replay?.checkpointId
  if(loaded.hash!==expectedHash||!checkpointId||loaded.capsule.pending)throw new Error('word-stale-rebase-invalid')
  const identity=await this.checkpointRecoveryIdentity(checkpointId);beforePublish()
  if(!identity.acknowledged||identity.initiator.userId!==actor.userId||identity.initiator.displayName!==actor.displayName)throw new Error('word-stale-rebase-not-allowed')
  const {prepareStaleWordRebase}=await import('./wordStaleRebase.ts');beforePublish()
  const result=prepareStaleWordRebase(this,loaded.capsule,previous,previousRecord,latest,latestRecord),capsule=result.capsule
  capsule.staleRebase={sourceTip:expectedHash,checkpointId,baseRevision:loaded.capsule.base.revision,actor:structuredClone(actor)}
  beforePublish();const tip=await this.append(capsule,expectedHash,beforePublish,false,false,false,false,false,false,false,false,true)
  return{tip,capsule:structuredClone(capsule),idempotentReplay:false}
 }
 private async append(input:WordSaveCapsule,expectedHash:string,beforePublish:(()=>void)|undefined,resolveLayout:boolean,promote=false,resolveCheckpoint=false,prepareStory=false,resolveStory=false,promoteStory=false,prepareLayout=false,initializeLayout=false,resolveStale=false,linkAction?:WordLinkJournalAction):Promise<string>{
  beforePublish?.()
  const capsule=this.verifyCapsuleProof(validateWordSaveCapsule(input,this.scope,this.allowLayout,this.allowStory,this.allowLink)),payload=JSON.stringify(capsule);if(Buffer.byteLength(payload)>limit)fail()
  if(this.tip===undefined)await this.load()
  if(this.writing)throw new Error('word-journal-busy');this.writing=true;this.stateGeneration++
  try{
  if(this.tip!==expectedHash)throw new Error('word-journal-changed')
  assertWordLinkJournalTransition(this.lastCapsule,capsule,expectedHash,linkAction??'save')
  if(this.lastCapsule&&topologyFingerprint(this.lastCapsule)!==topologyFingerprint(capsule)&&!resolveStory&&!resolveStale)throw new Error('word-story-coordinator-required')
  if(capsule.version===4&&this.lastCapsule?.version!==4&&(!prepareStory||!this.lastCapsule||!capsule.pendingStory||JSON.stringify(prepareStoryCapsule(this.lastCapsule,capsule.pendingStory))!==JSON.stringify(capsule)))throw new Error('word-story-coordinator-required')
  if(resolveStory&&(!capsule.storyAcknowledgement||!this.lastCapsule?.pendingStory||capsule.storyAcknowledgement.journalHash!==expectedHash||JSON.stringify(capsule.storyAcknowledgement.pending)!==JSON.stringify(this.lastCapsule.pendingStory)))throw new Error('word-story-receipt-invalid')
  if(promoteStory&&(!this.lastCapsule?.storyAcknowledgement||JSON.stringify(promoteStoryCapsule(this.lastCapsule))!==JSON.stringify(capsule)))throw new Error('word-story-coordinator-required')
  if(this.lastCapsule?.version===4&&!resolveStory&&!promoteStory&&(capsule.version!==4||JSON.stringify(this.lastCapsule.pendingStory)!==JSON.stringify(capsule.pendingStory)||JSON.stringify(this.lastCapsule.storyAcknowledgement)!==JSON.stringify(capsule.storyAcknowledgement)||JSON.stringify(this.lastCapsule.base)!==JSON.stringify(capsule.base)))throw new Error('word-story-pending-unresolved')
  if(capsule.version===3&&!(initializeLayout&&!this.lastCapsule&&expectedHash==='none'&&cleanLayoutGenesis(capsule))&&this.lastCapsule?.version!==3&&!(promote&&this.lastCapsule?.layoutAcknowledgement&&JSON.stringify(promoteLayout(this.lastCapsule))===JSON.stringify(capsule))&&!(promoteStory&&this.lastCapsule?.storyAcknowledgement&&JSON.stringify(promoteStoryCapsule(this.lastCapsule))===JSON.stringify(capsule))&&!(linkAction==='promote'&&this.lastCapsule?.linkAcknowledgement&&JSON.stringify(promoteLinkCapsule(this.lastCapsule))===JSON.stringify(capsule)))throw new Error('word-layout-coordinator-required')
  if(this.lastCapsule?.version===3&&capsule.version===2&&(!prepareLayout||this.lastCapsule.pending||!capsule.pendingLayout||JSON.stringify(prepareLayoutCapsule(this.lastCapsule,capsule.pendingLayout))!==JSON.stringify(capsule)))throw new Error('word-layout-coordinator-required')
  if(this.lastCapsule?.version===3&&capsule.version!==3&&capsule.version!==4&&capsule.version!==2&&capsule.version!==5||this.lastCapsule?.layoutAcknowledgement&&!promote)throw new Error('word-layout-coordinator-required')
  if(this.lastCapsule?.version===3&&this.lastCapsule.pending&&!resolveCheckpoint&&(JSON.stringify(this.lastCapsule.pending)!==JSON.stringify(capsule.pending)||JSON.stringify(this.lastCapsule.base)!==JSON.stringify(capsule.base)))throw new Error('word-checkpoint-pending-unresolved')
  if(this.lastCapsule?.version===3&&!resolveCheckpoint&&!resolveStale&&JSON.stringify(this.lastCapsule.base)!==JSON.stringify(capsule.base))throw new Error('word-checkpoint-baseline-changed')
  if(capsule.staleRebase&&(!resolveStale||capsule.staleRebase.sourceTip!==expectedHash||capsule.staleRebase.checkpointId!==((this.lastCapsule?.checkpointAcknowledgement??this.lastCapsule?.unchangedAcknowledgement)?.request.checkpointId??this.lastCapsule?.staleRebase?.checkpointId)||capsule.staleRebase.baseRevision!==this.lastCapsule?.base.revision))throw new Error('word-stale-rebase-invalid')
  if(capsule.checkpointAcknowledgement&&(!resolveCheckpoint||capsule.checkpointAcknowledgement.journalHash!==expectedHash||JSON.stringify(capsule.checkpointAcknowledgement.request)!==JSON.stringify(this.lastCapsule?.pending?.request)))throw new Error('word-checkpoint-receipt-invalid')
  if(capsule.unchangedAcknowledgement&&(!resolveCheckpoint||capsule.unchangedAcknowledgement.journalHash!==expectedHash||JSON.stringify(capsule.unchangedAcknowledgement.request)!==JSON.stringify(this.lastCapsule?.pending?.request)))throw new Error('word-checkpoint-receipt-invalid')
  if(capsule.layoutAcknowledgement&&(!resolveLayout||capsule.layoutAcknowledgement.journalHash!==expectedHash||JSON.stringify(capsule.layoutAcknowledgement.request)!==JSON.stringify(this.lastCapsule?.pendingLayout?.request)))throw new Error('word-layout-receipt-invalid')
  // No receipt protocol exists yet to authorize clearing or replacing an
  // uncertain layout request. Late content may append with the exact request.
  if(!resolveLayout&&this.lastCapsule?.pendingLayout&&JSON.stringify(this.lastCapsule.pendingLayout)!==JSON.stringify(capsule.pendingLayout))throw new Error('word-layout-pending-unresolved')
  await this.safeDirectory(true)
  const bytes=await compress(Buffer.from(JSON.stringify({version:1,previous:expectedHash,payload,signature:this.sign(expectedHash,payload)})))
  if(bytes.length>16*1024*1024)fail()
  const temporary=join(this.directory,`${randomUUID()}.tmp`)
  try{
   const fd=await fs.open(temporary,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync()}finally{await fd.close()}
   // link() fails if another process already appended to this exact parent.
   beforePublish?.()
   await fs.link(temporary,this.path(expectedHash));await this.sync();this.tip=hash(bytes);this.lastCapsule=structuredClone(capsule);this.snapshots.add(fingerprint(capsule));this.hashes.push(this.tip)
   // link and directory sync are asynchronous. If the owner or stopped-room
   // fence changed during either operation, the record is already durable:
   // report the published outcome so the next owner must reload the chain.
   try{beforePublish?.()}catch(error){throw new Error('word-journal-published-fence-lost',{cause:error})}
   return this.tip
  }catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('word-journal-changed');throw error}
  finally{await fs.rm(temporary,{force:true}).catch(()=>{})}
  }finally{this.writing=false}
 }
}
