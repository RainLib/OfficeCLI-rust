/** Real native API proof. Only an explicitly named owned workbook fixture. */
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {stageRecoveryResource,recoveryHash} from '../examples/hdoc/editor/src/semanticRecoveryTransfer.ts'
import {api,type Session} from '../examples/hdoc/editor/src/api.ts'
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2]),output=resolve(process.argv[3])
assert.equal(dirname(root),repo+'/target/hcd-preview-runtime');assert.ok(root.split('/').at(-1)!.startsWith('hcd-workbook-'))
const config=JSON.parse(await readFile(root+'/resource-private.json','utf8')),session:Session={documentId:'resource-reuse',format:'docx',scope:'write',token:config.writer,apiUrl:config.apiUrl}
const manifest=await(await api(session,'')).json(),bytes=new Uint8Array(await readFile(root+'/canonical-resource.png'))
const resource={key:'image',hash:await recoveryHash(bytes),byteLength:bytes.byteLength,name:'canonical.png',mediaType:'image/png'}
const original=globalThis.fetch,requests:Array<{method:string;path:string}>=[]
globalThis.fetch=async(input,init)=>{requests.push({method:init?.method??'GET',path:new URL(String(input)).pathname});return original(input,init)}
try{
 for(let n=0;n<2;n++)await stageRecoveryResource(session,resource,bytes,new AbortController().signal)
 assert.equal(requests.filter(value=>value.path.endsWith('/resources/reuse')).length,2)
 assert.equal(requests.filter(value=>value.path.endsWith('/resources')).length,0)
 assert.equal(Buffer.from(await(await api(session,`/staged-assets/${resource.hash}`)).arrayBuffer()).equals(Buffer.from(bytes)),true)
 const staged=new TextEncoder().encode('Pending attachment must retain its staging lease'),pending={...resource,key:'pending',name:'pending.txt',mediaType:'text/plain',hash:await recoveryHash(staged),byteLength:staged.length}
 for(let n=0;n<2;n++)await stageRecoveryResource(session,pending,staged,new AbortController().signal)
 assert.equal(requests.filter(value=>value.path.endsWith('/resources/reuse')).length,4)
 assert.equal(requests.filter(value=>value.path.endsWith('/resources')).length,1)
 const head=await(await api(session,'')).json();assert.equal(head.revision,manifest.revision);assert.equal(head.rootHash,manifest.rootHash)
 const result={canonicalReuse:{repins:2,archivePosts:0},unpublishedResource:{repins:2,archivePosts:1,reason:'first upload followed by re-pinning'},revision:head.revision,canonicalRootUnchanged:true,canonicalBytesHash:resource.hash,requests}
 await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{globalThis.fetch=original}
