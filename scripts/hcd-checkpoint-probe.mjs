/** Transparent loopback-only proxy for owned checkpoint reproductions.
 * Authorization headers are forwarded but never recorded. Bounded bodies are
 * retained under the private fixture root, not published as product logs. */
import http from 'node:http'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,basename} from 'node:path'
const port=Number(process.argv[2]),target=Number(process.argv[3]),root=resolve(process.argv[4]);if(![port,target].every(n=>Number.isInteger(n)&&n>0&&n<65536)||!basename(root).startsWith('hcd-mention-preview-'))throw Error('owned checkpoint probe arguments required')
const dir=resolve(root,'checkpoint-probe');mkdirSync(dir,{recursive:true,mode:0o700});let sequence=0
const server=http.createServer((request,response)=>{
 const capture=request.method==='POST'&&/^\/v1\/documents\/[^/]+\/checkpoints$/.test(request.url??''),id=++sequence,chunks=[];let size=0
 if(capture)request.on('data',chunk=>{size+=chunk.length;if(size<=4*1024*1024)chunks.push(chunk)})
 const upstream=http.request({hostname:'127.0.0.1',port:target,path:request.url,method:request.method,headers:{...request.headers,host:`127.0.0.1:${target}`}},reply=>{
  const body=[];let bytes=0;if(capture){reply.on('data',chunk=>{bytes+=chunk.length;if(bytes<=256*1024)body.push(chunk)});reply.on('end',()=>{
   const decode=b=>{try{return JSON.parse(b.toString('utf8'))}catch{return b.toString('utf8')}}
   writeFileSync(resolve(dir,`${String(id).padStart(6,'0')}.json`),JSON.stringify({at:new Date().toISOString(),method:request.method,path:request.url,status:reply.statusCode,requestBytes:size,requestTruncated:size>4*1024*1024,request:decode(Buffer.concat(chunks)),responseBytes:bytes,responseTruncated:bytes>256*1024,response:decode(Buffer.concat(body))},null,2)+'\n',{mode:0o600})
  })}
  response.writeHead(reply.statusCode??502,reply.headers);reply.pipe(response)
 })
 upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end('owned checkpoint probe upstream unavailable')});request.on('aborted',()=>upstream.destroy());request.pipe(upstream)
});server.listen(port,'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)))
