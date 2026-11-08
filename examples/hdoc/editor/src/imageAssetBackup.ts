import {api,ApiError,type Session} from './api.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
const max=8*1024*1024
/** Read immutable or staged bytes with authorization, a bounded response and
 * hash verification. No document state or staging record is changed. */
export async function readImageAssetBackup(session:Session,hash:string,cancellation?:AbortSignal){
 if(!/^[a-f0-9]{64}$/.test(hash))throw Error('image-backup-invalid')
 const signal=AbortSignal.any([AbortSignal.timeout(45_000),...(cancellation?[cancellation]:[])])
 let response:Response
 try{response=await awaitRecoveryResponse(()=>api(session,`/assets/${hash}`,{signal}),signal)}catch(error){if(!(error instanceof ApiError)||error.status!==404)throw error;signal.throwIfAborted();response=await awaitRecoveryResponse(()=>api(session,`/staged-assets/${hash}`,{signal}),signal)}
 if(!response.body)throw Error('image-backup-unavailable')
 const bytes=await readBoundedResponse(response,max,signal,'image-backup-limit');signal.throwIfAborted()
 if(!bytes.length||await imageFileHash(bytes)!==hash)throw Error('image-backup-integrity')
 signal.throwIfAborted()
 const prefix=(...values:number[])=>values.every((value,i)=>bytes[i]===value)
 const extension=prefix(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a)?'png':prefix(0xff,0xd8,0xff)?'jpg':prefix(0x47,0x49,0x46,0x38)?'gif':prefix(0x52,0x49,0x46,0x46)&&String.fromCharCode(...bytes.slice(8,12))==='WEBP'?'webp':'bin'
 return{bytes,extension}
}
