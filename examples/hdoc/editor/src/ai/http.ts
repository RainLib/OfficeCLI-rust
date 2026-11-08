import {AiError,abortable} from './core.js'
import type {AiEvent,AiProvider} from './types.js'
export type HttpAiProviderOptions={url:string;baseUrl?:string;allowCrossOrigin?:boolean;headers?:()=>HeadersInit|Promise<HeadersInit>}
/** Bounded NDJSON transport to a host-owned authenticated server; no automatic retries. */
export function createHttpAiProvider(options:HttpAiProviderOptions):AiProvider{
 const configuration={...options}
 return Object.freeze({async *generate(request,{signal}){
  const base=configuration.baseUrl??(typeof location==='undefined'?undefined:location.href)
  let url:URL
  try{url=new URL(configuration.url,base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||!configuration.allowCrossOrigin&&(!base||url.origin!==new URL(base).origin))throw new Error()}catch{throw new AiError('unavailable')}
  const headers=new Headers(await abortable(configuration.headers?.()??{},signal));headers.set('Content-Type','application/json');headers.set('Accept','application/x-ndjson');headers.set('Idempotency-Key',request.requestId)
  let response:Response
  try{response=await fetch(url,{method:'POST',body:JSON.stringify(request),headers,signal,credentials:configuration.allowCrossOrigin?'omit':'same-origin',redirect:'error',cache:'no-store'})}catch{if(signal.aborted)throw new AiError('cancelled');throw new AiError('network')}
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new AiError(response.status===401||response.status===403?'denied':response.status===429?'rate-limited':'unavailable')}
  if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/x-ndjson')||!response.body){void response.body?.cancel().catch(()=>{});throw new AiError('protocol')}
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',bytes=0
  const decode=(text:string)=>{try{return JSON.parse(text) as AiEvent}catch{throw new AiError('protocol')}}
  try{
   while(true){
    const next=await abortable(reader.read(),signal)
    if(next.done){try{buffer+=decoder.decode()}catch{throw new AiError('protocol')};if(buffer.trim())yield decode(buffer);return}
    bytes+=next.value.byteLength;if(bytes>2_000_000)throw new AiError('limit')
    try{buffer+=decoder.decode(next.value,{stream:true})}catch{throw new AiError('protocol')}
    let newline:number
    while((newline=buffer.indexOf('\n'))>=0){if(newline>65536)throw new AiError('limit');const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(line)yield decode(line)}
    if(buffer.length>65536)throw new AiError('limit')
   }
  }finally{void reader.cancel().catch(()=>{});reader.releaseLock()}
 }})
}
