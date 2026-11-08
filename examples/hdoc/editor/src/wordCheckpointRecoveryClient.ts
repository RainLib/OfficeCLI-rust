import type {Session} from './api.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {negotiationURL} from './protocolClient.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'

export type WordCheckpointReview={checkpointId:string;baseRevision:number;revision:number;status:'pending'|'confirmed'|'confirmed-stale'|'rebased'|'rebased-stale'}
export class WordCheckpointClientError extends Error{constructor(readonly uncertain:boolean){super('word-checkpoint-recovery-unavailable')}}

/** Resume always sends the reviewed ID. A transport or response failure after
 * dispatch is uncertain even when an HTTP error arrives after native commit. */
export async function wordCheckpointRecovery(session:Session,operation:'inspect'|'resume',signal:AbortSignal,checkpointId?:string):Promise<WordCheckpointReview>{
 if(session.collaborationProtocol!==wordLayoutProtocol||session.scope!=='write'||!session.userId||!Number.isSafeInteger(session.collaborationEpoch)||(session.collaborationEpoch??-1)<0||operation==='resume'&&!/^[a-f0-9]{32}$/.test(checkpointId??'')||operation==='inspect'&&checkpointId!==undefined)throw new WordCheckpointClientError(false)
 signal.throwIfAborted();const timeout=AbortSignal.any([signal,AbortSignal.timeout(45_000)]),mutating=operation==='resume'
 try{
  const response=await awaitRecoveryResponse(()=>fetch(negotiationURL(session).replace(/\/negotiate$/,'/word-checkpoint-recovery'),{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify({operation,epoch:session.collaborationEpoch,...(checkpointId?{checkpointId}:{})}),signal:timeout}),timeout)
  if(!response.ok)throw new Error('word-checkpoint-request-failed')
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,4096,timeout,'word-checkpoint-response-limit'))) as WordCheckpointReview
  if(!value||Object.keys(value).sort().join(',')!=='baseRevision,checkpointId,revision,status'||!/^[a-f0-9]{32}$/.test(value.checkpointId)||checkpointId!==undefined&&value.checkpointId!==checkpointId||!Number.isSafeInteger(value.baseRevision)||value.baseRevision<0||!Number.isSafeInteger(value.revision)||value.revision<value.baseRevision||!['pending','confirmed','confirmed-stale','rebased','rebased-stale'].includes(value.status)||operation==='resume'&&value.status==='pending'||value.status==='pending'&&value.revision!==value.baseRevision||['confirmed','confirmed-stale'].includes(value.status)&&value.revision>value.baseRevision+1||['rebased','rebased-stale'].includes(value.status)&&value.revision<=value.baseRevision)throw new Error('word-checkpoint-response-invalid')
  timeout.throwIfAborted();return value
 }catch(error){if(signal.aborted)throw signal.reason;throw new WordCheckpointClientError(mutating)}
}
