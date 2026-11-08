import {prepareWordLinkSessionProof} from './wordLinkSessionProof.ts'
import {api,ApiError,type Session} from './api.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {negotiationURL} from './protocolClient.ts'
import {wordBrowserHeaders,wordBrowserModelMatches,requireWordBrowserProtocol} from './wordBrowserProtocol.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {readWordLayout} from './wordRegions.ts'
import type {WordRegionProjection} from './wordRegionStore.ts'

/** Immutable topology proof reads may name an older revision than the live
 * owner's baseline. The current head remains available only via that owner. */
export async function readWordStorySessionProjection(session:Session,revision:number,cancellation:AbortSignal):Promise<WordRegionProjection>{
 if(session.collaborationProtocol!==wordLayoutProtocol||!Number.isSafeInteger(revision)||revision<0)throw Error('word-browser-story-baseline')
 const signal=AbortSignal.any([cancellation,AbortSignal.timeout(30_000)]);signal.throwIfAborted()
 let response:Response
 try{response=await awaitRecoveryResponse(()=>api(session,`/editor?revision=${revision}`,{signal,headers:{'X-HCD-Flow-Layout-Version':'2'}}),signal)}
 catch(error){if(error instanceof ApiError&&error.status===426)return readWordBrowserProjection(session,revision,signal);throw error}
 const bytes=await readBoundedResponse(response,16*1024*1024,signal,'word-browser-baseline-limit'),projection=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as WordRegionProjection
 if(!projection||projection.documentId!==session.documentId||projection.revision!==revision||!Array.isArray(projection.blocks))throw Error('word-browser-baseline-invalid')
 readWordLayout({layout:projection.flowLayout,layoutHash:projection.flowLayoutHash,revision},revision,2);signal.throwIfAborted();return projection
}

/** Layout-aware baselines come from the active owner, pinned to its receipt.
 * A member never receives native owner credentials or seeds a room with this. */
export async function readWordBrowserProjection(session:Session,revision:number,cancellation:AbortSignal):Promise<WordRegionProjection>{
 const protocol=requireWordBrowserProtocol(session.collaborationProtocol)
 if(!Number.isSafeInteger(revision)||revision<0||!Number.isSafeInteger(session.collaborationEpoch)||session.collaborationEpoch!<0)throw new Error('word-browser-baseline')
 const signal=AbortSignal.any([cancellation,AbortSignal.timeout(30_000)])
 signal.throwIfAborted()
 const response=await awaitRecoveryResponse(()=>protocol===wordLayoutProtocol?fetch(negotiationURL(session).replace(/negotiate$/,'word-room-projection'),{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json',...wordBrowserHeaders(session)},body:JSON.stringify({epoch:session.collaborationEpoch,revision}),signal}):api(session,`/editor?revision=${revision}`,{signal}),signal)
 if(!response.ok)throw new Error('word-browser-baseline-unavailable')
 const bytes=await readBoundedResponse(response,16*1024*1024,signal,'word-browser-baseline-limit')
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),projection=protocol===wordLayoutProtocol?value?.projection:value
 if(protocol===wordLayoutProtocol&&(!wordBrowserModelMatches({...value,nodeEditVersion:value?.saveState?.nodeEditVersion},protocol)||!wordBrowserModelMatches(value?.saveState??{},protocol)||value.saveState.type!=='hcd-save-status'||value.saveState.revision!==revision))throw new Error('word-browser-baseline-model')
 if(!projection||projection.documentId!==session.documentId||projection.revision!==revision||!Array.isArray(projection.blocks))throw new Error('word-browser-baseline-invalid')
 readWordLayout({layout:projection.flowLayout,layoutHash:projection.flowLayoutHash,revision},revision,2)
 signal.throwIfAborted();return projection
}

/** A link proof includes the authenticated immutable revision record because
 * removing a binding creates no nonce-derived object identity. */
export async function readWordLinkSessionProof(session:Session,transactionId:string,revision:number,cancellation:AbortSignal){
 if(session.collaborationProtocol!==wordLayoutProtocol||!/^[a-f0-9]{32}$/.test(transactionId)||!Number.isSafeInteger(revision)||revision<1)throw Error('word-browser-link-baseline')
 const signal=AbortSignal.any([cancellation,AbortSignal.timeout(30_000)]);signal.throwIfAborted()
 const readRecord=async()=>{const response=await awaitRecoveryResponse(()=>api(session,`/revisions/${revision}`,{signal}),signal);const bytes=await readBoundedResponse(response,1024*1024,signal,'word-browser-record-limit');signal.throwIfAborted();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
 const [base,receipt,record]=await Promise.all([readWordStorySessionProjection(session,revision-1,signal),readWordStorySessionProjection(session,revision,signal),readRecord()]);signal.throwIfAborted()
 const proof=await prepareWordLinkSessionProof(transactionId,base,receipt,record);signal.throwIfAborted();return proof
}
