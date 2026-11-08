import type {SharedImageDraft} from './collaborativeImages.ts'
import {sameGeometry} from './imageDrafts.ts'

type Field=SharedImageDraft['touched'][number]
export type RecoveryPeerComparison={intentId:string;status:'sameIntent'|'compatible'|'conflict'|'unverified';conflicts:Field[]}
const value=(draft:SharedImageDraft,field:Field)=>field==='assetHash'?draft.assetHash??draft.base.assetHash??null:draft.geometry[field]

/** Compare only live intents for the same object. A different baseline cannot
 * establish compatibility; it must be reconciled against canonical history. */
export function compareRecoveryImagePeers(draft:SharedImageDraft,current:readonly SharedImageDraft[]):RecoveryPeerComparison[]{
 return current.filter(peer=>peer.base.nodeId===draft.base.nodeId).map(peer=>{
  if(peer.intentId===draft.intentId){
   const identical=JSON.stringify(peer)===JSON.stringify(draft)
   return {intentId:peer.intentId,status:identical?'sameIntent':'unverified',conflicts:[]}
  }
  if(peer.base.visualHash!==draft.base.visualHash||(peer.base.assetHash??null)!==(draft.base.assetHash??null)||!sameGeometry(peer.base.geometry,draft.base.geometry))return {intentId:peer.intentId,status:'unverified',conflicts:[]}
  const conflicts=draft.touched.filter(field=>peer.touched.includes(field)&&!Object.is(value(draft,field),value(peer,field)))
  return {intentId:peer.intentId,status:conflicts.length?'conflict':'compatible',conflicts}
 })
}
