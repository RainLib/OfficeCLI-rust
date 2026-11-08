/** Bounded binary framing for a single regional recovery update. It does not
 * authenticate the sender or apply the result; the transport must bind both to
 * an authorized room and validate the complete update before mutation. */
export const wordRecoveryChunkBytes=256*1024
export const wordRecoveryMaxBytes=8*1024*1024
export type WordRecoveryChunkManifest={version:1;byteLength:number;sha256:string;chunks:number}
const digest=async(data:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(data))),value=>value.toString(16).padStart(2,'0')).join('')
function validManifest(value:WordRecoveryChunkManifest){return !!value&&value.version===1&&Number.isSafeInteger(value.byteLength)&&value.byteLength>0&&value.byteLength<=wordRecoveryMaxBytes&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256)&&value.chunks===Math.ceil(value.byteLength/wordRecoveryChunkBytes)}
export async function splitWordRecoveryUpdate(input:Uint8Array,signal?:AbortSignal){
 signal?.throwIfAborted()
 if(!(input instanceof Uint8Array)||!input.length||input.length>wordRecoveryMaxBytes)throw Error('word-recovery-chunk-limit')
 const bytes=Uint8Array.from(input),sha256=await digest(bytes);signal?.throwIfAborted()
 const manifest:WordRecoveryChunkManifest={version:1,byteLength:bytes.length,sha256,chunks:Math.ceil(bytes.length/wordRecoveryChunkBytes)}
 const chunks=Array.from({length:manifest.chunks},(_,index)=>bytes.slice(index*wordRecoveryChunkBytes,(index+1)*wordRecoveryChunkBytes))
 return {manifest,chunks}
}
/** One bounded, isolated assembly. Duplicate identical chunks are harmless;
 * mismatched, missing or corrupt data never yields a partial update. */
export class WordRecoveryChunkAssembly{
 private readonly manifest:WordRecoveryChunkManifest
 private readonly chunks:Map<number,Uint8Array>=new Map()
 private cancelled=false
 private finishing=false
 constructor(manifest:WordRecoveryChunkManifest){if(!validManifest(manifest))throw Error('word-recovery-chunk-invalid');this.manifest={...manifest}}
 add(index:number,bytes:Uint8Array){
  if(this.cancelled||this.finishing)throw Error('word-recovery-chunk-closed')
  if(!Number.isSafeInteger(index)||index<0||index>=this.manifest.chunks||!(bytes instanceof Uint8Array))throw Error('word-recovery-chunk-invalid')
  const expected=Math.min(wordRecoveryChunkBytes,this.manifest.byteLength-index*wordRecoveryChunkBytes)
  if(bytes.length!==expected)throw Error('word-recovery-chunk-invalid')
  const previous=this.chunks.get(index)
  if(previous){if(previous.some((value,offset)=>value!==bytes[offset]))throw Error('word-recovery-chunk-conflict');return false}
  this.chunks.set(index,Uint8Array.from(bytes));return true
 }
 cancel(){this.cancelled=true;this.chunks.clear()}
 async finish(signal?:AbortSignal){
  signal?.throwIfAborted()
  if(this.cancelled||this.finishing)throw Error('word-recovery-chunk-closed')
  if(this.chunks.size!==this.manifest.chunks)throw Error('word-recovery-chunk-incomplete')
  this.finishing=true
  try{
   const bytes=new Uint8Array(this.manifest.byteLength);for(let index=0;index<this.manifest.chunks;index++)bytes.set(this.chunks.get(index)!,index*wordRecoveryChunkBytes)
   const actual=await digest(bytes);signal?.throwIfAborted();if(this.cancelled)throw Error('word-recovery-chunk-closed')
   if(actual!==this.manifest.sha256)throw Error('word-recovery-chunk-integrity')
   this.cancelled=true;this.chunks.clear();return bytes
  }catch(error){this.finishing=false;throw error}
 }
}
