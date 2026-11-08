import {validateNodeResources} from './extensionPortable.ts'
import {awaitRecoveryPreparation,awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {nodeEditWireVersion,inlineProtocol,type CollaborationProtocol} from './collaborationProtocol.ts'
export type Session = {
  documentId: string
  token: string
  scope: 'read' | 'write'
  format: string
  flowLayoutVersion?: 1 | 2
  wordNumericFields?: 'inline-v1'
  apiUrl?: string
  collabUrl?: string
  userId?: string
  displayName?: string
  collaborationEpoch?: number
  collaborationProtocol?: CollaborationProtocol
}

export type RevisionNode = { nodeId: string; text: string; nodeHash: string }
export type RevisionEvent = { revision: number; patchId: string; authorName?: string; nodes: RevisionNode[]; reset?: boolean; nodeHashes?: Record<string, string | null> }
export class ApiError extends Error {
  readonly code?:string
  constructor(readonly status:number,message:string){super(`${status}: ${message}`);try{const value=JSON.parse(message)?.error;if(typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(value))this.code=value}catch{/* Older servers may return plain text. */}}
}

export { watchRevisions } from './revisionWatch.ts'
export type { RevisionConnectionStatus } from './revisionWatch.ts'

export async function api(session: Session, route: string, init: RequestInit = {}) {
  const response = await fetch(`${session.apiUrl || '/v1/documents'}/${encodeURIComponent(session.documentId)}${route}`, {
    ...init,
    headers: { ...(session.flowLayoutVersion===undefined?{}:{'X-HCD-Flow-Layout-Version':String(session.flowLayoutVersion)}),'X-HCD-Node-Edits-Version':String(nodeEditWireVersion),'X-HCD-Custom-Marks-Version':'1',...(session.collaborationProtocol===inlineProtocol?{'X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3'}:{'X-HCD-Extension-Version':'2'}),Authorization: `Bearer ${session.token}`, ...(session.collaborationEpoch===undefined?{}:{'X-HCD-Collaboration-Epoch':String(session.collaborationEpoch)}),...(session.collaborationProtocol?{'X-HCD-Collaboration-Protocol':session.collaborationProtocol}:{}),...(init.headers || {}) },
  })
  if (!response.ok) {
    // Error bodies are untrusted too. In particular, a stalled proxy error
    // must not keep a save, receipt lookup, or resource task waiting forever.
    const signal=AbortSignal.any([AbortSignal.timeout(45_000),...(init.signal?[init.signal]:[])])
    let message='response error details unavailable'
    if(response.body)try{
      const bytes=await readBoundedResponse(response,64*1024,signal,'api-error-body-limit')
      message=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
    }catch(error){signal.throwIfAborted()}
    signal.throwIfAborted()
    throw new ApiError(response.status,message)
  }
  return response
}

/** Retry only the server's explicit, non-mutating resource lock rejection. */
export async function resourceRequest(work:()=>Promise<Response>,signal:AbortSignal){
 for(let attempt=0;;attempt++){
  signal.throwIfAborted()
  try{return await work()}catch(error){
   if(!(error instanceof ApiError)||error.status!==409||error.code!=='HCD_RESOURCE_BUSY'||attempt>=31)throw error
   const delay=Math.min(250,25*2**Math.min(attempt,4))+Math.floor(Math.random()*25)
   await new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);reject(signal.reason)},timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve()},delay);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop()})
  }
 }
}

