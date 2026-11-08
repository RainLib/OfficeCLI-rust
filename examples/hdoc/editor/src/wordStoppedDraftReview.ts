/** Inspect a signed, stopped regional draft against its exact native baseline. */
import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {compareWordRegions,WordRecoveryError} from './wordRecoveryReview.ts'
import {wordDraftObservation} from './wordDraftObservation.ts'
import {imageIntents} from './collaborativeImages.ts'
import {businessDraftProblem} from './businessDrafts.ts'
import {revisionDifferences,revisionBlockText} from './revisionDiff.ts'
import type {Projection} from './schema.ts'
import type {WordLayout} from './wordRegions.ts'
import {wordDeviceBackupPreview} from './wordDeviceBackupPreview.ts'
import {planWordStaleMerge} from './wordStaleMergePlan.ts'
import type {SnapshotBlock} from './checkpointSnapshot.ts'
import {buildWordStaleCandidate,hasUnprojectedWordState} from './wordStaleCandidate.ts'

const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
export function wordStaleRegionCatalog(layout:WordLayout){
 const result=new Map<string,{kind:'body'|'header'|'footer';sections:number[]}>(),effective={header:{} as Record<string,string>,footer:{} as Record<string,string>}
 for(const story of layout.stories)result.set(story.id,{kind:story.kind,sections:[]})
 layout.sections.forEach((section,index)=>{result.set(section.id,{kind:'body',sections:[index+1]});for(const kind of ['header','footer'] as const){Object.assign(effective[kind],kind==='header'?section.headers:section.footers);for(const id of new Set(Object.values(effective[kind])))result.get(id)?.sections.push(index+1)}})
 return result
}
export async function inspectStoppedWordDraft(journal:WordCheckpointJournal,request:(route:string)=>Promise<Response>,guard:()=>void,offset:number){
 if(!Number.isSafeInteger(offset)||offset<0||offset%25!==0)throw new WordRecoveryError('word-recovery-invalid',400)
 const saved=await journal.load();guard()
 if(!saved||saved.capsule.version!==3||saved.capsule.pending)throw new WordRecoveryError('word-checkpoint-pending-unresolved')
 const json=async(route:string)=>{const response=await request(route);if(!response.ok)throw new WordRecoveryError('word-recovery-baseline-unavailable');return response.json()}
 const revision=saved.capsule.base.revision
 const [head,projection,record]=await Promise.all([json('/revisions?limit=1'),json(`/editor?revision=${revision}`),json(`/revisions/${revision}`)]) as [{headRevision:number},WordRegionProjection,{revision:number;rootHash:string}]
 guard();if(head.headRevision!==revision||record.revision!==revision||record.rootHash!==saved.capsule.base.rootHash||projection.documentId!==journal.scope.documentId||projection.revision!==revision||projection.flowLayoutHash!==saved.capsule.base.layoutHash)throw new WordRecoveryError('word-recovery-baseline-invalid')
 const canonicalDoc=new Y.Doc(),draftDoc=new Y.Doc()
 try{
  const schema=wordRegionSchema(),canonical=new WordRegionStore(canonicalDoc,schema,journal.scope.documentId,projection.flowLayout,projection.flowLayoutHash);canonical.initialize(projection)
  if(hash(canonical.contents())!==saved.capsule.base.digest)throw new WordRecoveryError('word-recovery-baseline-invalid')
  Y.applyUpdate(draftDoc,Buffer.from(saved.capsule.document,'base64'));const draft=new WordRegionStore(draftDoc,schema,journal.scope.documentId,projection.flowLayout,projection.flowLayoutHash)
  const rows=compareWordRegions(canonical,draft),images=imageIntents(draftDoc).length,changed=hash(draft.contents())!==saved.capsule.base.digest||images>0
  const problem=businessDraftProblem(draftDoc,draft.structure.project())?'word-recovery-content-conflict':saved.capsule.uploads?.some(upload=>['reserved','staged','interrupted'].includes(upload.phase))?'word-upload-interrupted':changed&&(saved.capsule.observation!==wordDraftObservation(draft)||!saved.capsule.actors.length)?'contributors-unbound':undefined
  const latest=await journal.load(),finalHead=await json('/revisions?limit=1');guard()
  if(latest?.hash!==saved.hash||finalHead.headRevision!==revision)throw new WordRecoveryError('word-recovery-review-changed')
  const page=rows.slice(offset,offset+25).map(row=>({...row,before:row.before.slice(0,2000),after:row.after.slice(0,2000),truncated:row.truncated||row.before.length>2000||row.after.length>2000}))
  return{reviewHash:saved.hash,revision,total:rows.length,offset,rows:page,imageChanges:images,changed,problem:problem??null,regions:draft.capture().regions.map(region=>({id:region.regionId,kind:projection.flowLayout.sections.some(section=>section.id===region.regionId)?'body':projection.flowLayout.stories.find(story=>story.id===region.regionId)?.kind??'body'}))}
 }finally{canonicalDoc.destroy();draftDoc.destroy()}
}

