import type {Session} from './api.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {negotiationURL} from './protocolClient.ts'
import {wordBrowserHeaders} from './wordBrowserProtocol.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import type {WordActiveLayoutStatus} from './wordActiveLayout.ts'
import type {WordActiveLinkStatus} from './wordActiveLink.ts'
import type {WordActiveStoryStatus} from './wordActiveStory.ts'

/** A read-only round lookup. Missing state requires signed recovery; it never
 * means the page operation can be discarded or retried with a new identity. */
export async function readWordActiveLayoutStatus(session:Session,transactionId:string,cancellation:AbortSignal):Promise<WordActiveLayoutStatus>{
 return readActiveStatus(session,transactionId,cancellation,'layout') as Promise<WordActiveLayoutStatus>
}
export async function readWordActiveTopologyStatus(session:Session,transactionId:string,cancellation:AbortSignal):Promise<WordActiveLayoutStatus|WordActiveStoryStatus|WordActiveLinkStatus>{
 const page=await readWordActiveLayoutStatus(session,transactionId,cancellation)
 // Absence is not proof that nothing committed. Only an explicit cache miss
 // permits looking for the same identity in the independent story engine.
 if(page.status!=='recovery-required')return page
 const story=await readActiveStatus(session,transactionId,cancellation,'story')
 return story.status==='recovery-required'?readActiveStatus(session,transactionId,cancellation,'link'):story
}
async function readActiveStatus(session:Session,transactionId:string,cancellation:AbortSignal,kind:'layout'|'story'|'link'):Promise<WordActiveLayoutStatus|WordActiveStoryStatus|WordActiveLinkStatus>{
 if(!['read','write'].includes(session.scope)||session.collaborationProtocol!==wordLayoutProtocol||!Number.isSafeInteger(session.collaborationEpoch)||session.collaborationEpoch!<0||!/^[a-f0-9]{32}$/.test(transactionId))throw Error('word-active-layout-status-invalid')
 const signal=AbortSignal.any([cancellation,AbortSignal.timeout(30_000)]);signal.throwIfAborted()
 const response=await awaitRecoveryResponse(()=>fetch(negotiationURL(session).replace(/\/negotiate$/,`/word-active-${kind}-status`),{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json',...wordBrowserHeaders(session),...(kind==='story'?{'X-HCD-Word-Story-Version':'1'}:kind==='link'?{'X-HCD-Word-Link-Version':'1'}:{})},body:JSON.stringify({epoch:session.collaborationEpoch,transactionId}),redirect:'error',signal}),signal)
 if(!response.ok)throw Error('word-active-layout-status-unavailable')
 const bytes=await readBoundedResponse(response,16*1024,signal,'word-active-layout-status-limit')
 let value:WordActiveLayoutStatus|WordActiveStoryStatus|WordActiveLinkStatus
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw Error('word-active-layout-status-invalid')}
 if(!value||Object.keys(value).sort().join(',')!==(value.status==='installed'?'documentId,epoch,revision,schemaVersion,status,transactionId':'documentId,epoch,schemaVersion,status,transactionId')||value.schemaVersion!==`hcd-word-active-${kind}-status/1`||value.documentId!==session.documentId||value.epoch!==session.collaborationEpoch||value.transactionId!==transactionId||!['pending','installed','cancelled','recovery-required'].includes(value.status)||value.status==='installed'&&(!Number.isSafeInteger(value.revision)||value.revision<0))throw Error('word-active-layout-status-invalid')
 signal.throwIfAborted();return value
}
