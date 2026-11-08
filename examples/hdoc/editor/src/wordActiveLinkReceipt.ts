/** Fixed-version confirmation after process-local status loss. Does not reload
 * the shared journal or install a historical projection into the active room. */
import {createHash} from 'node:crypto'
import type {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {wordLinkPendingHash,type WordPendingLink} from './wordLinkProof.ts'
import {verifyWordLinkReceipt} from './wordRegionStore.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
type Options={journal:WordCheckpointJournal;pending:WordPendingLink;guard:()=>void;authorize:()=>Promise<WordTopologyMember>;request:(route:string,init?:RequestInit)=>Promise<Response>}
export async function inspectActiveWordLinkReceipt({journal,pending,guard,authorize,request}:Options){
 const authority=async()=>{requireTopologyMember(await authorize(),pending.actor,pending.request.actor);guard()}
 const read=async(route:string,init?:RequestInit)=>{
  guard();const signal=AbortSignal.timeout(30000),response=await awaitRecoveryResponse(()=>request(route,{...init,signal}),signal);guard()
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error('word-active-link-receipt-unavailable')}
  const bytes=await readBoundedResponse(response,16*1024*1024,signal,'word-active-link-receipt-limit');guard();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
 }
 await authority()
 const revision=pending.request.expectedRevision+1,base=await read(`/editor?revision=${pending.request.expectedRevision}`),record=await read(`/revisions/${revision}`),probe=Uint8Array.of(0)
 const response=await read('/word/link-receipt',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'7','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Story-Version':'1','X-HCD-Word-Link-Version':'1'},body:JSON.stringify({apiHash:journal.scope.apiHash,pendingHash:wordLinkPendingHash(pending),initialUpdateHash:createHash('sha256').update(probe).digest('hex'),prepared:{coordinatorId:journal.scope.lineage,transaction:pending.request,candidateLayoutHash:pending.candidateLayoutHash,reviewHash:pending.reviewHash}})}),{projection,...receipt}=response
 if(base.revision!==pending.request.expectedRevision||base.flowLayoutHash!==pending.request.link.baseLayoutHash||projection?.revision!==revision||projection.flowLayoutHash!==pending.candidateLayoutHash||!journal.knownHashes().includes(receipt.journalHash)||!journal.verifyLinkReceipt(record,pending,receipt,receipt.journalHash,probe))throw Error('word-active-link-receipt-invalid')
 verifyWordLinkReceipt(base,projection,pending.request)
 await authority();return{transactionId:pending.request.transactionId,status:'installed' as const,revision}
}
