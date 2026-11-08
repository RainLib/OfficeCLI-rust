import type {Node as PmNode} from '@tiptap/pm/model'
import type {WordRegionStore} from './wordRegionStore.ts'

/** Built only from an authenticated, verified canonical projection. An ID
 * shared by different regions is deliberately unusable as a provenance. */
export function wordCanonicalSources(model:WordRegionStore){
 const blocks=new Map<string,string|null>(),texts=new Map<string,string|null>()
 const add=(map:Map<string,string|null>,id:unknown,region:string)=>{
  if(typeof id!=='string'||!id)return
  if(map.has(id)&&map.get(id)!==region)map.set(id,null);else if(!map.has(id))map.set(id,region)
 }
 const visit=(node:PmNode,region:string)=>{
  if(typeof node.attrs.hcdBlockId==='string'&&node.attrs.hcdBlockId.startsWith('n_'))add(blocks,node.attrs.hcdBlockId,region)
  add(texts,node.attrs.hcdSourceId,region)
  for(const mark of node.marks)if(mark.type.name==='hcdSource')add(texts,mark.attrs.nodeId,region)
 }
 for(const region of model.capture().regions)for(const block of model.region(region.regionId)){visit(block.node,region.regionId);block.node.descendants(node=>visit(node,region.regionId))}
 return{block:(id:string)=>blocks.get(id)??undefined,text:(id:string)=>texts.get(id)??undefined}
}
