/** Build a staged, in-memory proposal for non-overlapping regional edits.
 * This does not publish a journal, authorize an actor or submit a checkpoint. */
import * as Y from 'yjs'
import {WordRegionStore,wordRegionStoreField} from './wordRegionStore.ts'
import {checkpointContents} from './checkpointSnapshot.ts'
import {planWordStaleMerge} from './wordStaleMergePlan.ts'
import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import type {SnapshotBlock} from './checkpointSnapshot.ts'
import {semanticBlockFields} from './semanticBlockStore.ts'
import {textFlowFields} from './semanticTextFlow.ts'

const projectedFields=new Set([wordRegionStoreField,'hcdSchema',...Object.values(semanticBlockFields),...Object.values(textFlowFields)])
/** A fresh head-based Y.Doc cannot silently discard other shared maps. */
export function hasUnprojectedWordState(document:Y.Doc){
 const schema=document.getMap('hcdSchema');for(const [key,value]of schema)if(!['typography','sourceIdentity'].includes(key)||value!==(key==='typography'?2:1))return true
 for(const [key,value]of document.share){if(projectedFields.has(key))continue;if(value instanceof Y.Map?value.size>0:value instanceof Y.Array||value instanceof Y.Text||value instanceof Y.XmlFragment?value.length>0:true)return true}
 return false
}

const ordered=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
/** Only identical inline segmentation and content is sufficient to map source
 * IDs. Split/merged runs and mixed attribution remain an explicit conflict. */
function rebindSourceMarks(node:PmNode,base:SnapshotBlock,current:SnapshotBlock){
 const old=base.content.inlines,latest=current.content.inlines,mapping=new Map<string,string>(),reverse=new Map<string,string>()
 if(old.length!==latest.length)throw Error('word-stale-source-ambiguous')
 for(let i=0;i<old.length;i++){
  const {nodeId:from,...before}=old[i],{nodeId:to,...after}=latest[i]
  if(ordered(before)!==ordered(after)||!!from!==!!to)throw Error('word-stale-source-ambiguous')
  if(from&&to){if(mapping.has(from)&&mapping.get(from)!==to||reverse.has(to)&&reverse.get(to)!==from)throw Error('word-stale-source-ambiguous');mapping.set(from,to);reverse.set(to,from)}
 }
 const children:PmNode[]=[];node.forEach(child=>{if(!child.isText&&child.type.name!=='hardBreak')throw Error('word-stale-source-ambiguous');const marks=child.marks.map(mark=>{if(mark.type.name!=='hcdSource')return mark;const target=mapping.get(mark.attrs.nodeId);if(!target)throw Error('word-stale-source-ambiguous');return mark.type.create({...mark.attrs,nodeId:target})});children.push(child.mark(marks))})
 return Fragment.fromArray(children)
}

export function buildWordStaleCandidate(base:WordRegionStore,draft:WordRegionStore,current:WordRegionStore,unverifiedObjects:boolean){
 if([base,draft,current].some(model=>hasUnprojectedWordState(model.document)))throw Error('word-stale-unprojected-state')
 const old=base.capture(),mine=draft.capture(),head=current.capture(),plan=planWordStaleMerge({baseLayoutHash:old.layoutHash,currentLayoutHash:head.layoutHash,base:old.regions,draft:mine.regions,current:head.regions,unverifiedObjects})
 if(plan.status!=='review')throw Error(plan.status==='conflict'?'word-stale-conflict':'word-stale-unsupported')
 if(base.documentId!==draft.documentId||base.documentId!==current.documentId||draft.layoutState().layoutHash!==old.layoutHash)throw Error('word-stale-scope')
 const document=new Y.Doc()
 try{
  Y.applyUpdate(document,Y.encodeStateAsUpdate(current.document));const state=current.layoutState(),candidate=new WordRegionStore(document,current.schema,current.documentId,state.layout,state.layoutHash),selectedByRegion=new Map<string,Set<string>>()
  for(const change of plan.changes)if(change.side==='draft'){const selected=selectedByRegion.get(change.regionId)??new Set<string>();selected.add(change.blockId);selectedByRegion.set(change.regionId,selected)}
  const localRegions=new Map(mine.regions.map(region=>[region.regionId,region])),baseRegions=new Map(old.regions.map(region=>[region.regionId,region]))
  for(const region of head.regions){
   const selected=selectedByRegion.get(region.regionId);if(!selected?.size)continue
   const before=candidate.region(region.regionId),local=draft.region(region.regionId),localCapture=localRegions.get(region.regionId)!
   const byId=new Map(localCapture.blocks.map((block,index)=>[block.blockId,local[index].node]))
   const next=before.map((entry,index)=>{
    const id=region.blocks[index].blockId;if(!id||!selected.has(id))return{key:entry.key,node:entry.node}
    const source=byId.get(id);if(!source||!source.isTextblock||!entry.node.isTextblock||source.type!==entry.node.type)throw Error('word-stale-unsupported')
    // Map only source IDs whose old/current inline carriers are identical.
    // The normal region guard still checks that the resulting IDs belong here.
    const content=rebindSourceMarks(source,baseRegions.get(region.regionId)!.blocks[index],region.blocks[index])
    return{key:entry.key,node:entry.node.type.createChecked(entry.node.attrs,content,entry.node.marks)}
   })
   candidate.reconcile(region.regionId,before,next)
  }
  const actual=candidate.capture(),draftChanges=new Set(plan.changes.filter(change=>change.side==='draft').map(change=>`${change.regionId}:${change.blockId}`))
  for(let ri=0;ri<head.regions.length;ri++)for(let bi=0;bi<head.regions[ri].blocks.length;bi++){
   const block=head.regions[ri].blocks[bi],expected=draftChanges.has(`${head.regions[ri].regionId}:${block.blockId}`)?mine.regions[ri].blocks[bi]:block,received=actual.regions[ri]?.blocks[bi]
   if(!received||received.blockId!==block.blockId||checkpointContents([received])!==checkpointContents([expected]))throw Error('word-stale-candidate-mismatch')
  }
  return{document,candidate,plan}
 }catch(error){document.destroy();throw error}
}
