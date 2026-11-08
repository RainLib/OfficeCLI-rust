/** Owned loopback fixture fault gate. Never loaded by the editor product. */
import {createServer,request as upstreamRequest} from 'node:http'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2])
if(dirname(root)!==repo+'/target/hcd-preview-runtime'||!root.split('/').at(-1).startsWith('hcd-inline-editor-'))throw Error('owned inline fixture required')
const config=JSON.parse(await readFile(root+'/private.json','utf8')),native=`http://127.0.0.1:${config.ports[0]}`
let hold=false,waiting=null,uploads=0,failed=0
function forward(request,response,body){
 const target=upstreamRequest(new URL(request.url,native),{method:request.method,headers:{...request.headers,host:new URL(native).host}},result=>{response.writeHead(result.statusCode,{...result.headers,'Access-Control-Allow-Origin':'*'});result.pipe(response)})
 target.on('error',()=>{if(!response.headersSent)response.writeHead(503);response.end()});response.on('close',()=>target.destroy())
 if(body)target.end(body);else request.pipe(target)
}
const server=createServer(async(request,response)=>{
 response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','*');response.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS')
 if(request.method==='OPTIONS'){response.writeHead(204);response.end();return}
 if(request.url?.startsWith('/__')){
  if(request.url==='/__hold')hold=true
  else if(request.url==='/__fail'){const entry=waiting;waiting=null;hold=false;if(entry){failed++;entry.response.writeHead(503);entry.response.end('owned transport failure')}}
  else if(request.url==='/__release'){const entry=waiting;waiting=null;hold=false;if(entry&&!entry.response.destroyed)forward(entry.request,entry.response,entry.body)}
  response.setHeader('Content-Type','application/json');response.end(JSON.stringify({holding:hold,waiting:!!waiting,bytes:waiting?.body.length??0,uploads,failed}));return
 }
 if(request.method!=='POST'||!request.url?.includes('/resources?')){forward(request,response);return}
 uploads++;if(!hold){forward(request,response);return}
 try{
  const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>8*1024*1024)throw Error('resource limit');chunks.push(chunk)}
  if(waiting){response.writeHead(409);response.end();return}
  waiting={request,response,body:Buffer.concat(chunks)}
  response.on('close',()=>{if(waiting?.response===response)waiting=null})
 }catch{response.writeHead(503);response.end()}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin=`http://127.0.0.1:${server.address().port}`
let html=await readFile(root+'/editor/inline-writer.html','utf8')
const needle='"apiUrl": "/v1/documents"';if(!html.includes(needle))throw Error('owned page has unexpected API scope')
html=html.replace(needle,'"apiUrl": "'+origin+'/v1/documents"')
await writeFile(root+'/editor/inline-resources-writer.html',html)
const result={origin,page:`http://127.0.0.1:${config.ports[2]}/inline-resources-writer.html`};await writeFile(root+'/inline-resource-proxy.json',JSON.stringify(result)+'\n');console.log(JSON.stringify(result))
const close=()=>{waiting?.response.destroy();server.closeAllConnections();server.close(()=>process.exit(0))};process.once('SIGTERM',close);process.once('SIGINT',close)
