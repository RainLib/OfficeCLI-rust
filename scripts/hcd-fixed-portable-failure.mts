/** Owned native fixture with one staged resource and injected batch failure. */
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {api,type Session} from '../examples/hdoc/editor/src/api.ts'
import {fixedImageHash} from '../examples/hdoc/editor/src/fixedImageFiles.ts'
import {readFixedPortableAsset} from '../examples/hdoc/editor/src/fixedPortableAssets.ts'
import {repinFixedPortableAssets} from '../examples/hdoc/editor/src/fixedPortableTransfer.ts'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2]),output=resolve(process.argv[3])
assert.equal(dirname(root),repo+'/target/hcd-preview-runtime');assert.ok(root.split('/').at(-1)!.startsWith('hcd-workbook-'))
const config=JSON.parse(await readFile(root+'/private.json','utf8'))
const session:Session={documentId:'book',format:'pptx',scope:'write',token:config.tokens.alice,apiUrl:`http://127.0.0.1:${config.ports[0]}/v1/documents`}
const original=globalThis.fetch,signal=new AbortController().signal,initial=await(await api(session,'')).json(),page=await(await api(session,'/images')).json()
const canonical=await readFixedPortableAsset(session,page.entries[0].assetHash,signal),resources=new Map<string,Uint8Array>()
for(let i=0;i<4;i++){const bytes=Uint8Array.from([...canonical,80+i]);resources.set(await fixedImageHash(bytes),bytes)}
const [success,fail]=[...resources.keys()].sort(),started=new Set<string>();let release!:()=>void,ready!:()=>void
const staged=new Promise<void>(resolve=>release=resolve),allStarted=new Promise<void>(resolve=>ready=resolve);let aborted=0,checks=0
globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input)),body=typeof init?.body==='string'?JSON.parse(init.body):null
 if(url.pathname.endsWith('/resources/reuse')){
  const hash=body.hash as string;started.add(hash);if(started.size===4)ready()
  if(hash===fail){await Promise.all([allStarted,staged]);return new Response('',{status:403})}
  if(hash!==success)return new Promise<Response>((_resolve,reject)=>{const requestSignal=init!.signal!;if(requestSignal.aborted){aborted++;reject(requestSignal.reason);return}requestSignal.addEventListener('abort',()=>{aborted++;reject(requestSignal.reason)},{once:true})})
 }
 const response=await original(input,init)
 if(url.pathname.endsWith('/staged-assets')&&init?.method==='POST'&&response.ok)release()
 return response
}
try{
 await assert.rejects(repinFixedPortableAssets(session,[...resources.keys()],resources,signal,async()=>{checks++}),/403/)
 assert.equal(started.size,4);assert.equal(aborted,2);assert.equal(checks,0)
 globalThis.fetch=original
 const stagedBytes=new Uint8Array(await(await api(session,`/staged-assets/${success}`)).arrayBuffer())
 assert.deepEqual(stagedBytes,resources.get(success));const head=await(await api(session,'')).json()
 assert.equal(head.revision,initial.revision);assert.equal(head.rootHash,initial.rootHash)
 const result={scope:'local native PPTX fixture; client transport injects 403 and two hanging requests',stagedResourceVerified:true,abortedRequests:aborted,headChecks:checks,revision:head.revision,rootUnchanged:true}
 await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{globalThis.fetch=original}
