/** WebCrypto snapshots a BufferSource when digest is invoked. Pass an owned
 * ArrayBuffer view directly so large recovery resources do not need an extra
 * JavaScript copy; SharedArrayBuffer needs an ordinary-buffer snapshot. */
export async function recoveryDigest(bytes:Uint8Array):Promise<string>{
 const input=bytes.buffer instanceof ArrayBuffer
  ? new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  : Uint8Array.from(bytes)
 const hash=await crypto.subtle.digest('SHA-256',input)
 return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('')
}
