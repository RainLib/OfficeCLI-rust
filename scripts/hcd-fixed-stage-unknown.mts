/** Owned local fixture: staging succeeds but its response is withheld. */
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {api,stageImageAsset,type Session} from '../examples/hdoc/editor/src/api.ts'
import {fixedImageHash} from '../examples/hdoc/editor/src/fixedImageFiles.ts'
import {readFixedPortableAsset} from '../examples/hdoc/editor/src/fixedPortableAssets.ts'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2]),output=resolve(process.argv[3])
assert.equal(dirname(root),repo+'/target/hcd-preview-runtime');assert.ok(root.split('/').at(-1)!.startsWith('hcd-workbook-'))
const config=JSON.parse(await readFile(root+'/private.json','utf8'))
const session:Session={documentId:'book',format:'pptx',scope:'write',token:config.tokens.alice,apiUrl:`http://127.0.0.1:${config.ports[0]}/v1/documents`}
const head=await(await api(session,'')).json(),images=await(await api(session,'/images')).json(),canonical=await readFixedPortableAsset(session,images.entries[0].assetHash,new AbortController().signal)
const bytes=Uint8Array.from([...canonical,...crypto.getRandomValues(new Uint8Array(16))]),hash=await fixedImageHash(bytes),original=globalThis.fetch,controller=new AbortController(),requests:string[]=[]
let withheld=false
try{
 globalThis.fetch=async(input,init)=>{
  const path=new URL(String(input)).pathname,response=await original(input,init);requests.push(`${init?.method??'GET'} ${path} ${response.status}`)
  if(!withheld&&path.endsWith('/staged-assets')&&init?.method==='POST'&&response.ok){withheld=true;void response.body?.cancel();controller.abort(new Error('simulated response loss'));return new Promise<Response>(()=>{})}
  return response
 }
 await assert.rejects(stageImageAsset(session,'png',new Blob([bytes]),controller.signal,hash),/simulated response loss/)
 assert.equal(withheld,true)
 const staged=await original(`${session.apiUrl}/book/staged-assets/${hash}`,{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(staged.status,200);assert.deepEqual(new Uint8Array(await staged.arrayBuffer()),bytes)
 await stageImageAsset(session,'png',new Blob([bytes]),new AbortController().signal,hash)
 assert.equal(requests.filter(item=>item.includes('POST /v1/documents/book/staged-assets ')).length,1)
 assert.ok(requests.some(item=>item.endsWith('/resources/reuse 200')))
 const after=await(await api(session,'')).json();assert.equal(after.revision,head.revision);assert.equal(after.rootHash,head.rootHash)
 await writeFile(output,JSON.stringify({scope:'isolated native PPTX service with response withheld by test client',stagedBeforeResponseLoss:true,retryReusedResource:true,uploadCount:1,revision:head.revision,rootUnchanged:true,requests},null,2)+'\n')
 console.log(JSON.stringify({stagedBeforeResponseLoss:true,retryReusedResource:true,uploadCount:1,revision:head.revision,rootUnchanged:true}))
}finally{globalThis.fetch=original}
