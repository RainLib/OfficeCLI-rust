/** Verify a committed native story after a process-local status cache loss.
 * The active journal is never reloaded, promoted or otherwise mutated here. */
import {createHash} from 'node:crypto'
import {wordStoryPendingHash,type WordCheckpointJournal,type WordPendingStory} from './wordCheckpointJournal.ts'
import {verifyWordStoryReceipt} from './wordRegionStore.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import {readBoundedResponse} from './boundedResponse.ts'
type Options={journal:WordCheckpointJournal;pending:WordPendingStory;guard:()=>void;authorize:()=>Promise<WordTopologyMember>;request:(route:string,init?:RequestInit)=>Promise<Response>}
export async function inspectActiveWordStoryReceipt({journal,pending,guard,authorize,request}:Options){
 const authority=async()=>{requireTopologyMember(await authorize(),pending.actor,pending.request.actor);guard()}
 const read=async(route:string,init?:RequestInit)=>{guard();const response=await request(route,init);guard();if(!response.ok)throw Error('word-active-story-receipt-unavailable');const bytes=await readBoundedResponse(response,16*1024*1024,AbortSignal.timeout(30000),'word-active-story-receipt-limit');guard();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
 await authority()
 const revision=pending.request.expectedRevision+1,base=await read(`/editor?revision=${pending.request.expectedRevision}`),record=await read(`/revisions/${revision}`),probe=Uint8Array.of(0)
 const response=await read('/word/story-receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiHash:journal.scope.apiHash,coordinatorId:journal.scope.lineage,pendingHash:wordStoryPendingHash(pending),initialUpdateHash:createHash('sha256').update(probe).digest('hex'),request:pending.request})}),{projection,...receipt}=response
 if(base.revision!==pending.request.expectedRevision||base.flowLayoutHash!==pending.request.baseLayoutHash||projection?.revision!==revision||projection.flowLayoutHash!==receipt.layoutHash||!journal.knownHashes().includes(receipt.journalHash)||!journal.verifyStoryReceipt(record,pending,receipt,receipt.journalHash,probe))throw Error('word-active-story-receipt-invalid')
 verifyWordStoryReceipt(base,projection,pending.intent,pending.blocks)
 await authority();return{transactionId:pending.request.transactionId,status:'installed' as const,revision}
}
