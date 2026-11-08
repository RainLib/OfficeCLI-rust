/** A story session may advance only across the exact immutable native copy
 * named by the installed round. This proof never authorizes a native write. */
import {sameWordSessionTopology,verifyWordStoryReceipt,type WordRegionProjection,type WordRegionStore} from './wordRegionStore.ts'
import type {WordStoryUnlinkIntent} from './wordLayoutTransition.ts'

export type WordStorySessionProof={transactionId:string;base:WordRegionProjection;receipt:WordRegionProjection}
export function verifyWordStorySessionProof(view:WordRegionStore,wire:WordRegionStore,proof:WordStorySessionProof){
 const {base,receipt,transactionId}=proof,before=base.flowLayout,after=receipt.flowLayout
 if(!/^[a-f0-9]{32}$/.test(transactionId)||base.documentId!==view.documentId||receipt.documentId!==wire.documentId||!sameWordSessionTopology(view.layoutState().layout,before)||!sameWordSessionTopology(wire.layoutState().layout,after)||after.stories.length!==before.stories.length+1||before.sections.length!==after.sections.length)throw Error('word-session-story-proof-invalid')
 const story=after.stories.at(-1)!
 if(story.id!==`n_${transactionId}`||story.sourcePart!==`word/hcd-${transactionId}.xml`)throw Error('word-session-story-proof-invalid')
 const changes:WordStoryUnlinkIntent[]=[]
 for(let index=0;index<before.sections.length;index++)for(const kind of ['header','footer'] as const)for(const variant of ['default','first','even'] as const){
  const bindings=kind==='header'?'headers':'footers',old=before.sections[index][bindings][variant],next=after.sections[index][bindings][variant]
  if(old===next)continue
  if(old!==undefined||next!==story.id||kind!==story.kind)throw Error('word-session-story-proof-invalid')
  let inherited:string|null=null
  for(let previous=index-1;previous>=0;previous--){const value=before.sections[previous][bindings][variant];if(value!==undefined){inherited=value;break}}
  changes.push({sectionId:before.sections[index].id,kind,variant,expectedInheritedStoryId:inherited})
 }
 if(changes.length!==1)throw Error('word-session-story-proof-invalid')
 // Both projections are fetched through authenticated, revision-pinned native
 // reads. The shared receipt validator also checks unchanged original blocks,
 // comments, revisions, all bindings and the appended region's identities.
 verifyWordStoryReceipt(base,receipt,changes[0],receipt.blocks.slice(base.blocks.length))
}
