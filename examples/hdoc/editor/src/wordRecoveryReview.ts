/** Server-only review of signed regional recovery snapshots. A choice appends a
 * new private state; it never replaces the canonical document or archive. */
import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import {WordCheckpointJournal,type WordSaveCapsule,type WordRecoveryDecision} from './wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,wordBoundaryName,type WordRegionProjection} from './wordRegionStore.ts'
import {wordRoomGuard} from './wordRoomGuard.ts'
import {wordImageRegions} from './wordImages.ts'
import {imageDraftContents,imageDraftMap,captureImages} from './collaborativeImages.ts'
import {ReferenceAuthorLedger,snapshotReferences,validActorId,actorName,type ReferenceAuthorEntry} from './referenceAuthors.ts'
import {businessDraftProblem} from './businessDrafts.ts'
import {revisionDifferences,revisionBlockText} from './revisionDiff.ts'
import type {Block,Projection} from './schema.ts'
import {validateWordUploads,type WordUploadRecord} from './wordUploads.ts'
import {wordRegionalProtocol,wordLayoutProtocol} from './collaborationProtocol.ts'
import {requireWordBrowserProtocol,type WordBrowserProtocol} from './wordBrowserProtocol.ts'
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const ordered=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
const flatten=(model:WordRegionStore)=>model.capture().regions.flatMap(region=>region.blocks)
const observation=(model:WordRegionStore)=>{const digest=hash(model.contents());return model.document.getMap(imageDraftMap).size?hash(`${digest}:${hash(imageDraftContents(model.document))}`):digest}
const bound=(capsule:WordSaveCapsule,model:WordRegionStore)=>capsule.observation===observation(model)||capsule.observation===undefined&&hash(model.contents())===capsule.base.digest&&!model.document.getMap(imageDraftMap).size
export const compareWordRegions=(a:WordRegionStore,b:WordRegionStore)=>{
    const aa=new Map(a.capture().regions.map(region=>[region.regionId,region.blocks])),bb=new Map(b.capture().regions.map(region=>[region.regionId,region.blocks])),keys=(model:WordRegionStore)=>{const groups=new Map<string,string[]>();let region='';for(const block of model.structure.blocks()){if(block.node.type.name===wordBoundaryName){region=block.node.attrs.regionId;groups.set(region,[])}else groups.get(region)!.push(block.key)}return groups},ak=keys(a),bk=keys(b),rows:Array<{regionId:string;kind:string;moved:boolean;formatChanged:boolean;before:string;after:string;truncated:boolean}>=[]
    for(const regionId of new Set([...aa.keys(),...bb.keys()])){
     const blocks=(captured:typeof aa,ids:Map<string,string[]>)=>(captured.get(regionId)??[]).map((entry,index)=>({...entry,blockId:ids.get(regionId)![index],blockHash:'recovery',region:'body'} as Block))
     for(const diff of revisionDifferences({blocks:blocks(aa,ak)} as Projection,{blocks:blocks(bb,bk)} as Projection))if(diff.kind!=='same'||diff.moved){const before=diff.before?revisionBlockText(diff.before.content):'',after=diff.after?revisionBlockText(diff.after.content):'';rows.push({regionId,kind:diff.kind,moved:diff.moved,formatChanged:diff.formatChanged,before:before.slice(0,16000),after:after.slice(0,16000),truncated:before.length>16000||after.length>16000})}
    }
    return rows
   }
