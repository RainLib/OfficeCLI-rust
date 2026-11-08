/** Verify re-pinning shared image bytes against an owned local service. */
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {api,archiveNodeResource,type Session} from '../examples/hdoc/editor/src/api.ts'
import {readFixedPortableAsset} from '../examples/hdoc/editor/src/fixedPortableAssets.ts'
import {stageRecoveryResource} from '../examples/hdoc/editor/src/semanticRecoveryTransfer.ts'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2]),output=resolve(process.argv[3])
assert.equal(dirname(root),repo+'/target/hcd-preview-runtime');assert.ok(root.split('/').at(-1)!.startsWith('hcd-workbook-'))
const config=JSON.parse(await readFile(root+'/private.json','utf8')),session:Session={documentId:'book',format:'pptx',scope:'write',token:config.tokens.alice,apiUrl:`http://127.0.0.1:${config.ports[0]}/v1/documents`}
const signal=new AbortController().signal,initial=await(await api(session,'')).json(),page=await(await api(session,'/images')).json(),hash=page.entries[0].assetHash,bytes=await readFixedPortableAsset(session,hash,signal)
await archiveNodeResource(session,{file:new Blob([bytes],{type:'application/octet-stream'}),name:'file.bin',key:'file',signal,reuseExisting:true,expectedHash:hash})
const before=await api(session,`/staged-assets/${hash}`);assert.equal(before.headers.get('content-type'),'application/octet-stream')
await stageRecoveryResource(session,{key:'picture',name:'picture.png',hash,byteLength:bytes.length,mediaType:'image/png'},bytes,signal)
const after=await api(session,`/staged-assets/${hash}`);assert.equal(after.headers.get('content-type'),'image/png');assert.equal(after.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(new Uint8Array(await after.arrayBuffer()),bytes)
const head=await(await api(session,'')).json();assert.equal(head.revision,initial.revision);assert.equal(head.rootHash,initial.rootHash)
const result={scope:'owned native service, source image also referenced as generic file',before:'application/octet-stream',after:'image/png',nosniff:true,exactBytes:true,revision:head.revision,rootUnchanged:true}
await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
