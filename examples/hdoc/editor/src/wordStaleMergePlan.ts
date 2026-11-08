/** Read-only three-way planning. The result does not authorize a write: a
 * future commit must still verify native source bindings, objects, authors,
 * current head, ownership and a durable receipt. */
import {checkpointContents,type SnapshotBlock} from './checkpointSnapshot.ts'

export type MergeRegion={regionId:string;blocks:SnapshotBlock[]}
export type WordStaleMergePlan={status:'review'|'conflict'|'unsupported';reason?:'layout'|'structure'|'objects';changes:Array<{regionId:string;blockId:string;side:'draft'|'current'|'same'|'conflict'}>}

export function planWordStaleMerge(input:{baseLayoutHash:string;currentLayoutHash:string;base:MergeRegion[];draft:MergeRegion[];current:MergeRegion[];unverifiedObjects:boolean}):WordStaleMergePlan{
 if(input.baseLayoutHash!==input.currentLayoutHash)return{status:'unsupported',reason:'layout',changes:[]}
 if(input.unverifiedObjects)return{status:'unsupported',reason:'objects',changes:[]}
 const {base,draft,current}=input
 if(base.length!==draft.length||base.length!==current.length||base.some((region,index)=>!region.regionId||draft[index]?.regionId!==region.regionId||current[index]?.regionId!==region.regionId)||new Set(base.map(region=>region.regionId)).size!==base.length)return{status:'unsupported',reason:'structure',changes:[]}
 const changes:WordStaleMergePlan['changes']=[],ids=new Set<string>()
 for(let regionIndex=0;regionIndex<base.length;regionIndex++){
  const region=base[regionIndex],local=draft[regionIndex],remote=current[regionIndex]
  if(region.blocks.length!==local.blocks.length||region.blocks.length!==remote.blocks.length)return{status:'unsupported',reason:'structure',changes:[]}
  for(let index=0;index<region.blocks.length;index++){
   const original=region.blocks[index],draftBlock=local.blocks[index],currentBlock=remote.blocks[index],blockId=original.blockId
   // Never infer identity from equal text or position; moves, new/deleted
   // blocks, ID churn and duplicated IDs require a structural merge protocol.
   if(!blockId||ids.has(blockId)||draftBlock.blockId!==blockId||currentBlock.blockId!==blockId)return{status:'unsupported',reason:'structure',changes:[]}
   ids.add(blockId)
   const baseline=checkpointContents([original]),mine=checkpointContents([draftBlock]),theirs=checkpointContents([currentBlock]),mineChanged=mine!==baseline,theirsChanged=theirs!==baseline
   if(mineChanged||theirsChanged)changes.push({regionId:region.regionId,blockId,side:mineChanged&&theirsChanged?mine===theirs?'same':'conflict':mineChanged?'draft':'current'})
  }
 }
 return{status:changes.some(change=>change.side==='conflict')?'conflict':'review',changes}
}
