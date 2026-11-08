import type {Manifest,PageGroup} from './fixedPages.ts'

/** Validate a complete, revision-pinned story catalog before treating a story as absent. */
export function parseWordStoryIndex(input:unknown,manifest:Manifest):PageGroup[]{
 const data=input as {schemaVersion?:unknown;revision?:unknown;chunkCount?:unknown;wordRegionsVerified?:unknown;stories?:unknown}
 if(!data||data.schemaVersion!=='hcd-word-story-index/1'||data.revision!==manifest.revision||data.chunkCount!==manifest.chunkCount||data.wordRegionsVerified!==true||!Array.isArray(data.stories)||data.stories.length>65_536)throw new Error('wordStoryIndexInvalid')
 let previous=-1
 const groups:PageGroup[]=[]
 for(const item of data.stories){
  const value=item as {sequence?:unknown;region?:unknown;wordRegionId?:unknown}
  if(!value||typeof value.sequence!=='number'||!Number.isSafeInteger(value.sequence)||value.sequence<=previous||value.sequence>=manifest.chunkCount||(value.region!=='header'&&value.region!=='footer')||typeof value.wordRegionId!=='string'||!/^n_[0-9a-f]{32}$/.test(value.wordRegionId))throw new Error('wordStoryIndexInvalid')
  previous=value.sequence
  const last=groups.at(-1)
  if(last?.wordRegionId===value.wordRegionId&&last.region===value.region&&last.sequences.at(-1)===value.sequence-1)last.sequences.push(value.sequence)
  else groups.push({firstSequence:value.sequence,region:value.region,sequences:[value.sequence],wordRegionsVerified:true,wordRegionId:value.wordRegionId})
 }
 return groups
}
