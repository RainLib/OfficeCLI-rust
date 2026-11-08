/** Prepare a new-base capsule in memory. This function does not publish a
 * journal record or submit a native save. Callers must authenticate the two
 * immutable native reads and fence the room, owner and current head. */
import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import {WordCheckpointJournal,validateWordSaveCapsule,type WordSaveCapsule} from './wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {buildWordStaleCandidate,hasUnprojectedWordState} from './wordStaleCandidate.ts'
import {wordDraftObservation} from './wordDraftObservation.ts'
import {businessDraftProblem} from './businessDrafts.ts'
import {imageIntents} from './collaborativeImages.ts'
import type {SnapshotBlock} from './checkpointSnapshot.ts'

const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const unsupported=(block:SnapshotBlock)=>!['paragraph','heading','code_block','blockquote','horizontal_rule'].includes(block.content.kind)||!!block.content.extension||!!block.content.children?.length||block.content.inlines.some(inline=>!!inline.content||!!inline.extension||!!inline.reference||!!inline.customMarks?.length)
type RecordAtRevision={revision:number;rootHash:string}
export function prepareStaleWordRebase(journal:WordCheckpointJournal,saved:WordSaveCapsule,previous:WordRegionProjection,previousRecord:RecordAtRevision,latest:WordRegionProjection,latestRecord:RecordAtRevision){
 if(saved.version!==3||saved.pending||!saved.unchangedAcknowledgement&&!saved.checkpointAcknowledgement&&!saved.staleRebase||previous.documentId!==journal.scope.documentId||latest.documentId!==journal.scope.documentId||previous.revision!==saved.base.revision||previousRecord.revision!==saved.base.revision||previousRecord.rootHash!==saved.base.rootHash||previous.flowLayoutHash!==saved.base.layoutHash||latest.revision!==latestRecord.revision||latest.revision<=saved.base.revision||!/^[a-f0-9]{64}$/.test(latestRecord.rootHash))throw Error('word-stale-baseline-invalid')
 const originalDoc=new Y.Doc(),draftDoc=new Y.Doc(),currentDoc=new Y.Doc(),schema=wordRegionSchema()
 try{
  const original=new WordRegionStore(originalDoc,schema,journal.scope.documentId,previous.flowLayout,previous.flowLayoutHash);original.initialize(previous)
  if(hash(original.contents())!==saved.base.digest)throw Error('word-stale-baseline-invalid')
  Y.applyUpdate(draftDoc,Buffer.from(saved.document,'base64'));const draft=new WordRegionStore(draftDoc,schema,journal.scope.documentId,previous.flowLayout,previous.flowLayoutHash)
  const current=new WordRegionStore(currentDoc,schema,journal.scope.documentId,latest.flowLayout,latest.flowLayoutHash);current.initialize(latest)
  const captures=[original.capture(),draft.capture(),current.capture()]
  const unverified=!!saved.references?.length||!!saved.uploads?.length||[originalDoc,draftDoc,currentDoc].some(hasUnprojectedWordState)||imageIntents(draftDoc).length>0||!!businessDraftProblem(draftDoc,draft.structure.project())||[...previous.blocks,...latest.blocks].some(block=>block.readOnly||!!block.readOnlyHtml)||captures.some(capture=>capture.regions.some(region=>region.blocks.some(unsupported)))||!!previous.comments?.length||!!latest.comments?.length||!!previous.trackedChanges?.length||!!latest.trackedChanges?.length
  if(unverified)throw Error('word-stale-unsupported')
  if(saved.observation!==wordDraftObservation(draft)||!saved.actors.length)throw Error('contributors-unbound')
  const built=buildWordStaleCandidate(original,draft,current,false)
  try{
   if(!built.plan.changes.some(change=>change.side==='draft'))throw Error('word-stale-no-draft-changes')
   const capsule=structuredClone(saved);delete capsule.unchangedAcknowledgement;delete capsule.checkpointAcknowledgement;delete capsule.staleRebase
   capsule.base={revision:latest.revision,rootHash:latestRecord.rootHash,layoutHash:latest.flowLayoutHash,digest:hash(current.contents())}
   capsule.document=Buffer.from(Y.encodeStateAsUpdate(built.document)).toString('base64');capsule.observation=wordDraftObservation(built.candidate)
   return{capsule:validateWordSaveCapsule(capsule,journal.scope,true,true),changes:built.plan.changes}
  }finally{built.document.destroy()}
 }finally{originalDoc.destroy();draftDoc.destroy();currentDoc.destroy()}
}
