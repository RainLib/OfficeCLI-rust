/** Server-only image scope comes from an immutable native projection, never
 * from a client page number or an intent's claimed region. The native planner
 * independently checks the source-map membership again at commit time. */
import type {WordRegionProjection} from './wordRegionStore.ts'
import type {CapturedImage} from './collaborativeImages.ts'

export type WordCapturedImage=CapturedImage&{regionId:string}
export function wordImageRegions(projection:WordRegionProjection){
 const regions=new Map<string,string>()
 for(const block of projection.blocks){
  if(!block.flowRegionId)continue
  // Native readOnlyHtml is canonical XHTML. Include mapped source attributes,
  // then require the immutable image lookup to prove that a selected ID is an
  // actual image. No rendering or HTML supplied by a client is involved.
  for(const match of (block.readOnlyHtml??'').matchAll(/\bdata-hcd-id\s*=\s*["'](n_[a-f0-9]{32})["']/g)){
   const previous=regions.get(match[1]);if(previous&&previous!==block.flowRegionId)throw new Error('word-image-scope-invalid')
   regions.set(match[1],block.flowRegionId)
  }
 }
 return regions
}
