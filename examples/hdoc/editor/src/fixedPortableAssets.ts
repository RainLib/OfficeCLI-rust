import {api,ApiError,resourceRequest,type Session} from './api.ts'
import {fixedImageHash} from './fixedImageFiles.ts'
import {fixedPortableLimits} from './fixedPortableArchive.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'

const validHash=(value:string)=>/^[a-f0-9]{64}$/.test(value)
/** Determine the server's allowed extension from bytes, not a filename or an
 * untrusted archive descriptor. The server performs its own image checks. */
export function fixedImageExtension(bytes:Uint8Array):'png'|'jpg'|'gif'|'webp'{
 if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value))return 'png'
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpg'
 const ascii=(start:number,end:number)=>String.fromCharCode(...bytes.subarray(start,end))
 if(bytes.length>=6&&['GIF87a','GIF89a'].includes(ascii(0,6)))return 'gif'
 if(bytes.length>=12&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP')return 'webp'
 throw new Error('fixed-portable-image-type')
}
async function bounded(response:Response,signal:AbortSignal){
 const declared=response.headers.get('content-length')
 if(!response.body)throw new Error('fixed-portable-resource')
 const output=await readBoundedResponse(response,fixedPortableLimits.resource,signal,'fixed-portable-limit')
 if(!output.length||declared!==null&&Number(declared)!==output.length)throw new Error('fixed-portable-resource')
 return output
}
async function receipt(response:Response,signal:AbortSignal){
 const bytes=await readBoundedResponse(response,64*1024,signal,'fixed-portable-integrity')
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as {hash?:unknown;byteLength?:unknown}}catch{throw new Error('fixed-portable-integrity')}
}
/** Capture only bytes matching the requested content hash. */
export async function readFixedPortableAsset(session:Session,hash:string,signal:AbortSignal){
 if(!validHash(hash))throw new Error('fixed-portable-integrity')
 signal=AbortSignal.any([signal,AbortSignal.timeout(45_000)])
 let response:Response
 // A cached response proves bytes existed previously, not that the server can
 // still resolve the resource for a later save after staging was pruned.
 try{response=await awaitRecoveryResponse(()=>api(session,`/staged-assets/${hash}`,{signal,cache:'no-store'}),signal)}catch(error){if(!(error instanceof ApiError)||error.status!==404)throw error;signal.throwIfAborted();response=await awaitRecoveryResponse(()=>api(session,`/assets/${hash}`,{signal,cache:'no-store'}),signal)}
 const bytes=await bounded(response,signal);signal.throwIfAborted();if(await fixedImageHash(bytes)!==hash)throw new Error('fixed-portable-integrity');signal.throwIfAborted();return bytes
}
/** Caller rechecks authorization/document identity and asks for explicit
 * recovery first; staging does not submit an edit or resolve a save receipt. */
export async function stageFixedPortableAsset(session:Session,hash:string,bytes:Uint8Array,signal:AbortSignal){
 signal=AbortSignal.any([signal,AbortSignal.timeout(45_000)])
 if(!validHash(hash)||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>fixedPortableLimits.resource)throw new Error('fixed-portable-integrity')
 const captured=Uint8Array.from(bytes);if(await fixedImageHash(captured)!==hash)throw new Error('fixed-portable-integrity')
 const extension=fixedImageExtension(captured);signal.throwIfAborted()
 // A timeout stops waiting, not the server operation. Staging is content
 // addressed and is never treated as a committed document change.
 const response=await awaitRecoveryResponse(()=>resourceRequest(()=>api(session,`/staged-assets?extension=${extension}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Blob([captured]),signal}),signal),signal)
 const descriptor=await receipt(response,signal);signal.throwIfAborted()
 if(descriptor.hash!==hash||descriptor.byteLength!==captured.length)throw new Error('fixed-portable-integrity')
}

/** Reading an existing resource does not protect it from subsequent GC.
 * Re-pin under the server document lock; only an unavailable reuse endpoint
 * or resource (404) may fall back to uploading the verified package bytes. */
export async function repinFixedPortableAsset(session:Session,hash:string,bytes:Uint8Array,signal:AbortSignal){
 signal=AbortSignal.any([signal,AbortSignal.timeout(45_000)])
 if(!validHash(hash)||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>fixedPortableLimits.resource)throw new Error('fixed-portable-integrity')
 const captured=Uint8Array.from(bytes);if(await fixedImageHash(captured)!==hash)throw new Error('fixed-portable-integrity')
 const extension=fixedImageExtension(captured);signal.throwIfAborted()
 try{
  const response=await awaitRecoveryResponse(()=>resourceRequest(()=>api(session,'/resources/reuse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hash,extension,byteLength:captured.length}),signal}),signal),signal)
  const descriptor=await receipt(response,signal);signal.throwIfAborted()
  if(descriptor.hash!==hash||descriptor.byteLength!==captured.length)throw new Error('fixed-portable-integrity')
 }catch(error){
  if(!(error instanceof ApiError)||error.status!==404)throw error
  signal.throwIfAborted();await stageFixedPortableAsset(session,hash,captured,signal)
 }
}
