import type {Session} from './api.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {negotiationURL} from './protocolClient.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import type {StoppedStoryAction} from './wordLayoutAttempt.ts'
export type StorySelection={sectionId:string;kind:'header'|'footer';variant:'default'|'first'|'even';transactionId:string}
export type StoryReview={revision:number;reviewHash:string;transactionId:string;section:number;kind:StorySelection['kind'];variant:StorySelection['variant'];inherited:boolean;affectedSections:number;blockCount:number}
async function call(session:Session,body:object,signal:AbortSignal){
 if(session.scope!=='write'||!session.userId||session.collaborationProtocol!==wordLayoutProtocol||!Number.isSafeInteger(session.collaborationEpoch))throw Error('word-story-unavailable')
 const timeout=AbortSignal.any([signal,AbortSignal.timeout(45_000)])
 const response=await awaitRecoveryResponse(()=>fetch(negotiationURL(session).replace(/\/negotiate$/,'/word-stopped-story'),{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify({epoch:session.collaborationEpoch,...body}),signal:timeout}),timeout)
 if(!response.ok){
  let code='';try{const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,4096,timeout,'word-story-error-limit')));if(['word-story-source-draft-pending','word-story-source-unsupported'].includes(body?.code))code=body.code}catch{/* Keep the generic error for untrusted or unavailable responses. */}
  throw Error(code||'word-story-unavailable')
 }
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,8192,timeout,'word-story-response-limit')))
}
export async function previewStoppedStory(session:Session,selection:StorySelection,signal:AbortSignal):Promise<StoryReview>{
 const value=await call(session,{operation:'preview',...selection},signal)
 if(!value||Object.keys(value).sort().join(',')!=='affectedSections,blockCount,inherited,kind,reviewHash,revision,section,transactionId,variant'||value.transactionId!==selection.transactionId||value.kind!==selection.kind||value.variant!==selection.variant||!/^[a-f0-9]{64}$/.test(value.reviewHash)||!Number.isSafeInteger(value.revision)||value.revision<0||!Number.isSafeInteger(value.section)||value.section<1||typeof value.inherited!=='boolean'||!Number.isSafeInteger(value.affectedSections)||value.affectedSections<1||!Number.isSafeInteger(value.blockCount)||value.blockCount<1)throw Error('word-story-invalid')
 return value
}
export async function sendStoppedStory(session:Session,action:StoppedStoryAction,signal:AbortSignal){
 signal.throwIfAborted();if(action.body.epoch!==session.collaborationEpoch)throw Error('word-story-stale')
 const result=await call(session,action.body,signal)
 if(!result||Object.keys(result).sort().join(',')!=='revision,transactionId'||result.transactionId!==action.body.transactionId||result.revision!==action.baseRevision+1)throw Error('word-story-invalid')
 signal.throwIfAborted();return result as {revision:number;transactionId:string}
}
export async function applyStoppedStory(session:Session,selection:StorySelection,review:StoryReview,signal:AbortSignal,onStart:(action:StoppedStoryAction)=>Promise<void>){
 if(selection.transactionId!==review.transactionId||selection.kind!==review.kind||selection.variant!==review.variant)throw Error('word-story-stale')
 signal.throwIfAborted();const action:StoppedStoryAction={kind:'story',section:review.section,baseRevision:review.revision,body:{operation:'apply',epoch:session.collaborationEpoch!,...structuredClone(selection),reviewHash:review.reviewHash}}
 await onStart(action);signal.throwIfAborted();return sendStoppedStory(session,action,signal)
}