export class WordRecoveryError extends Error{constructor(readonly code:string,readonly status=409){super(code)}}
export type WordRecoveryChoice={requestId:string;archiveId:string;reviewHash:string;action:'merge'|'keep-current'}
type Actor={userId:string;displayName?:string;scope:'read'|'write'}
type Options={protocol?:WordBrowserProtocol;journal:WordCheckpointJournal;native:(revision:number)=>Promise<{projection:WordRegionProjection;rootHash:string}>;assertOwnership?:()=>void;recordDurable?:(hash:string,ancestors:readonly string[])=>Promise<void>;authorize?:(actor:Actor)=>Promise<void>}
function fail(code:string):never{throw new WordRecoveryError(code)}
function mergeUploads(a:WordUploadRecord[]=[],b:WordUploadRecord[]=[]){
 const normalized=(record:WordUploadRecord)=>['reserved','staged','interrupted'].includes(record.phase)?{...record,phase:'interrupted' as const,problem:'word-upload-interrupted'}:record
 const records=new Map(a.map(record=>[record.id,normalized(record)]))
 for(const record of b){const next=normalized(record),previous=records.get(record.id);if(previous&&ordered(previous)!==ordered(next))fail('word-recovery-upload-conflict');records.set(record.id,next)}
 const result=[...records.values()];validateWordUploads(result);return result
}
function mergeReferences(current:WordSaveCapsule,archive:WordSaveCapsule,model:WordRegionStore,canonical:WordRegionStore){
 const next=snapshotReferences(flatten(model)),main=new Map((current.references??[]).map(entry=>[entry.mentionId,entry])),other=new Map((archive.references??[]).map(entry=>[entry.mentionId,entry])),entries:ReferenceAuthorEntry[]=[]
 for(const id of new Set([...main.keys(),...other.keys()])){
  const ref=next.get(id),matches=(entry:ReferenceAuthorEntry|undefined)=>entry&&(entry.present?!!ref&&ordered(entry.target)===ordered(ref.target):!ref)
  // Prefer the current signed proof when it still describes the merged value.
  const entry=matches(main.get(id))?main.get(id):matches(other.get(id))?other.get(id):undefined
  if(entry)entries.push(entry)
 }
 const ledger=new ReferenceAuthorLedger(flatten(model),flatten(canonical));ledger.restore(entries);ledger.capture(flatten(model));return ledger.proof()
}
export class WordRecoveryReview{
 private natives=new Map<number,Promise<{projection:WordRegionProjection;rootHash:string}>>()
 private protocol:WordBrowserProtocol
 constructor(private options:Options){this.protocol=requireWordBrowserProtocol(options.protocol??wordRegionalProtocol)}
 private native(revision:number){let value=this.natives.get(revision);if(!value){value=this.options.native(revision);this.natives.set(revision,value)}return value}
 private async read(){
  const current=await this.options.journal.load(),archives=await this.options.journal.recoverySnapshots(),handled=new Set(current?.capsule.recoveries??[])
  const expected=this.protocol===wordLayoutProtocol?3:1
  if(current&&current.capsule.version!==expected||this.protocol===wordRegionalProtocol&&archives.some(entry=>entry.capsule.version!==expected))fail('word-layout-coordinator-required')
  const pending=archives.filter(entry=>!handled.has(entry.id)&&!this.options.journal.snapshotRecorded(entry.capsule))
  const reviewHash=hash(ordered({tip:current?.hash??'none',archives:archives.map(entry=>({id:entry.id,capsule:hash(ordered(entry.capsule)),reason:entry.reason}))}))
  return{current,archives,pending,reviewHash}
 }
 async list(){const state=await this.read(),pendingIds=new Set(state.pending.map(entry=>entry.id)),summary=(entry:typeof state.archives[number])=>({id:entry.id,reason:entry.reason,revision:entry.capsule.base.revision,actors:entry.capsule.actors.map(({userId,displayName})=>({userId,displayName})),uploads:entry.capsule.uploads?.filter(record=>!['applied','cancelled'].includes(record.phase)).length??0,pendingCheckpoint:!!entry.capsule.pending});return{version:1 as const,ready:!state.pending.length,reviewHash:state.reviewHash,currentRevision:state.current?.capsule.base.revision,archives:state.pending.map(summary),copies:state.archives.map(entry=>({...summary(entry),reviewed:!pendingIds.has(entry.id)}))}}
 private async model(capsule:WordSaveCapsule){
  const native=await this.native(capsule.base.revision),projection=native.projection,schema=wordRegionSchema(),canonicalDoc=new Y.Doc(),document=new Y.Doc()
  try{
   if(native.rootHash!==capsule.base.rootHash||projection.documentId!==capsule.documentId||projection.revision!==capsule.base.revision||projection.flowLayoutHash!==capsule.base.layoutHash)fail('word-recovery-baseline-invalid')
   const canonical=new WordRegionStore(canonicalDoc,schema,capsule.documentId,projection.flowLayout,projection.flowLayoutHash);canonical.initialize(projection)
   if(hash(canonical.contents())!==capsule.base.digest)fail('word-recovery-baseline-invalid')
   Y.applyUpdate(document,Buffer.from(capsule.document,'base64'));const model=new WordRegionStore(document,schema,capsule.documentId,projection.flowLayout,projection.flowLayoutHash);model.capture()
   return{model,canonical,projection,close:()=>{document.destroy();canonicalDoc.destroy()}}
  }catch(error){document.destroy();canonicalDoc.destroy();throw error}
 }
 private async merged(current:WordSaveCapsule,archive:WordSaveCapsule){
  const expected=this.protocol===wordLayoutProtocol?3:1
  if(current.version!==expected||archive.version!==expected)fail('word-layout-coordinator-required')
  if(ordered(current.base)!==ordered(archive.base))fail('word-recovery-base-changed')
  if(current.pending||archive.pending)fail('word-recovery-checkpoint-pending')
  const main=await this.model(current);let other:Awaited<ReturnType<WordRecoveryReview['model']>>|undefined
  try{
   other=await this.model(archive)
   if(!bound(current,main.model)||!bound(archive,other.model))fail('word-recovery-authors-unbound')
   const guard=wordRoomGuard(main.model,id=>wordImageRegions(main.projection).get(id),undefined,this.protocol);try{guard.accept(Buffer.from(archive.document,'base64'))}finally{guard.destroy()}
   Y.applyUpdate(main.model.document,Buffer.from(archive.document,'base64'))
   const problem=businessDraftProblem(main.model.document,main.model.structure.project());if(problem)fail('word-recovery-content-conflict')
   captureImages(main.model.document)
   const people=new Map(current.actors.map(actor=>[actor.userId,actor]));for(const actor of archive.actors)if((people.get(actor.userId)?.generation??-1)<actor.generation)people.set(actor.userId,actor)
   return{...structuredClone(current),document:Buffer.from(Y.encodeStateAsUpdate(main.model.document)).toString('base64'),actors:[...people.values()],observation:observation(main.model),references:mergeReferences(current,archive,main.model,main.canonical),uploads:mergeUploads(current.uploads,archive.uploads)}
  }finally{other?.close();main.close()}
 }
 async preview(archiveId:string,offset=0){
  if(!/^[a-f0-9]{32}$/.test(archiveId)||!Number.isSafeInteger(offset)||offset<0)fail('word-recovery-invalid')
  const state=await this.read(),archive=state.pending.find(entry=>entry.id===archiveId);if(!state.current||!archive)fail('word-recovery-review-changed')
  const main=await this.model(state.current.capsule);let other:Awaited<ReturnType<WordRecoveryReview['model']>>|undefined
  try{
   other=await this.model(archive.capsule)

   const rows=compareWordRegions(main.model,other.model);let mergeProblem:string|undefined,proposedRows:ReturnType<typeof compareWordRegions>=[]
   try{const merged=await this.merged(state.current.capsule,archive.capsule),result=await this.model(merged);try{proposedRows=compareWordRegions(main.model,result.model)}finally{result.close()}}catch(error){mergeProblem=error instanceof WordRecoveryError?error.code:'word-recovery-merge-unavailable'}
   return{version:1 as const,archiveId,reviewHash:state.reviewHash,currentRevision:state.current.capsule.base.revision,archiveRevision:archive.capsule.base.revision,total:rows.length,offset,rows:rows.slice(offset,offset+25),proposedTotal:proposedRows.length,proposedRows:proposedRows.slice(offset,offset+25),canMerge:!mergeProblem,mergeProblem,imageChanges:imageDraftContents(main.model.document)!==imageDraftContents(other.model.document),uploadChoices:archive.capsule.uploads??[],regions:main.model.capture().regions.map(region=>({id:region.regionId,kind:main.projection.flowLayout.sections.some(section=>section.id===region.regionId)?'body':main.projection.flowLayout.stories.find(story=>story.id===region.regionId)?.kind??'body'}))}
  }finally{other?.close();main.close()}
 }
 async download(archiveId:string){const state=await this.read(),entry=state.archives.find(entry=>entry.id===archiveId);if(!entry)fail('word-recovery-review-changed');return{schemaVersion:'hcd-word-recovery/1',...structuredClone(entry)}}
 async resolve(choice:WordRecoveryChoice,actor:Actor){
  if(!choice||Object.keys(choice).sort().join(',')!=='action,archiveId,requestId,reviewHash'||!['merge','keep-current'].includes(choice.action)||!['archiveId','requestId'].every(key=>/^[a-f0-9]{32}$/.test(choice[key as 'archiveId']))||!/^[a-f0-9]{64}$/.test(choice.reviewHash)||actor.scope!=='write'||!validActorId(actor.userId))throw new WordRecoveryError('word-recovery-not-allowed',403)
  this.options.assertOwnership?.();await this.options.authorize?.(actor)
  const state=await this.read();if(!state.current)fail('word-recovery-review-changed')
  const previous=state.current.capsule.decisions?.find(entry=>entry.requestId===choice.requestId)
  if(previous){if(previous.archiveId!==choice.archiveId||previous.reviewHash!==choice.reviewHash||previous.action!==choice.action||previous.userId!==actor.userId)fail('word-recovery-request-changed');try{await this.options.recordDurable?.(state.current.hash,this.options.journal.knownHashes());this.options.assertOwnership?.()}catch{throw new WordRecoveryError('word-recovery-result-pending',503)}return{version:1 as const,requestId:choice.requestId,action:choice.action,journalHash:state.current.hash,idempotentReplay:true}}
  const archive=state.pending.find(entry=>entry.id===choice.archiveId)
  if(state.reviewHash!==choice.reviewHash||!archive)fail('word-recovery-review-changed')
  const capsule=choice.action==='merge'?await this.merged(state.current.capsule,archive.capsule):structuredClone(state.current.capsule)
  const decision:WordRecoveryDecision={...choice,userId:actor.userId,displayName:actorName(actor.displayName??actor.userId)}
  capsule.decisions=[...(capsule.decisions??[]),decision];capsule.recoveries=[...new Set([...(capsule.recoveries??[]),archive.id])]
  await this.options.authorize?.(actor);this.options.assertOwnership?.()
  try{const tip=await this.options.journal.save(capsule,state.current.hash,this.options.assertOwnership);await this.options.recordDurable?.(tip,this.options.journal.knownHashes());this.options.assertOwnership?.();return{version:1 as const,requestId:choice.requestId,action:choice.action,journalHash:tip,idempotentReplay:false}}catch{throw new WordRecoveryError('word-recovery-result-pending',503)}
 }
}
