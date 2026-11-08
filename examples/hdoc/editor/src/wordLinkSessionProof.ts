/** Browser-only immutable link proof. Unlike a newly created story, a link
 * has no nonce-derived destination ID: verify its native record and request
 * digest before allowing the retained local view to adopt that topology. */
import {sameWordSessionTopology,verifyWordLinkReceipt,type WordRegionProjection,type WordRegionStore} from './wordRegionStore.ts'
import {wordLinkRequestIdentity,type WordLinkTransaction} from './wordLinkPlan.ts'
import {validContributor} from './referenceAuthors.ts'
export type WordLinkSessionProof=Readonly<{transactionId:string;baseRevision:number;revision:number}>
type Data={base:WordRegionProjection;receipt:WordRegionProjection}
const proofs=new WeakMap<WordLinkSessionProof,Data>()
export async function prepareWordLinkSessionProof(transactionId:string,before:WordRegionProjection,after:WordRegionProjection,input:unknown):Promise<WordLinkSessionProof>{
 const base=structuredClone(before),receipt=structuredClone(after),record=structuredClone(input) as any
 const fail=()=>{throw Error('word-session-link-proof-invalid')}
 if(!/^[a-f0-9]{32}$/.test(transactionId)||!base||!receipt||!record||base.documentId!==receipt.documentId||!Number.isSafeInteger(base.revision)||base.revision<0||receipt.revision!==base.revision+1||record.documentId!==base.documentId||record.revision!==receipt.revision||record.parentRevision!==base.revision||record.patchBaseRevision!==base.revision||record.patchId!==`word-story-link-${transactionId}`||!validContributor({userId:record.authorId,displayName:record.authorName,generation:1})||record.structuralChange!==true||record.wordLayoutChange!==true||record.layoutUpgrade===true||!/^[a-f0-9]{64}$/.test(record.rootHash??'')||!/^[a-f0-9]{64}$/.test(record.patchHash??''))fail()
 const beforeLayout=base.flowLayout,afterLayout=receipt.flowLayout,changes:WordLinkTransaction['link'][]=[]
 if(!beforeLayout||!afterLayout||beforeLayout.sections.length!==afterLayout.sections.length||beforeLayout.stories.length!==afterLayout.stories.length)fail()
 for(let index=0;index<beforeLayout.sections.length;index++)for(const kind of ['header','footer'] as const)for(const variant of ['default','first','even'] as const){
  const bindings=kind==='header'?'headers':'footers',old=beforeLayout.sections[index][bindings][variant],next=afterLayout.sections[index][bindings][variant]
  if(old===next)continue
  if(old===undefined||next!==undefined)fail()
  changes.push({baseLayoutHash:base.flowLayoutHash,sectionId:beforeLayout.sections[index].id,kind,variant,expectedDirectStoryId:old!})
 }
 if(changes.length!==1)fail()
 const request:WordLinkTransaction={schemaVersion:'hcd-word-story-link/1',documentId:base.documentId,transactionId,expectedRevision:base.revision,actor:{userId:record.authorId,displayName:record.authorName},link:changes[0]}
 verifyWordLinkReceipt(base,receipt,request)
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(wordLinkRequestIdentity(request)))),value=>value.toString(16).padStart(2,'0')).join('')
 if(digest!==record.patchHash)fail()
 const proof=Object.freeze({transactionId,baseRevision:base.revision,revision:receipt.revision});proofs.set(proof,{base,receipt});return proof
}
/** Minted proofs retain private copies of the verified projections. A plain
 * JSON token, changed source topology or a different live destination fails
 * before the old transport or editor views are detached. */
export function verifyWordLinkSessionProof(view:WordRegionStore,wire:WordRegionStore,proof:WordLinkSessionProof){
 const data=proofs.get(proof)
 if(!data||view.documentId!==data.base.documentId||wire.documentId!==data.receipt.documentId||!sameWordSessionTopology(view.layoutState().layout,data.base.flowLayout)||!sameWordSessionTopology(wire.layoutState().layout,data.receipt.flowLayout))throw Error('word-session-link-proof-invalid')
}
