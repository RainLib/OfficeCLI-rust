import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer,type RequestListener} from 'node:http'
import type {AddressInfo} from 'node:net'
import {createHttpAiProvider} from './ai/http.ts'
import {AiError} from './ai/core.ts'
import type {AiRequest} from './ai/types.ts'
const request:AiRequest={version:'hcd-ai/1',requestId:'fixture',action:'rewrite',mode:'replace',instruction:'',documentId:'test',format:'docx',revision:0,locale:'zh-CN',source:{text:'Original',digest:'hash'},before:'',after:''}
async function server(handler:RequestListener,run:(url:string)=>Promise<void>){const server=createServer(handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));try{await run(`http://127.0.0.1:${(server.address()as AddressInfo).port}`)}finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}}
test('HTTP provider parses split UTF8 NDJSON; request IDs and authenticated host headers are retained',async()=>{
 await server((incoming,response)=>{assert.equal(incoming.headers['idempotency-key'],'fixture');assert.equal(incoming.headers.authorization,'Bearer fixture-only');const bytes=Buffer.from(JSON.stringify({version:'hcd-ai/1',requestId:'fixture',seq:0,type:'delta',text:'验证😀'})+'\n'+JSON.stringify({version:'hcd-ai/1',requestId:'fixture',seq:1,type:'done'})+'\n');response.writeHead(200,{'Content-Type':'application/x-ndjson'});response.write(bytes.subarray(0,bytes.length-9));response.end(bytes.subarray(bytes.length-9))},async url=>{
  const events=[];for await(const event of await createHttpAiProvider({url:url+'/ai',baseUrl:url,headers:()=>({Authorization:'Bearer fixture-only'})}).generate(request,{signal:new AbortController().signal}))events.push(event)
  assert.equal(events.length,2);assert.equal(events[0].type,'delta');assert.equal(events[1].type,'done')
 })
})
test('transport rejects cross-origin defaults, redirect, wrong content type, malformed UTF8, oversized lines and denied access',async()=>{
 const denied=(code:string)=>(error:unknown)=>error instanceof AiError&&error.code===code
 async function drain(provider:ReturnType<typeof createHttpAiProvider>){for await(const event of await provider.generate(request,{signal:new AbortController().signal}))void event}
 await assert.rejects(()=>drain(createHttpAiProvider({url:'https://example.invalid/api',baseUrl:'http://localhost'})),denied('unavailable'))
 for(const mode of ['redirect','html','utf8','limit','denied']as const)await server((_,response)=>{
  if(mode==='redirect'){response.writeHead(302,{Location:'/again'});response.end();return}
  if(mode==='denied'){response.writeHead(403);response.end('secret diagnostic');return}
  response.writeHead(200,{'Content-Type':mode==='html'?'text/html':'application/x-ndjson'});response.end(mode==='utf8'?Buffer.from([0xff]):mode==='limit'?'x'.repeat(65537):'<html>secret diagnostic</html>')
 },async url=>{await assert.rejects(()=>drain(createHttpAiProvider({url,baseUrl:url})),denied(mode==='denied'?'denied':mode==='redirect'?'network':mode==='limit'?'limit':'protocol'))})
})
