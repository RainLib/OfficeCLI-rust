// Validate the binary envelope before transferring decoded buffers. The caller
// still verifies every digest, scope, resource inventory and canonical bundle.
export {}
const MiB=1024*1024
const digit=(code:number)=>code>=65&&code<=90?code-65:code>=97&&code<=122?code-71:code>=48&&code<=57?code+4:code===43?62:code===47?63:-1
function decode(input:unknown,max:number){
 const value=input as {byteLength:number;sha256:string;base64:string}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='base64,byteLength,sha256'||!Number.isSafeInteger(value.byteLength)||value.byteLength<1||value.byteLength>max||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||typeof value.base64!=='string'||value.base64.length!==4*Math.ceil(value.byteLength/3))throw Error('invalid')
 const pad=(3-value.byteLength%3)%3,end=value.base64.length-pad,last=digit(value.base64.charCodeAt(end-1))
 if(value.base64.slice(end)!=='='.repeat(pad)||last<0||pad===1&&(last&3)!==0||pad===2&&(last&15)!==0)throw Error('invalid')
 const bytes=new Uint8Array(value.byteLength),size=256*1024;let offset=0
 for(let start=0;start<value.base64.length;start+=size){
  const stop=Math.min(start+size,value.base64.length)
  for(let i=start;i<Math.min(stop,end);i++)if(digit(value.base64.charCodeAt(i))<0)throw Error('invalid')
  const raw=atob(value.base64.slice(start,stop));if(offset+raw.length>bytes.length)throw Error('invalid')
  for(let i=0;i<raw.length;i++)bytes[offset+i]=raw.charCodeAt(i)
  offset+=raw.length
 }
 if(offset!==bytes.length)throw Error('invalid')
 return{byteLength:value.byteLength,sha256:value.sha256,bytes}
}
const worker=self as unknown as {onmessage:((event:MessageEvent<ArrayBuffer|{file:Blob}>)=>void)|null;postMessage:(value:unknown,transfer:Transferable[])=>void}
function parse(buffer:ArrayBuffer,packetHash?:string){
 try{
  if(!buffer.byteLength||buffer.byteLength>96*MiB)throw Error('invalid')
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer))
  if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.resources)||value.resources.length>256)throw Error('invalid')
  let total=0;for(const resource of value.resources){if(!resource||!Number.isSafeInteger(resource.byteLength)||resource.byteLength<1||resource.byteLength>8*MiB||(total+=resource.byteLength)>16*MiB)throw Error('invalid')}
  const canonical=decode(value.canonical,48*MiB),state=decode(value.state,8*MiB),resources=value.resources.map((resource:unknown)=>decode(resource,8*MiB))
  value.canonical=canonical;value.state=state;value.resources=resources
  worker.postMessage({ok:true,value,...(packetHash?{packetHash}:{})},[canonical.bytes.buffer,state.bytes.buffer,...resources.map((item:{bytes:Uint8Array})=>item.bytes.buffer)])
 }catch{worker.postMessage({ok:false},[])}
}
worker.onmessage=event=>{
 if(event.data instanceof ArrayBuffer){parse(event.data);return}
 const request=event.data
 if(!request||typeof request!=='object'||Object.keys(request).join(',')!=='file'||!(request.file instanceof Blob)||!request.file.size||request.file.size>96*MiB){worker.postMessage({ok:false},[]);return}
 // Blob/File structured cloning shares immutable backing storage. The large
 // JSON buffer, decoding and package digest are all owned by this worker.
 void request.file.arrayBuffer().then(async buffer=>{
  if(buffer.byteLength!==request.file.size)throw Error('invalid')
  const digest=await crypto.subtle.digest('SHA-256',buffer)
  parse(buffer,Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join(''))
 }).catch(()=>worker.postMessage({ok:false},[]))
}
