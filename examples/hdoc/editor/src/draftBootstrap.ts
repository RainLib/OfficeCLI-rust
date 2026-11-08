import * as Y from 'yjs'
import {api,ApiError,type Session} from './api.ts'
import {legacyProtocol,requireCollaborationSession,type CollaborationSession} from './collaborationProtocol.ts'
import {localDocumentProtocol,createDraftDocument,restoreLocalDraft} from './localDrafts.ts'

export type DraftBootstrapProblem='localDraftUnavailable'|'localDraftServerUnavailable'|'localDraftAccessDenied'|'localDraftProtocolUnavailable'|'localDraftAuthorityChanged'
export class DraftBootstrapError extends Error {
 constructor(readonly key:DraftBootstrapProblem,readonly authority?:CollaborationSession,readonly status?:number,readonly cause?:unknown){super(key)}
}
export async function draftStorage<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work()}catch{throw new DraftBootstrapError('localDraftUnavailable')}
}
export function draftBootstrapProblem(error:unknown):DraftBootstrapProblem{
 return error instanceof DraftBootstrapError?error.key:'localDraftServerUnavailable'
}
/** A rejected candidate is a compatibility/recovery problem, not an IDB or
 * transport failure. The caller keeps both original copies available. */
export function restoreDraftCandidate(cached:Y.Doc,server:Y.Doc):Y.Doc{
 try{return restoreLocalDraft(cached,server)}catch(cause){throw new DraftBootstrapError('localDraftProtocolUnavailable',undefined,undefined,cause)}
}
const changed=(session:Session,current:CollaborationSession)=>current.collaborationEpoch!==(session.collaborationEpoch??0)||current.collaborationProtocol!==(session.collaborationProtocol??legacyProtocol)
export async function draftAuthority(session:Session,signal:AbortSignal):Promise<CollaborationSession>{
 try{const access=await(await api(session,'/auth',{signal})).json();return requireCollaborationSession({...access,collaborationProtocol:access.collaborationProtocol??legacyProtocol})}
 catch(error){if(signal.aborted)throw error;throw new DraftBootstrapError(error instanceof ApiError&&[401,403].includes(error.status)?'localDraftAccessDenied':'localDraftServerUnavailable',undefined,error instanceof ApiError?error.status:undefined,error)}
}
export async function requireDraftAuthority(session:Session,signal:AbortSignal){
 const current=await draftAuthority(session,signal)
 if(changed(session,current))throw new DraftBootstrapError('localDraftAuthorityChanged',current)
 return current
}
/** A stale state request probes authority once. It never retries a room, joins
 * a different epoch or labels a server failure as a disk failure. */
export async function readServerDraft(session:Session,signal:AbortSignal):Promise<Y.Doc|null>{
 try{
  const response=await api(session,'/collaboration/state',{signal})
  const bytes=new Uint8Array(await response.arrayBuffer())
  if(bytes.byteLength>8*1024*1024)throw new DraftBootstrapError('localDraftProtocolUnavailable')
  const doc=createDraftDocument(session)
  try{
   Y.applyUpdate(doc,bytes,'hcd-local-server')
   if(localDocumentProtocol(doc)!==(session.collaborationProtocol??legacyProtocol))throw new DraftBootstrapError('localDraftProtocolUnavailable')
   return doc
  }catch{doc.destroy();throw new DraftBootstrapError('localDraftProtocolUnavailable')}
 }catch(error){
  if(signal.aborted)throw error
  if(error instanceof ApiError&&error.status===404)return null
  if(error instanceof ApiError&&[401,403].includes(error.status))throw new DraftBootstrapError('localDraftAccessDenied',undefined,error.status)
  if(error instanceof ApiError&&[409,426].includes(error.status)||error instanceof DraftBootstrapError&&error.key==='localDraftProtocolUnavailable'){
   const current=await draftAuthority(session,signal)
   if(changed(session,current))throw new DraftBootstrapError('localDraftAuthorityChanged',current)
   throw new DraftBootstrapError('localDraftProtocolUnavailable')
  }
  throw error instanceof DraftBootstrapError?error:new DraftBootstrapError('localDraftServerUnavailable',undefined,error instanceof ApiError?error.status:undefined,error)
 }
}
