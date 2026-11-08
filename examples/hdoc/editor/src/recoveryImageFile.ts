import {imageFileHash} from './imageFileIntegrity.ts'
import {fixedImageExtension} from './fixedPortableAssets.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'

/** Return the exact archived replacement only after verifying its identity.
 * The fallback extension allows a verified but unknown original to be saved. */
export async function recoveryImageFile(hash:string,bytes:Uint8Array,signal:AbortSignal=new AbortController().signal){
 signal.throwIfAborted()
 if(!/^[a-f0-9]{64}$/.test(hash)||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>8*1024*1024)throw Error('recovery-image-integrity')
 const copy=Uint8Array.from(bytes);if(await awaitRecoveryPreparation(()=>imageFileHash(copy),signal)!==hash)throw Error('recovery-image-integrity')
 signal.throwIfAborted()
 let extension:string;try{extension=fixedImageExtension(copy)}catch{extension='bin'}
 return {name:`recovered-image-${hash.slice(0,16)}.${extension}`,blob:new Blob([copy],{type:'application/octet-stream'})}
}
