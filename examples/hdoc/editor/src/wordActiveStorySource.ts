/** Compare affected regions with the pinned native baseline without loading
 * the active journal or treating unrelated body drafts as disposable. */
import * as Y from 'yjs'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import {WordRegionStore,wordRegionSchema,wordCheckpointContents,type WordRegionProjection} from './wordRegionStore.ts'
import {wordImageRegions} from './wordImages.ts'
import {imageIntents} from './collaborativeImages.ts'
import {businessDraftProblem} from './businessDrafts.ts'
export function activeWordStorySource(room:WordSaveCoordinator,projection:WordRegionProjection,regionIds:readonly string[],guard:()=>void){
 const document=new Y.Doc(),regions=new Set(regionIds)
 try{
  const canonical=new WordRegionStore(document,wordRegionSchema(),projection.documentId,projection.flowLayout,projection.flowLayoutHash);canonical.initialize(projection)
  return{assertReady(){
   guard();if(!regions.size)return
   const before=canonical.capture(),after=room.model.capture(),knownImages=wordImageRegions(projection),images=imageIntents(room.model.document)
   if(images.some(image=>!knownImages.has(image.base.nodeId)))throw Error('word-story-baseline-invalid')
   for(const id of regions){
    const old=before.regions.find(region=>region.regionId===id),current=after.regions.find(region=>region.regionId===id)
    if(!old||!current)throw Error('word-story-baseline-invalid')
    if(wordCheckpointContents({regions:[old]})!==wordCheckpointContents({regions:[current]})||images.some(image=>knownImages.get(image.base.nodeId)===id)||room.uploads.snapshot().some(upload=>upload.regionId===id&&['reserved','staged','interrupted'].includes(upload.phase)))throw Error('word-story-source-draft-pending')
   }
   if(businessDraftProblem(room.model.document,room.model.structure.project()))throw Error('word-story-source-draft-pending')
  },dispose(){document.destroy()}}
 }catch(error){document.destroy();throw error}
}
