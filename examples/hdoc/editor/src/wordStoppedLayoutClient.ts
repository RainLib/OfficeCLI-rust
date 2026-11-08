import type {Session} from './api.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {negotiationURL} from './protocolClient.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {readWordLayout,type WordLayout} from './wordRegions.ts'
import type {WordPageSetupSubmit} from './WordPageSetup.tsx'
import type {StoppedLayoutAction} from './wordLayoutAttempt.ts'

type Snapshot={revision:number;layoutHash:string;reviewHash:string;layout:WordLayout}
function valid(session:Session){return session.scope==='write'&&!!session.userId&&session.collaborationProtocol===wordLayoutProtocol&&Number.isSafeInteger(session.collaborationEpoch)&&(session.collaborationEpoch??-1)>=0}
async function call(session:Session,body:unknown,signal:AbortSignal){
 if(!valid(session))throw Error('word-layout-unavailable')
 const timeout=AbortSignal.any([signal,AbortSignal.timeout(45_000)])
 const response=await awaitRecoveryResponse(()=>fetch(negotiationURL(session).replace(/\/negotiate$/,'/word-stopped-layout'),{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify(body),signal:timeout}),timeout)
 if(!response.ok)throw Error('word-layout-unavailable')
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,16*1024*1024,timeout,'word-layout-response-limit')))
}
export async function inspectStoppedLayout(session:Session,signal:AbortSignal):Promise<Snapshot>{
 const value=await call(session,{operation:'inspect',epoch:session.collaborationEpoch},signal)
 if(!value||Object.keys(value).sort().join(',')!=='layout,layoutHash,reviewHash,revision'||!Number.isSafeInteger(value.revision)||value.revision<0||!/^[a-f0-9]{64}$/.test(value.reviewHash)||!/^[a-f0-9]{64}$/.test(value.layoutHash))throw Error('word-layout-invalid')
 return{revision:value.revision,layoutHash:value.layoutHash,reviewHash:value.reviewHash,layout:readWordLayout({revision:value.revision,layoutHash:value.layoutHash,layout:value.layout},value.revision,2)}
}
/** An ambiguous failure must be checked by the topology recovery panel; no
 * automatic retry may create a new transaction identity. */
export async function sendStoppedLayout(session:Session,body:StoppedLayoutAction['body'],signal:AbortSignal){
 signal.throwIfAborted();if(body.epoch!==session.collaborationEpoch)throw Error('word-layout-stale')
 const result=await call(session,body,signal)
 if(!result||Object.keys(result).sort().join(',')!=='revision,transactionId'||result.transactionId!==body.transactionId||result.revision!==body.revision+1)throw Error('word-layout-invalid')
 signal.throwIfAborted();return result as {revision:number;transactionId:string}
}
export function stoppedLayoutSubmit(session:Session,snapshot:Snapshot,signal:AbortSignal,onStart:(action:StoppedLayoutAction)=>Promise<void>,onSuccess:(id:string)=>Promise<void>):WordPageSetupSubmit{
 return async({revision,intent})=>{
  if(!valid(session)||revision!==snapshot.revision||intent.baseLayoutHash!==snapshot.layoutHash)throw Error('word-layout-stale')
  signal.throwIfAborted();const transactionId=crypto.randomUUID().replaceAll('-',''),targets=new Set(intent.changes.map(c=>c.sectionId)),action:StoppedLayoutAction={kind:'layout',sections:snapshot.layout.sections.flatMap((s,i)=>targets.has(s.id)?[{id:s.id,number:i+1}]:[]),body:{operation:'apply',epoch:session.collaborationEpoch!,revision,reviewHash:snapshot.reviewHash,transactionId,edits:structuredClone(intent)}}
  await onStart(action);signal.throwIfAborted()
  const result=await sendStoppedLayout(session,action.body,signal)
  await onSuccess(transactionId);signal.throwIfAborted();return{revision:result.revision}
 }
}
