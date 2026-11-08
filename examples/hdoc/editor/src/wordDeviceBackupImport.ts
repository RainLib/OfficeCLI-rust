/** A stable file fingerprint without creating another full-size UTF-8 buffer. */
export async function wordDeviceImportId(text:string,signal?:AbortSignal){
 const hashes:number[]=[]
 for(let start=0;start<text.length;){
  signal?.throwIfAborted()
  let end=Math.min(text.length,start+262144)
  if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end++
  const bytes=new TextEncoder().encode(text.slice(start,end)),hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));start=end
  hashes.push(...hash)
 }
 signal?.throwIfAborted()
 const result=new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(hashes)));signal?.throwIfAborted()
 return [...result].map(value=>value.toString(16).padStart(2,'0')).join('')
}