/** Read-only comparison against an advanced head. This is not a merge plan. */
export async function inspectStaleWordDraft(journal:WordCheckpointJournal,request:(route:string)=>Promise<Response>,guard:()=>void,offset:number){
 if(!Number.isSafeInteger(offset)||offset<0||offset%25!==0)throw new WordRecoveryError('word-recovery-invalid',400)
 const saved=await journal.load();guard();if(!saved||saved.capsule.version!==3||saved.capsule.pending||!saved.capsule.unchangedAcknowledgement&&!saved.capsule.checkpointAcknowledgement&&!saved.capsule.staleRebase)throw new WordRecoveryError('word-checkpoint-pending-unresolved')
 const json=async(route:string)=>{const response=await request(route);if(!response.ok)throw new WordRecoveryError('word-recovery-baseline-unavailable');return response.json()}
 const base=saved.capsule.base.revision,head=await json('/revisions?limit=1');guard();if(!Number.isSafeInteger(head.headRevision)||head.headRevision<=base)throw new WordRecoveryError('word-recovery-baseline-invalid')
 const current=head.headRevision as number,[previous,record,latest,currentRecord]=await Promise.all([json(`/editor?revision=${base}`),json(`/revisions/${base}`),json(`/editor?revision=${current}`),json(`/revisions/${current}`)]) as [WordRegionProjection,{revision:number;rootHash:string},WordRegionProjection,{revision:number;rootHash:string}]
 guard();if(record.revision!==base||record.rootHash!==saved.capsule.base.rootHash||previous.documentId!==journal.scope.documentId||previous.revision!==base||previous.flowLayoutHash!==saved.capsule.base.layoutHash||latest.documentId!==journal.scope.documentId||latest.revision!==current||currentRecord.revision!==current||!/^[a-f0-9]{64}$/.test(currentRecord.rootHash))throw new WordRecoveryError('word-recovery-baseline-invalid')
 const oldDoc=new Y.Doc(),draftDoc=new Y.Doc(),headDoc=new Y.Doc()
 try{
  const schema=wordRegionSchema(),old=new WordRegionStore(oldDoc,schema,journal.scope.documentId,previous.flowLayout,previous.flowLayoutHash);old.initialize(previous)
  if(hash(old.contents())!==saved.capsule.base.digest)throw new WordRecoveryError('word-recovery-baseline-invalid')
  Y.applyUpdate(draftDoc,Buffer.from(saved.capsule.document,'base64'));const draft=new WordRegionStore(draftDoc,schema,journal.scope.documentId,previous.flowLayout,previous.flowLayoutHash)
  // Validate the new projection independently, including its region topology.
  const headModel=new WordRegionStore(headDoc,schema,journal.scope.documentId,latest.flowLayout,latest.flowLayoutHash);headModel.initialize(latest)
  const baseCapture=old.capture(),draftCapture=draft.capture(),headCapture=headModel.capture()
  const unsupported=(block:SnapshotBlock)=>!['paragraph','heading','code_block','blockquote','horizontal_rule'].includes(block.content.kind)||!!block.content.extension||!!block.content.children?.length||block.content.inlines.some(inline=>!!inline.content||!!inline.extension||!!inline.reference||!!inline.customMarks?.length)
  const unverifiedObjects=imageIntents(draftDoc).length>0||!!saved.capsule.uploads?.length||!!saved.capsule.references?.length||[oldDoc,draftDoc,headDoc].some(hasUnprojectedWordState)||!!businessDraftProblem(draftDoc,draft.structure.project())||[...previous.blocks,...latest.blocks].some(block=>block.readOnly||!!block.readOnlyHtml)||[baseCapture,draftCapture,headCapture].some(capture=>capture.regions.some(region=>region.blocks.some(unsupported)))||!!previous.comments?.length||!!latest.comments?.length||!!previous.trackedChanges?.length||!!latest.trackedChanges?.length
  const plan=planWordStaleMerge({baseLayoutHash:previous.flowLayoutHash,currentLayoutHash:latest.flowLayoutHash,base:baseCapture.regions,draft:draftCapture.regions,current:headCapture.regions,unverifiedObjects})
  const mergeSummary={status:plan.status,reason:plan.reason??null,draft:plan.changes.filter(change=>change.side==='draft').length,current:plan.changes.filter(change=>change.side==='current').length,same:plan.changes.filter(change=>change.side==='same').length,conflicts:plan.changes.filter(change=>change.side==='conflict').length}
  const draftRows=compareWordRegions(old,draft),currentRows:typeof draftRows=[]
  let proposalRows:typeof draftRows=[],proposalAvailable=false,proposalProblem:'authors'|'source'|null=null
  if(plan.status==='review'){
   if(plan.changes.some(change=>change.side==='draft')&&(saved.capsule.observation!==wordDraftObservation(draft)||!saved.capsule.actors.length))proposalProblem='authors'
   else try{const proposed=buildWordStaleCandidate(old,draft,headModel,unverifiedObjects);try{proposalRows=compareWordRegions(headModel,proposed.candidate);proposalAvailable=true}finally{proposed.document.destroy()}}catch{proposalProblem='source'}
  }
  const group=(projection:WordRegionProjection)=>{const result=new Map<string,typeof projection.blocks>();for(const block of projection.blocks){if(!block.flowRegionId)throw new WordRecoveryError('word-recovery-baseline-invalid');const rows=result.get(block.flowRegionId)??[];rows.push(block);result.set(block.flowRegionId,rows)}return result},beforeGroups=group(previous),afterGroups=group(latest)
  for(const regionId of new Set([...beforeGroups.keys(),...afterGroups.keys()])){const before=beforeGroups.get(regionId)??[],after=afterGroups.get(regionId)??[]
   for(const diff of revisionDifferences({blocks:before} as Projection,{blocks:after} as Projection))if(diff.kind!=='same'||diff.moved){const a=diff.before?revisionBlockText(diff.before.content):'',b=diff.after?revisionBlockText(diff.after.content):'';currentRows.push({regionId,kind:diff.kind,moved:diff.moved,formatChanged:diff.formatChanged||diff.objectChanged,before:a,after:b,truncated:false})}}
  const oldCatalog=wordStaleRegionCatalog(previous.flowLayout),newCatalog=wordStaleRegionCatalog(latest.flowLayout)
  const limit=(rows:typeof draftRows,primary:typeof oldCatalog,secondary:typeof oldCatalog)=>rows.slice(offset,offset+25).map(row=>{const region=primary.get(row.regionId)??secondary.get(row.regionId);return{...row,region:region?{kind:region.kind,sections:region.sections.slice(0,50),sectionsTruncated:region.sections.length>50}:null,before:row.before.slice(0,2000),after:row.after.slice(0,2000),truncated:row.truncated||row.before.length>2000||row.after.length>2000}})
  const final=await journal.load(),finalHead=await json('/revisions?limit=1');guard();if(final?.hash!==saved.hash||finalHead.headRevision!==current)throw new WordRecoveryError('word-recovery-review-changed')
  return{reviewHash:saved.hash,baseRevision:base,headRevision:current,offset,draftTotal:draftRows.length,currentTotal:currentRows.length,draftRows:limit(draftRows,oldCatalog,newCatalog),currentRows:limit(currentRows,newCatalog,oldCatalog),proposalAvailable,proposalProblem,proposalTotal:proposalRows.length,proposalRows:limit(proposalRows,newCatalog,oldCatalog),imageChanges:imageIntents(draftDoc).length,layoutChanged:previous.flowLayoutHash!==latest.flowLayoutHash,mergeSummary}
 }finally{oldDoc.destroy();draftDoc.destroy();headDoc.destroy()}
}

