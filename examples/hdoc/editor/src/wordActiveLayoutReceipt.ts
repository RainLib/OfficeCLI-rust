/** Re-check an exact native immutable receipt after process-local cache loss.
 * Does not promote a journal, install a room or apply any document change. */
import type {WordCheckpointJournal,WordLayoutPending} from './wordCheckpointJournal.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import {readBoundedResponse} from './boundedResponse.ts'
type Options={journal:WordCheckpointJournal;pending:WordLayoutPending;guard:()=>void;authorize:()=>Promise<WordTopologyMember>;request:(route:string,init?:RequestInit)=>Promise<Response>}
export async function inspectActiveWordLayoutReceipt(options:Options){
 const {journal,pending,guard}=options
 const authorize=async()=>{requireTopologyMember(await options.authorize(),pending.actor,pending.request.actor);guard()}
 const read=async(route:string,init?:RequestInit)=>{guard();const response=await options.request(route,init);guard();if(!response.ok)throw Error('word-active-layout-receipt-unavailable');const bytes=await readBoundedResponse(response,16*1024*1024,AbortSignal.timeout(30000),'word-active-layout-receipt-limit');guard();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
 // The active owner already loaded and verified this shared journal. Reloading
 // it changes its generation and can invalidate an in-flight coordinator save.
 await authorize();guard()
 const revision=pending.request.expectedRevision+1,record=await read(`/revisions/${revision}`),response=await read('/word/layout-receipt',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'7','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Story-Version':'1'},body:JSON.stringify({coordinatorId:journal.scope.lineage,transaction:pending.request})}),{projection:_projection,...receipt}=response
 if(typeof receipt.journalHash!=='string'||!journal.knownHashes().includes(receipt.journalHash)||!journal.verifyLayoutReceipt(record,pending.request,receipt,receipt.journalHash))throw Error('word-active-layout-receipt-invalid')
 await authorize();return{transactionId:pending.request.transactionId,status:'installed' as const,revision}
}
