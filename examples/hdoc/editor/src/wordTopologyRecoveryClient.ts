import type {Session} from './api.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {negotiationURL} from './protocolClient.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {WordCheckpointClientError} from './wordCheckpointRecoveryClient.ts'
export type WordTopologyReview={transactionId:string;baseRevision:number;revision:number}&({kind:'layout'|'story';status:'pending'|'confirmed';headRevision?:never}|{kind:'link';status:'pending'|'confirmed'|'historical';headRevision:number})
export const topologyFields=['widthTwips','heightTwips','orientation','marginTop','marginRight','marginBottom','marginLeft','marginHeader','marginFooter','marginGutter','numberStart','numberFormat','differentFirstPage','evenAndOddHeaders'] as const
export type WordTopologyChangeData={section:number|null;field:string;before:string|number|boolean|null;after:string|number|boolean|null}|{section:number;kind:'header'|'footer';variant:'default'|'first'|'even';inherited:boolean;blockCount:number}|import('./wordLinkRecoveryDetails.ts').WordLinkRecoveryChange
export type WordTopologyDetails={transactionId:string;kind:'layout'|'story'|'link';offset:number;total:number;changes:Array<WordTopologyChangeData>}
export async function wordTopologyRecovery(session:Session,operation:'inspect'|'resume',signal:AbortSignal,transactionId?:string):Promise<WordTopologyReview>{
 if(session.collaborationProtocol!==wordLayoutProtocol||session.scope!=='write'||!session.userId||!Number.isSafeInteger(session.collaborationEpoch)||(session.collaborationEpoch??-1)<0||operation==='resume'&&!/^[a-f0-9]{32}$/.test(transactionId??'')||operation==='inspect'&&transactionId!==undefined)throw new WordCheckpointClientError(false)
 signal.throwIfAborted();const timeout=AbortSignal.any([signal,AbortSignal.timeout(45_000)])
 try{
  const response=await awaitRecoveryResponse(()=>fetch(negotiationURL(session).replace(/\/negotiate$/,'/word-topology-recovery'),{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Link-Version':'1'},body:JSON.stringify({operation,epoch:session.collaborationEpoch,...(transactionId?{transactionId}:{})}),signal:timeout}),timeout)
  if(!response.ok)throw new Error('word-topology-request-failed')
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,4096,timeout,'word-topology-response-limit'))) as WordTopologyReview
  if(!value||Object.keys(value).sort().join(',')!==(value.kind==='link'?'baseRevision,headRevision,kind,revision,status,transactionId':'baseRevision,kind,revision,status,transactionId')||!/^[a-f0-9]{32}$/.test(value.transactionId)||transactionId!==undefined&&value.transactionId!==transactionId||!['layout','story','link'].includes(value.kind)||!Number.isSafeInteger(value.baseRevision)||value.baseRevision<0||!Number.isSafeInteger(value.revision)||value.revision<value.baseRevision||value.revision>value.baseRevision+1||!['pending','confirmed',...(value.kind==='link'?['historical']:[])].includes(value.status)||operation==='resume'&&!['confirmed','historical'].includes(value.status)||['confirmed','historical'].includes(value.status)&&value.revision!==value.baseRevision+1||value.kind==='link'&&(!Number.isSafeInteger(value.headRevision)||value.headRevision<value.revision||value.status==='confirmed'&&value.headRevision!==value.revision||value.status==='historical'&&value.headRevision<=value.revision))throw new Error('word-topology-response-invalid')
  timeout.throwIfAborted();return value
 }catch(error){if(signal.aborted)throw signal.reason;throw new WordCheckpointClientError(operation==='resume')}
}
/** Read a bounded page of the exact signed request; no document is changed. */
export async function wordTopologyDetails(session:Session,review:WordTopologyReview,offset:number,signal:AbortSignal):Promise<WordTopologyDetails>{
 if(session.collaborationProtocol!==wordLayoutProtocol||session.scope!=='write'||!session.userId||!Number.isSafeInteger(session.collaborationEpoch)||(session.collaborationEpoch??-1)<0||!/^[a-f0-9]{32}$/.test(review.transactionId)||!Number.isSafeInteger(offset)||offset<0||offset%20!==0)throw new WordCheckpointClientError(false)
 signal.throwIfAborted();const timeout=AbortSignal.any([signal,AbortSignal.timeout(45_000)])
 try{
  const response=await awaitRecoveryResponse(()=>fetch(negotiationURL(session).replace(/\/negotiate$/,'/word-topology-recovery'),{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Link-Version':'1'},body:JSON.stringify({operation:'details',epoch:session.collaborationEpoch,transactionId:review.transactionId,offset}),signal:timeout}),timeout)
  if(!response.ok)throw new Error('word-topology-details-failed')
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,16*1024,timeout,'word-topology-response-limit'))) as WordTopologyDetails
  const scalar=(item:unknown)=>item===null||typeof item==='boolean'||typeof item==='number'&&Number.isSafeInteger(item)||typeof item==='string'&&item.length<=64
  if(!value||Object.keys(value).sort().join(',')!=='changes,kind,offset,total,transactionId'||value.transactionId!==review.transactionId||value.kind!==review.kind||value.offset!==offset||!Number.isSafeInteger(value.total)||value.total<1||value.total>(value.kind==='link'?4096:1024)||offset>=value.total||!Array.isArray(value.changes)||value.changes.length!==Math.min(20,value.total-offset))throw Error('word-topology-response-invalid')
  for(const change of value.changes){
   const region=(item:any)=>Number.isSafeInteger(item.section)&&item.section>=1&&['header','footer'].includes(item.kind)&&['default','first','even'].includes(item.variant)
   if(!change||typeof change!=='object')throw Error('word-topology-response-invalid')
   if(value.kind==='layout'){
    if(Object.keys(change).sort().join(',')!=='after,before,field,section'||!('field'in change)||change.section!==null&&(!Number.isSafeInteger(change.section)||change.section<1)||!topologyFields.includes(change.field as typeof topologyFields[number])||!scalar(change.before)||!scalar(change.after))throw Error('word-topology-response-invalid')
   }else if(value.kind==='link'){
    if(Object.keys(change).sort().join(',')!=='contentChanged,kind,operation,retained,section,sourceSection,variant'||!('operation'in change)||change.operation!=='link'||!region(change)||change.retained!==true||typeof change.contentChanged!=='boolean'||change.sourceSection!==null&&(!Number.isSafeInteger(change.sourceSection)||change.sourceSection<1||change.sourceSection>=change.section))throw Error('word-topology-response-invalid')
   }else if(Object.keys(change).sort().join(',')!=='blockCount,inherited,kind,section,variant'||!('inherited'in change)||!region(change)||typeof change.inherited!=='boolean'||!Number.isSafeInteger(change.blockCount)||change.blockCount<1||change.blockCount>10000)throw Error('word-topology-response-invalid')
  }
  timeout.throwIfAborted();return value
 }catch(error){if(signal.aborted)throw signal.reason;throw new WordCheckpointClientError(false)}
}
/** Atomically seal an exact identity only if it has never been prepared.
 * A late request with the same identity is then rejected by the coordinator. */
