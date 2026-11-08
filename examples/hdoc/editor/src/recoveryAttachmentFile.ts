import {validateNodeResources,type NodeResource} from './extensionPortable.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'

/** Downloading a selection is separate from importing or attaching it. */
export async function recoveryAttachmentFile(resource:NodeResource,bytes:Uint8Array,signal:AbortSignal=new AbortController().signal){
 signal.throwIfAborted()
 const descriptor=structuredClone(resource);validateNodeResources([descriptor])
 if(!(bytes instanceof Uint8Array)||bytes.byteLength!==descriptor.byteLength)throw Error('recovery-attachment-integrity')
 const copy=Uint8Array.from(bytes)
 if(await awaitRecoveryPreparation(()=>imageFileHash(copy),signal)!==descriptor.hash)throw Error('recovery-attachment-integrity')
 signal.throwIfAborted()
 return{name:descriptor.name,blob:new Blob([copy],{type:'application/octet-stream'})}
}