/** Stage an image using one deadline across all safe lock-contention retries. */
export async function stageImageAsset(session:Session,extension:string,body:Blob,cancellation?:AbortSignal,expectedHash?:string){
 const signal=AbortSignal.any([AbortSignal.timeout(45_000),...(cancellation?[cancellation]:[])])
 if(expectedHash!==undefined){
  if(!/^[a-f0-9]{64}$/.test(expectedHash)||!body.size||body.size>8*1024*1024)throw new Error('nodeResourceIntegrity')
  try{
   const response=await awaitRecoveryResponse(()=>resourceRequest(()=>api(session,'/resources/reuse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hash:expectedHash,extension,byteLength:body.size}),signal}),signal),signal)
   const result=await resourceReceipt(response,signal) as {hash?:unknown;byteLength?:unknown}
   if(!result||result.hash!==expectedHash||result.byteLength!==body.size)throw new Error('nodeResourceIntegrity')
   signal.throwIfAborted();return {hash:expectedHash}
  }catch(error){if(!(error instanceof ApiError)||error.status!==404)throw error}
  signal.throwIfAborted()
 }
 // A stopped wait does not roll back staging; a late response is discarded.
 const response=await awaitRecoveryResponse(()=>resourceRequest(()=>api(session,`/staged-assets?extension=${encodeURIComponent(extension)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body,signal}),signal),signal)
 const result=await resourceReceipt(response,signal) as {hash?:unknown}
 if(!result||typeof result.hash!=='string'||!/^[a-f0-9]{64}$/.test(result.hash)||expectedHash!==undefined&&result.hash!==expectedHash)throw new Error('nodeResourceIntegrity')
 signal.throwIfAborted()
 return result as {hash:string}
}

async function resourceReceipt(response:Response,signal:AbortSignal){
 const data=await readBoundedResponse(response,64*1024,signal,'nodeResourceIntegrity')
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data))}catch{throw new Error('nodeResourceIntegrity')}
}

/** Authenticated, immutable bytes; only hashes and metadata enter a node. */
export async function archiveNodeResource(session:Session,input:{file:Blob;name:string;key:string;signal?:AbortSignal;reuseExisting?:boolean;expectedHash?:string}){
 input={...input};input.signal?.throwIfAborted()
 if(!(input.file instanceof Blob)||!input.file.size||input.file.size>8*1024*1024)throw new Error('nodeResourceInvalid')
 const signal=AbortSignal.any([AbortSignal.timeout(45_000),...(input.signal?[input.signal]:[])])
 const bytes=await awaitRecoveryPreparation(()=>input.file.arrayBuffer(),signal)
 return archiveNodeResourceData(session,{bytes,body:input.file,name:input.name,key:input.key,mediaType:input.file.type||'application/octet-stream',reuseExisting:input.reuseExisting,expectedHash:input.expectedHash},signal)
}
/** Recovery already has verified bytes. Snapshot them once; create an upload
 * Blob only if reuse is unavailable, without a Blob-to-arrayBuffer round trip. */
export async function archiveNodeResourceBytes(session:Session,input:{bytes:Uint8Array;name:string;key:string;mediaType:string;signal?:AbortSignal;expectedHash:string}){
 input.signal?.throwIfAborted()
 if(!(input.bytes instanceof Uint8Array)||!input.bytes.length||input.bytes.length>8*1024*1024)throw new Error('nodeResourceInvalid')
 const signal=AbortSignal.any([AbortSignal.timeout(45_000),...(input.signal?[input.signal]:[])])
 const bytes=Uint8Array.from(input.bytes).buffer
 return archiveNodeResourceData(session,{bytes,name:input.name,key:input.key,mediaType:input.mediaType,reuseExisting:true,expectedHash:input.expectedHash},signal)
}
async function archiveNodeResourceData(session:Session,input:{bytes:ArrayBuffer;body?:Blob;name:string;key:string;mediaType:string;reuseExisting?:boolean;expectedHash?:string},signal:AbortSignal){
 const digest=await awaitRecoveryPreparation(()=>crypto.subtle.digest('SHA-256',input.bytes),signal)
 signal.throwIfAborted()
 const hash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')
 if(input.expectedHash!==undefined&&hash!==input.expectedHash)throw new Error('nodeResourceIntegrity')
 const resource={key:input.key,hash,byteLength:input.bytes.byteLength,name:input.name,mediaType:input.mediaType};validateNodeResources([resource])
 const extension=({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'} as Record<string,string>)[resource.mediaType]??'bin'
 // Pin under the document/GC lock; only a missing resource or old endpoint
 // falls back to uploading the same verified bytes.
 if(input.reuseExisting)try{
  const response=await awaitRecoveryResponse(()=>resourceRequest(()=>api(session,'/resources/reuse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hash,extension,byteLength:resource.byteLength}),signal}),signal),signal)
  const descriptor=await resourceReceipt(response,signal);if(descriptor.hash!==hash||descriptor.byteLength!==resource.byteLength)throw new Error('nodeResourceIntegrity')
  signal.throwIfAborted();return resource
 }catch(error){if(!(error instanceof ApiError)||error.status!==404)throw error}
 signal.throwIfAborted()
 const body=input.body??new Blob([input.bytes],{type:input.mediaType})
 const response=await awaitRecoveryResponse(()=>resourceRequest(()=>api(session,`/resources?extension=${extension}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body,signal}),signal),signal)
 const descriptor=await resourceReceipt(response,signal);if(descriptor.hash!==hash||descriptor.byteLength!==resource.byteLength)throw new Error('nodeResourceIntegrity')
 signal.throwIfAborted()
 return resource
}
async function readVerifiedNodeResource(session:Session,resource:import('./extensionPortable.ts').NodeResource,revision?:number,cancellation?:AbortSignal){
 validateNodeResources([resource])
 resource=structuredClone(resource);const signal=AbortSignal.any([AbortSignal.timeout(45_000),...(cancellation?[cancellation]:[])])
 let response:Response
 try{response=await awaitRecoveryResponse(()=>api(session,revision===undefined?`/staged-assets/${resource.hash}`:`/assets/${resource.hash}?revision=${revision}`,{signal}),signal)}catch(error){if(revision!==undefined||!(error instanceof ApiError)||error.status!==404)throw error;signal.throwIfAborted();response=await awaitRecoveryResponse(()=>api(session,`/assets/${resource.hash}`,{signal}),signal)}
 const bytes=await readBoundedResponse(response,resource.byteLength,signal,'nodeResourceIntegrity')
 if(bytes.length!==resource.byteLength||Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('')!==resource.hash)throw new Error('nodeResourceIntegrity')
 signal.throwIfAborted()
 return {bytes,type:response.headers.get('content-type')??''}
}
export async function readNodeResourceBytes(session:Session,resource:import('./extensionPortable.ts').NodeResource,revision?:number,cancellation?:AbortSignal){
 return (await readVerifiedNodeResource(session,resource,revision,cancellation)).bytes
}
export async function readNodeResource(session:Session,resource:import('./extensionPortable.ts').NodeResource,revision?:number,cancellation?:AbortSignal){
 const {bytes,type}=await readVerifiedNodeResource(session,resource,revision,cancellation)
 return new Blob([bytes],{type})
}
