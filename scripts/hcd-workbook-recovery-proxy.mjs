/** Transport faults for an owned workbook fixture, never product code. */
import {createServer,request as upstreamRequest} from 'node:http'
import {connect} from 'node:net'
import {readFile,appendFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2])
if(dirname(root)!==repo+'/target/hcd-preview-runtime'||!root.split('/').at(-1).startsWith('hcd-workbook-'))throw Error('owned workbook fixture required')
const config=JSON.parse(await readFile(root+'/private.json','utf8')),native=`http://127.0.0.1:${config.ports[0]}`,modes=new Map(),log=[],delayed=new Set()
const server=createServer(async(request,response)=>{
 const url=new URL(request.url,'http://fixture'),user=Object.keys(config.tokens).find(user=>request.headers.authorization===`Bearer ${config.tokens[user]}`)
 const origin=request.headers.origin,allowedOrigins=[`http://127.0.0.1:${config.ports[2]}`,`http://localhost:${config.ports[2]}`]
 if(origin&&allowedOrigins.includes(origin)){response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-HCD-Flow-Layout-Version, X-HCD-Node-Edits-Version, X-HCD-Custom-Marks-Version, X-HCD-Inline-Containers-Version, X-HCD-Extension-Version, X-HCD-Collaboration-Epoch, X-HCD-Collaboration-Protocol');response.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');response.setHeader('Vary','Origin')}
 if(request.method==='OPTIONS'&&origin&&allowedOrigins.includes(origin)){response.writeHead(204);response.end();return}
 if(url.pathname.startsWith('/__fixture/')){
  const selected=url.searchParams.get('user'),mode=url.searchParams.get('mode')
  if(url.pathname.endsWith('/control')&&request.method==='POST'&&Object.hasOwn(config.tokens,selected)&&['online','offline','lost','grid-lost','grid-offline','stage-offline','stage-lost','source-lost','proof-lost','proof-lost-draft','asset-stall','chunks-offline','chunks-delay','revoked','auth-offline','head-offline','capability-offline','capability-oversize'].includes(mode)){modes.set(selected,mode);if(mode==='chunks-delay')delayed.delete(selected)}
  response.setHeader('Content-Type','application/json');response.end(JSON.stringify({mode:modes.get(selected)??'online',modes:Object.fromEntries(modes),log}));return
 }
 const write=request.method==='POST'&&url.pathname.endsWith('/edits'),receipt=url.pathname.endsWith('/edits/receipt'),mode=modes.get(user)??'online'
 const gridWrite=request.method==='POST'&&url.pathname.endsWith('/grid/cells'),gridReceipt=request.method==='POST'&&url.pathname.endsWith('/grid/cells/receipt')
 const delayChunk=request.method==='GET'&&url.pathname.includes('/chunks/')&&mode==='chunks-delay'&&!delayed.has(user)
 if(delayChunk)delayed.add(user)
 const entry={method:request.method,path:url.pathname,user:user??'unknown',mode,time:new Date().toISOString(),...(delayChunk?{delayChunk:true}:{})};log.push(entry);await appendFile(root+'/requests.ndjson',JSON.stringify(entry)+'\n')
 if(mode==='asset-stall'&&request.method==='GET'&&(url.pathname.includes('/staged-assets/')||url.pathname.includes('/assets/'))){response.writeHead(200,{'Content-Type':'application/octet-stream'});response.write(Buffer.from([137,80,78,71]));response.on('close',()=>{void appendFile(root+'/requests.ndjson',JSON.stringify({event:'stalled-asset-closed',user,time:new Date().toISOString()})+'\n')});return}
 if(mode==='revoked'&&(url.pathname.endsWith('/auth')||write)){response.writeHead(403);response.end('owned revoked write access');request.resume();return}
 if(mode==='auth-offline'&&(url.pathname.endsWith('/auth')||write)){response.writeHead(503);response.end('owned access check outage');request.resume();return}
 if(mode==='head-offline'&&request.method==='GET'&&url.pathname.endsWith('/head')){response.writeHead(503);response.end('owned head outage');request.resume();return}
 if(mode==='capability-offline'&&request.method==='GET'&&url.pathname.endsWith('/export-capabilities')){response.writeHead(503);response.end('owned export compatibility outage');request.resume();return}
 if(mode==='capability-oversize'&&request.method==='GET'&&url.pathname.endsWith('/export-capabilities')){response.writeHead(200,{'Content-Type':'application/json'});response.end('x'.repeat(65537));request.resume();return}
 if(request.method==='GET'&&url.pathname.includes('/chunks/')&&mode==='chunks-offline'){response.writeHead(503);response.end('owned window transport outage');request.resume();return}
 if(delayChunk)await new Promise(resolve=>setTimeout(resolve,30000))
 if(request.method==='GET'&&url.pathname.includes('/staged-assets/')&&mode==='stage-offline'){response.writeHead(404);response.end('owned missing staged image');request.resume();return}
 if(request.method==='POST'&&url.pathname.endsWith('/staged-assets')&&mode==='stage-offline'){response.writeHead(503);response.end('owned image transport outage');request.resume();return}
 if((write||receipt)&&(mode==='offline'||mode==='chunks-delay'||mode==='proof-lost-draft')){response.writeHead(503);response.end('owned transport outage');request.resume();return}
 if(receipt&&mode==='lost'){response.writeHead(503);response.end('owned receipt outage');request.resume();return}
 if((gridWrite||gridReceipt)&&mode==='grid-offline'){response.writeHead(503);response.end('owned grid transport outage');request.resume();return}
 if(gridReceipt&&mode==='grid-lost'){response.writeHead(503);response.end('owned grid receipt outage');request.resume();return}
 const target=upstreamRequest(new URL(request.url,native),{method:request.method,headers:{...request.headers,host:new URL(native).host}},result=>{
  if(write&&mode==='lost'){result.resume();result.on('end',()=>response.destroy());return}
  if(gridWrite&&mode==='grid-lost'&&result.statusCode===200){result.resume();result.on('end',()=>response.destroy());return}
  if(request.method==='POST'&&url.pathname.endsWith('/staged-assets')&&mode==='stage-lost'&&result.statusCode===200){result.resume();result.on('end',()=>{void appendFile(root+'/requests.ndjson',JSON.stringify({event:'staging-response-lost',user,status:result.statusCode,time:new Date().toISOString()})+'\n');response.destroy()});return}
  if(request.method==='POST'&&url.pathname.endsWith('/xlsx/source')&&mode==='source-lost'&&result.statusCode===200){result.resume();result.on('end',()=>{void appendFile(root+'/requests.ndjson',JSON.stringify({event:'source-response-lost',user,status:result.statusCode,time:new Date().toISOString()})+'\n');response.destroy()});return}
  if(request.method==='POST'&&url.pathname.endsWith('/xlsx/formula-audit')&&(mode==='proof-lost'||mode==='proof-lost-draft')&&result.statusCode===200){result.resume();result.on('end',()=>{void appendFile(root+'/requests.ndjson',JSON.stringify({event:'proof-response-lost',user,status:result.statusCode,time:new Date().toISOString()})+'\n');response.destroy()});return}
  if(delayChunk)response.on('finish',()=>{void appendFile(root+'/requests.ndjson',JSON.stringify({event:'delayed-chunk-finished',path:url.pathname,time:new Date().toISOString(),status:result.statusCode})+'\n')})
  response.writeHead(result.statusCode,result.headers);result.pipe(response)
 })
 target.on('error',()=>{if(!response.headersSent)response.writeHead(503);response.end()});request.pipe(target);response.on('close',()=>target.destroy())
})
server.on('upgrade',(request,socket,head)=>{
 const upstream=connect(config.ports[0],'127.0.0.1',()=>{upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${request.rawHeaders.reduce((all,item,index)=>all+(index%2?item+'\r\n':item+': '),'')}\r\n`);if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket)})
 upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy())
})
server.listen(config.ports[1],'127.0.0.1',()=>console.log('Owned workbook fault proxy ready'))
const close=()=>{server.closeAllConnections();server.close(()=>process.exit(0))};process.once('SIGTERM',close);process.once('SIGINT',close)
