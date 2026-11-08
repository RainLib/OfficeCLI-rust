/** Compare the inherited story against the exact saved baseline before a
 * source-backed copy. Unrelated regional drafts remain untouched. */
import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,wordCheckpointContents,type WordRegionProjection} from './wordRegionStore.ts'
import {wordImageRegions} from './wordImages.ts'
import {imageIntents} from './collaborativeImages.ts'
import {businessDraftProblem} from './businessDrafts.ts'
import {readBoundedResponse} from './boundedResponse.ts'
import {WordRecoveryError} from './wordRecoveryReview.ts'

export async function requireSavedStorySource(journal:WordCheckpointJournal,request:(route:string)=>Promise<Response>,guard:()=>void,storyId:string,reviewHash:string){
 guard();const saved=await journal.load();guard();if(!saved||saved.hash!==reviewHash||saved.capsule.version!==3||saved.capsule.pending)throw new WordRecoveryError('word-recovery-review-changed')
 const revision=saved.capsule.base.revision,response=await request(`/editor?revision=${revision}`);if(!response.ok)throw new WordRecoveryError('word-recovery-baseline-unavailable')
 const projection=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,16*1024*1024,AbortSignal.timeout(30_000),'word-story-source-limit'))) as WordRegionProjection;guard()
 if(projection.documentId!==journal.scope.documentId||projection.revision!==revision||projection.flowLayoutHash!==saved.capsule.base.layoutHash||!projection.flowLayout.stories.some(story=>story.id===storyId))throw new WordRecoveryError('word-recovery-baseline-invalid')
 const canonicalDoc=new Y.Doc(),draftDoc=new Y.Doc()
 try{
  const schema=wordRegionSchema(),canonical=new WordRegionStore(canonicalDoc,schema,journal.scope.documentId,projection.flowLayout,projection.flowLayoutHash);canonical.initialize(projection)
  if(createHash('sha256').update(canonical.contents()).digest('hex')!==saved.capsule.base.digest)throw new WordRecoveryError('word-recovery-baseline-invalid')
  Y.applyUpdate(draftDoc,Buffer.from(saved.capsule.document,'base64'));const draft=new WordRegionStore(draftDoc,schema,journal.scope.documentId,projection.flowLayout,projection.flowLayoutHash)
  const before=canonical.capture().regions.find(region=>region.regionId===storyId),after=draft.capture().regions.find(region=>region.regionId===storyId);if(!before||!after)throw new WordRecoveryError('word-recovery-baseline-invalid')
  const imageRegions=wordImageRegions(projection),images=imageIntents(draftDoc);if(images.some(image=>!imageRegions.has(image.base.nodeId)))throw new WordRecoveryError('word-recovery-baseline-invalid')
  const pendingImages=images.some(image=>imageRegions.get(image.base.nodeId)===storyId),pendingUploads=saved.capsule.uploads?.some(upload=>upload.regionId===storyId&&['reserved','staged','interrupted'].includes(upload.phase))??false
  if(wordCheckpointContents({regions:[before]})!==wordCheckpointContents({regions:[after]})||pendingImages||pendingUploads||businessDraftProblem(draftDoc,draft.structure.project()))throw new WordRecoveryError('word-story-source-draft-pending')
  const latest=await journal.load();guard();if(latest?.hash!==reviewHash)throw new WordRecoveryError('word-recovery-review-changed')
 }finally{canonicalDoc.destroy();draftDoc.destroy()}
}
