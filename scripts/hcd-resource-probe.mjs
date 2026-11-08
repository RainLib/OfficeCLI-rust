/** Owned loopback fixture proxy. Only synthetic POST /resources can be held.
 * No browser interception, production hooks, credential logs or remote targets.
 */
import http from 'node:http'
import {readFile,appendFile} from 'node:fs/promises'
import {resolve} from 'node:path'
const [port,nativePort,ownedRoot]=process.argv.slice(2),root=resolve(ownedRoot)
if(!/^\d+$/.test(port)||!/^\d+$/.test(nativePort)||!root.includes('/target/hcd-preview-runtime/hcd-mention-preview-'))throw Error('owned local fixture required')
let ordinal=0
const control=async()=>JSON.parse(await readFile(root+'/resource-control.json','utf8'))
const record=async(id,event,extra={})=>appendFile(root+'/resource-events.jsonl',JSON.stringify({id,event,time:new Date().toISOString(),...extra})+'\n')
const release=async id=>{const until=Date.now()+120000;while(Date.now()<until){if((await control()).release>=id)return;await new Promise(r=>setTimeout(r,100))}throw Error('fixture hold deadline')}
const server=http.createServer(async(req,res)=>{
 const resource=req.method==='POST'&&/^\/v1\/documents\/mentions-docx\/resources\?extension=(bin|png|jpg|gif|webp)$/.test(req.url)
 const id=resource?++ordinal:0
 let upstream
 res.on('close',()=>{if(!res.writableEnded){upstream?.destroy();if(resource)void record(id,'clientClosed')}})
 try{
  if(req.method==='POST'&&req.url.startsWith('/v1/documents/mentions-docx/recovery/canonical/inspect?')&&(await control()).mode==='inspectOversize'){
   await record(0,'inspectOversize',{status:200});res.writeHead(200,{'Content-Type':'application/json'});res.end('x'.repeat(65537));req.resume();return
  }
  const mode=resource?(await control()).mode:'pass'
  if(resource)await record(id,'started',{mode})
  if(resource&&mode==='holdBefore')await release(id)
  if(res.destroyed)return
  if(resource&&mode==='reject'){await record(id,'rejected',{status:503});res.writeHead(503,{'Content-Type':'text/plain'});res.end('Synthetic resource transport failure');return}
  upstream=http.request({hostname:'127.0.0.1',port:Number(nativePort),path:req.url,method:req.method,headers:{...req.headers,host:`127.0.0.1:${nativePort}`}},async response=>{
   try{
    if(resource)await record(id,'nativeResponse',{status:response.statusCode})
    if(resource&&mode==='holdAfter')await release(id)
    if(res.destroyed){response.destroy();return}
    res.writeHead(response.statusCode,response.headers);response.pipe(res)
    response.on('end',()=>{if(resource)void record(id,'responseComplete')})
   }catch{response.destroy();if(!res.destroyed){res.writeHead(504);res.end('Synthetic fixture hold timed out')}}
  })
  upstream.on('error',()=>{if(!res.destroyed){res.writeHead(502);res.end('Synthetic upstream unavailable')}})
  req.pipe(upstream)
 }catch{if(!res.destroyed){res.writeHead(504);res.end('Synthetic fixture control failure')}}
})
server.listen(Number(port),'127.0.0.1')
