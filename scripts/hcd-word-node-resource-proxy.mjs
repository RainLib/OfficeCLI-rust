/** Local synthetic-fixture API gate. Never included in the product. */
import {createServer,request as upstreamRequest} from 'node:http'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2]);if(dirname(root)!==repo+'/target/hcd-preview-runtime')throw new Error('isolated fixture required')
const config=JSON.parse(await readFile(root+'/private.json','utf8'));let hold=false,waiting=null,uploads=0
function forward(request,response,body){const headers={...request.headers,host:new URL(config.origin).host,'content-length':String(body.length)};delete headers['transfer-encoding'];const target=upstreamRequest(new URL(request.url,config.origin),{method:request.method,headers},result=>{response.writeHead(result.statusCode,{...result.headers,'Access-Control-Allow-Origin':'*'});result.pipe(response)});target.on('error',()=>{if(!response.headersSent)response.writeHead(503,{'Access-Control-Allow-Origin':'*'});response.end()});target.end(body)}
const server=createServer(async(request,response)=>{
 response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','*');response.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');if(request.method==='OPTIONS'){response.writeHead(204);response.end();return}
 if(request.url?.startsWith('/__')){if(request.url==='/__hold')hold=true;else if(request.url==='/__drop'){waiting?.response.destroy();waiting=null;hold=false}else if(request.url==='/__fail'){if(waiting){waiting.response.writeHead(503);waiting.response.end('synthetic transport interruption')}waiting=null;hold=false}else if(request.url==='/__release'){const entry=waiting;waiting=null;hold=false;if(entry)forward(entry.request,entry.response,entry.body)}response.setHeader('Content-Type','application/json');response.end(JSON.stringify({holding:hold,waiting:!!waiting,bytes:waiting?.body.length??0,uploads}));return}
 try{const chunks=[];let length=0;for await(const chunk of request){length+=chunk.length;if(length>8*1024*1024)throw new Error('too large');chunks.push(chunk)}const body=Buffer.concat(chunks);if(request.method==='POST'&&request.url.includes('/resources?')){uploads++;if(hold){if(waiting){response.writeHead(409);response.end();return}waiting={request,response,body};return}}forward(request,response,body)}catch{response.writeHead(503);response.end()}
})
await new Promise(resolve=>server.listen(Number(process.argv[3]??0),'127.0.0.1',resolve));const port=server.address().port,origin=`http://127.0.0.1:${port}`
// Keep the exact same actor and sidecar. Only the synthetic page's API route
// changes; the device identity remains stable across its subsequent reopens.
let html=await readFile(root+'/editor/recovery-alice.html','utf8');html=html.replace('"apiUrl": "/v1/documents"','"apiUrl": "'+origin+'/v1/documents"');await writeFile(root+'/editor/node-resource-alice.html',html)
await writeFile(root+'/node-resource-proxy.json',JSON.stringify({origin,page:`http://127.0.0.1:${config.vitePort}/node-resource-alice.html`})+'\n');console.log(JSON.stringify({origin,page:`http://127.0.0.1:${config.vitePort}/node-resource-alice.html`}))
process.once('SIGINT',()=>{waiting?.response.destroy();server.close(()=>process.exit(0))})