export async function cancelUnpreparedTopology(session:Session,transactionId:string,signal:AbortSignal){
 if(session.collaborationProtocol!==wordLayoutProtocol||session.scope!=='write'||!session.userId||!Number.isSafeInteger(session.collaborationEpoch)||(session.collaborationEpoch??-1)<0||!/^[a-f0-9]{32}$/.test(transactionId))throw new WordCheckpointClientError(false)
 signal.throwIfAborted();const timeout=AbortSignal.any([signal,AbortSignal.timeout(45_000)])
 try{
  const response=await awaitRecoveryResponse(()=>fetch(negotiationURL(session).replace(/\/negotiate$/,'/word-topology-cancel'),{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Link-Version':'1'},body:JSON.stringify({epoch:session.collaborationEpoch,transactionId}),signal:timeout}),timeout)
  if(!response.ok)throw Error('word-topology-cancel-failed')
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,4096,timeout,'word-topology-response-limit')))
  if(!value||Object.keys(value).sort().join(',')!=='status,transactionId'||value.transactionId!==transactionId||value.status!=='not-prepared')throw Error('word-topology-response-invalid')
  timeout.throwIfAborted();return value as {transactionId:string;status:'not-prepared'}
 }catch(error){if(signal.aborted)throw signal.reason;throw new WordCheckpointClientError(false)}
}
