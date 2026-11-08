/** Encode a JSON sequence in bounded pieces without building one large string.
 * Callers provide complete JSON fragments, including any required quoting. */
export async function writeRecoveryJson(parts:Iterable<string>,limit:number,signal:AbortSignal):Promise<Uint8Array>{
 const encoder=new TextEncoder(),chunks:Uint8Array[]=[],segment=256*1024;let size=0,processed=0
 for(const part of parts){
  for(let offset=0;offset<part.length;){
   signal.throwIfAborted();let end=Math.min(offset+segment,part.length)
   // Keep UTF-16 surrogate pairs together across chunk boundaries.
   if(end<part.length&&end>offset&&part.charCodeAt(end-1)>=0xd800&&part.charCodeAt(end-1)<=0xdbff&&part.charCodeAt(end)>=0xdc00&&part.charCodeAt(end)<=0xdfff)end--
   const bytes=encoder.encode(part.slice(offset,end));size+=bytes.length;if(size>limit)throw Error('semantic-recovery-limit');chunks.push(bytes);processed+=end-offset;offset=end
   if(processed>=segment){processed=0;await new Promise<void>(resolve=>setTimeout(resolve,0));signal.throwIfAborted()}
  }
 }
 signal.throwIfAborted();const result=new Uint8Array(size);let offset=0
 for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length}
 signal.throwIfAborted();return result
}
