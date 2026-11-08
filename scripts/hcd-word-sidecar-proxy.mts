/** Isolated fault proxy. Never log authorization headers or document bodies. */
import {createServer} from 'node:http'
export async function nativeCheckpointProxy(origin:string){
 let armed=false,dropped=false,posts=0,layoutArmed=false,layoutDropped=false,layoutPosts=0
 const server=createServer(async(request,response)=>{
  try{
   const checkpoint=request.method==='POST'&&request.url?.endsWith('/word/checkpoints');if(checkpoint)posts++;const layout=request.method==='POST'&&request.url?.endsWith('/word/layout-transactions');if(layout)layoutPosts++
   const parts:Buffer[]=[];let size=0;for await(const part of request){const bytes=Buffer.from(part);size+=bytes.length;if(size>16*1024*1024)throw Error('fixture request limit');parts.push(bytes)}
   const headers=new Headers();for(const[key,value]of Object.entries(request.headers))if(value!==undefined&&!['host','content-length','connection','transfer-encoding'].includes(key))headers.set(key,Array.isArray(value)?value.join(', '):value)
   const native=await fetch(origin+request.url,{method:request.method,headers,body:request.method==='GET'||request.method==='HEAD'?undefined:Buffer.concat(parts)}),bytes=await native.arrayBuffer()
   if(layout&&layoutArmed&&native.ok){layoutArmed=false;layoutDropped=true;response.socket!.destroy();return}
   if(checkpoint&&armed&&native.ok){armed=false;dropped=true;response.socket!.destroy();return}
   response.writeHead(native.status,Object.fromEntries([...native.headers].filter(([key])=>!['content-length','connection','transfer-encoding','content-encoding'].includes(key))));response.end(Buffer.from(bytes))
  }catch{if(!response.destroyed){response.writeHead(502);response.end('isolated fixture transport unavailable')}}
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 return{origin:`http://127.0.0.1:${(server.address() as {port:number}).port}`,arm:()=>{armed=true},dropped:()=>dropped,posts:()=>posts,armLayout:()=>{layoutArmed=true},layoutDropped:()=>layoutDropped,layoutPosts:()=>layoutPosts,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}}
}
