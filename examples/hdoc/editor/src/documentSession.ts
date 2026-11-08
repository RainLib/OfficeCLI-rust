import {wordRegionVersion} from './wordRegions.ts'
import {api,type Session} from './api.ts'
import {negotiateSession} from './protocolClient.ts'
import {legacyProtocol,wordRegionalProtocol,wordLayoutProtocol,requireCollaborationSession} from './collaborationProtocol.ts'
import {EditorDocumentError,documentProblem,classifyDocumentProblem} from './documentProblems.ts'

const formats=new Set(['docx','pptx','pdf','xlsx','html','md','txt'])
/** Carries only the authenticated scope needed to locate the old local Word
 * journal. This does not make the incompatible document editable. */
export class WordCompatibilityError extends EditorDocumentError{
 constructor(readonly recoverySession:Session,readonly checkpointSession?:Session){super(documentProblem('HCD-DOC-1026'))}
}
/** Parallel, abortable bootstrap. No local draft is cleared on a failed open. */
export async function readDocumentSession(input:Pick<Session,'documentId'|'token'|'apiUrl'|'collabUrl'>,cancellation:AbortSignal):Promise<Session>{
 cancellation.throwIfAborted()
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(input.documentId)||!input.token.trim())throw new EditorDocumentError(documentProblem('HCD-DOC-1000'))
 const signal=AbortSignal.any([cancellation,AbortSignal.timeout(45_000)]),draft:Session={...input,scope:'read',format:''}
 let auth:Response,manifest:Response
 try{[auth,manifest]=await Promise.all([api(draft,'/auth',{signal}),api(draft,'',{signal})])}catch(error){throw signal.aborted?signal.reason:error}
 let access:any,info:any
 try{[access,info]=await Promise.all([auth.json(),manifest.json()])}catch(error){if(signal.aborted)throw signal.reason;throw new EditorDocumentError(documentProblem('HCD-DOC-3001'))}
 signal.throwIfAborted()
 if(!access||!['read','write'].includes(access.scope)||!Number.isSafeInteger(access.collaborationEpoch)||access.collaborationEpoch<0||typeof info?.source?.format!=='string')throw new EditorDocumentError(documentProblem('HCD-DOC-3001'))
 if(!formats.has(info.source.format))throw new EditorDocumentError(documentProblem('HCD-DOC-3002'))
 try{
  const layout=access.collaborationProtocol===wordLayoutProtocol,authority=requireCollaborationSession({...access,collaborationProtocol:access.collaborationProtocol??legacyProtocol},{wordLayoutV2:layout})
  const session:Session={...input,...authority,scope:access.scope,format:info.source.format,flowLayoutVersion:wordRegionVersion(info,{wordLayoutV2:layout}),wordNumericFields:layout&&info.source.format==='docx'&&access.wordNumericFields==='inline-v1'?'inline-v1':undefined,...(typeof access.userId==='string'?{userId:access.userId}:{}),...(typeof access.displayName==='string'?{displayName:access.displayName}:{})}
  if(layout){
   if(session.format!=='docx'||session.flowLayoutVersion!==2||access.coordinatedRestore!==true)throw new EditorDocumentError(documentProblem('HCD-DOC-1026'))
   try{const selected=await negotiateSession(session,signal,{wordLayoutV2:true});signal.throwIfAborted();if(selected.collaborationEpoch!==authority.collaborationEpoch||selected.collaborationProtocol!==authority.collaborationProtocol)throw new Error('word-browser-session-changed')}
   catch(error){signal.throwIfAborted();throw new EditorDocumentError(documentProblem('HCD-DOC-1026'))}
  }
  return session
 }catch(error){
  if(classifyDocumentProblem(error).code==='HCD-DOC-1026'&&info.source.format==='docx'&&info.profile==='semantic-flow'&&info.capabilities?.flowLayout===2&&[wordRegionalProtocol,'hcd-word-regions/2'].includes(access.collaborationProtocol)){
   const recovery:Session={...input,scope:access.scope,format:'docx',collaborationEpoch:access.collaborationEpoch,collaborationProtocol:wordRegionalProtocol,flowLayoutVersion:2,...(typeof access.userId==='string'?{userId:access.userId}:{})}
   const checkpoint=access.collaborationProtocol===wordLayoutProtocol?{...recovery,...requireCollaborationSession(access,{wordLayoutV2:true}),...(typeof access.displayName==='string'?{displayName:access.displayName}:{})}:undefined
   throw new WordCompatibilityError(recovery,checkpoint)
  }
  throw error
 }
}