/** Export all readable text from the retained draft, without changing it. */
export async function downloadStaleWordDraftText(journal:WordCheckpointJournal,request:(route:string)=>Promise<Response>,guard:()=>void,reviewHash:string,headRevision:number){
 if(!/^[a-f0-9]{64}$/.test(reviewHash)||!Number.isSafeInteger(headRevision)||headRevision<0)throw new WordRecoveryError('word-recovery-invalid',400)
 const saved=await journal.load();guard();if(!saved||saved.hash!==reviewHash||saved.capsule.version!==3||saved.capsule.pending||!saved.capsule.unchangedAcknowledgement&&!saved.capsule.checkpointAcknowledgement&&!saved.capsule.staleRebase)throw new WordRecoveryError('word-recovery-review-changed')
 const json=async(route:string)=>{const response=await request(route);if(!response.ok)throw new WordRecoveryError('word-recovery-baseline-unavailable');return response.json()}
 const base=saved.capsule.base.revision,[head,projection,record]=await Promise.all([json('/revisions?limit=1'),json(`/editor?revision=${base}`),json(`/revisions/${base}`)]) as [{headRevision:number},WordRegionProjection,{revision:number;rootHash:string}]
 guard();if(head.headRevision!==headRevision||headRevision<=base||record.revision!==base||record.rootHash!==saved.capsule.base.rootHash||projection.documentId!==journal.scope.documentId||projection.revision!==base||projection.flowLayoutHash!==saved.capsule.base.layoutHash)throw new WordRecoveryError('word-recovery-review-changed')
 const doc=new Y.Doc();try{
  const canonical=new WordRegionStore(doc,wordRegionSchema(),journal.scope.documentId,projection.flowLayout,projection.flowLayoutHash);canonical.initialize(projection);if(hash(canonical.contents())!==saved.capsule.base.digest)throw new WordRecoveryError('word-recovery-baseline-invalid')
  const preview=wordDeviceBackupPreview(Buffer.from(saved.capsule.document,'base64'),canonical,8*1024*1024)
  if(preview.truncated||Buffer.byteLength(JSON.stringify(preview.regions))>16*1024*1024)throw new WordRecoveryError('word-device-text-limit',413)
  const final=await journal.load(),latest=await json('/revisions?limit=1');guard();if(final?.hash!==reviewHash||latest.headRevision!==headRevision)throw new WordRecoveryError('word-recovery-review-changed')
  return{reviewHash,baseRevision:base,headRevision,regions:preview.regions}
 }finally{doc.destroy()}
}
