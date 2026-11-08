// Real native HTTP verification using only the owned preview fixture.
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {archiveNodeResource,api,type Session} from '../examples/hdoc/editor/src/api.ts'
const root=resolve(process.argv[2]??'')
if(!root.includes('/target/hcd-preview-runtime/hcd-workbook-'))throw Error('owned fixture required')
const privateInfo=JSON.parse(await readFile(join(root,'resource-private.json'),'utf8'))
const session:Session={documentId:'resource-reuse',format:'docx',scope:'write',apiUrl:privateInfo.apiUrl,token:privateInfo.writer}
const original=globalThis.fetch,requests:{path:string;bodyBytes:number}[]=[]
globalThis.fetch=async(input,init)=>{
 const url=String(input),body=init?.body
 requests.push({path:new URL(url).pathname,bodyBytes:body instanceof Blob?body.size:typeof body==='string'?new TextEncoder().encode(body).length:0})
 return original(input,init)
}
try{
 const file=new Blob(['isolated attachment retry 中文'],{type:'application/octet-stream'})
 const before=await(await api(session,'')).json()
 const first=await archiveNodeResource(session,{file,name:'fixture.bin',key:'file'})
 const second=await archiveNodeResource(session,{file,name:'fixture.bin',key:'file',reuseExisting:true})
 assert.equal(first.hash,second.hash)
 const restored=await(await api(session,`/staged-assets/${first.hash}`)).arrayBuffer()
 assert.deepEqual(Buffer.from(restored),Buffer.from(await file.arrayBuffer()))
 const after=await(await api(session,'')).json();assert.equal(after.revision,before.revision)
 const uploads=requests.filter(r=>r.path.endsWith('/resources')),repins=requests.filter(r=>r.path.endsWith('/resources/reuse'))
 assert.equal(uploads.length,1);assert.equal(uploads[0].bodyBytes,file.size);assert.equal(repins.length,1)
 const result={uploads:uploads.length,repinRequests:repins.length,retryFileBytes:0,sourceSha256:first.hash,revision:after.revision,stagedBytesMatch:true}
 if(process.argv[3])await writeFile(resolve(process.argv[3]),JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify(result))
}finally{globalThis.fetch=original}
