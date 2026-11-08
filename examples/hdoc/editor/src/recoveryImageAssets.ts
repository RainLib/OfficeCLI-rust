import type {SharedImageDraft} from './collaborativeImages.ts'

/** Only offer bytes actually included in this packet, without duplicating an
 * identical baseline and replacement. Neither choice applies an image edit. */
export function recoveryImageAssets(draft:SharedImageDraft,resources:ReadonlyMap<string,Uint8Array>){
 const result:Array<{kind:'original'|'replacement';hash:string;bytes:Uint8Array}>=[]
 for(const [kind,hash] of [['original',draft.base.assetHash],['replacement',draft.assetHash]] as const){
  if(!hash||result.some(entry=>entry.hash===hash))continue
  const bytes=resources.get(hash);if(bytes)result.push({kind,hash,bytes})
 }
 return result
}
