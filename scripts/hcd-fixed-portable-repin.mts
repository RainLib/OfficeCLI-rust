/** Exercise recovery asset re-pinning only against an owned local fixture. */
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {api,type Session} from '../examples/hdoc/editor/src/api.ts'
import {fixedImageHash} from '../examples/hdoc/editor/src/fixedImageFiles.ts'
import {readFixedPortableAsset,repinFixedPortableAsset,stageFixedPortableAsset} from '../examples/hdoc/editor/src/fixedPortableAssets.ts'
import {repinFixedPortableAssets} from '../examples/hdoc/editor/src/fixedPortableTransfer.ts'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2]),output=resolve(process.argv[3])
assert.equal(dirname(root),repo+'/target/hcd-preview-runtime');assert.ok(root.split('/').at(-1)!.startsWith('hcd-workbook-'))
const config=JSON.parse(await readFile(root+'/private.json','utf8'))
const format=process.argv[4]??'pptx';assert.ok(format==='pptx'||format==='pdf')
const session:Session={documentId:'book',format,scope:'write',token:config.tokens.alice,apiUrl:`http://127.0.0.1:${config.ports[0]}/v1/documents`}
const initial=await(await api(session,'')).json(),page=await(await api(session,'/images')).json(),signal=new AbortController().signal
// Native PDF images can lack an HCD resource hash. Seed an unpublished image
// in this isolated fixture; do not claim it is a published PDF image resource.
const seed=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX8AAAAASUVORK5CYII=','base64'))
const hash=format==='pdf'?await fixedImageHash(seed):page.entries[0].assetHash
assert.match(hash,/^[a-f0-9]{64}$/)
if(format==='pdf')await stageFixedPortableAsset(session,hash,seed,signal)
const canonical=await readFixedPortableAsset(session,hash,signal)
const fresh=Uint8Array.from([...canonical,1,2,3]),freshHash=await fixedImageHash(fresh)
const original=globalThis.fetch,requests:Array<{method:string;path:string;status:number}>=[]
let holdBatch=false,firstHash='',release!:()=>void,ready!:()=>void;const seen=new Set<string>(),hold=new Promise<void>(resolve=>{release=resolve}),fifth=new Promise<void>(resolve=>{ready=resolve})
globalThis.fetch=async(input,init)=>{const path=new URL(String(input)).pathname;if(holdBatch&&path.endsWith('/resources/reuse')){const hash=JSON.parse(String(init?.body)).hash as string;if(!firstHash)firstHash=hash;seen.add(hash);if(seen.size===5)ready();if(hash===firstHash)await hold}const response=await original(input,init);requests.push({method:init?.method??'GET',path,status:response.status});return response}
try{
 await repinFixedPortableAsset(session,hash,canonical,signal)
 assert.deepEqual(new Uint8Array(await(await api(session,`/staged-assets/${hash}`)).arrayBuffer()),canonical)
 await repinFixedPortableAsset(session,freshHash,fresh,signal)
 await repinFixedPortableAsset(session,freshHash,fresh,signal)
 assert.equal(requests.filter(item=>item.path.endsWith('/resources/reuse')).length,3)
 assert.equal(requests.filter(item=>item.path.endsWith('/staged-assets')&&item.method==='POST').length,1)
 const batch=new Map<string,Uint8Array>()
 for(let i=0;i<6;i++){const bytes=Uint8Array.from([...canonical,16+i]);batch.set(await fixedImageHash(bytes),bytes)}
 let checks=0
 holdBatch=true
 const staging=repinFixedPortableAssets(session,[...batch.keys()],batch,signal,async()=>{const head=await(await api(session,'')).json();assert.equal(head.revision,initial.revision);checks++})
 let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([fifth,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('rolling staging did not advance')),10000)})])}finally{clearTimeout(timer);release()}
 await staging;holdBatch=false
 for(const [itemHash,bytes]of batch)assert.deepEqual(new Uint8Array(await(await api(session,`/staged-assets/${itemHash}`)).arrayBuffer()),bytes)
 assert.ok(checks>=2&&checks<=3);assert.equal(requests.filter(item=>item.path.endsWith('/resources/reuse')&&item.status!==409).length,9)
 assert.equal(requests.filter(item=>item.path.endsWith('/staged-assets')&&item.method==='POST'&&item.status===200).length,7)
 const reader={...session,scope:'read' as const,token:config.tokens.reader}
 await assert.rejects(repinFixedPortableAsset(reader,hash,canonical,signal),/403/)
 const head=await(await api(session,'')).json();assert.equal(head.revision,initial.revision);assert.equal(head.rootHash,initial.rootHash)
 const result={scope:`isolated local native API and synthetic ${format.toUpperCase()}`,initialResource:format==='pdf'?'seeded staging':'published image',initialRepinned:true,unpublishedUploadCount:1,repeatRepinned:true,batchAssets:6,batchHeadChecks:checks,fifthStartedWhileFirstHeld:true,allAssetBytesVerified:true,lockBusyResponses:requests.filter(item=>item.status===409).length,readOnlyRejected:true,revision:head.revision,rootUnchanged:true,requests}
 await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{release();globalThis.fetch=original}
