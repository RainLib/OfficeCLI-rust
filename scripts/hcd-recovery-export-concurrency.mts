/** Isolated native-service resource-read verification; never use production. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {api,archiveNodeResourceBytes,readNodeResourceBytes,type Session} from '../examples/hdoc/editor/src/api.ts'
import {createSemanticRecoveryArchive,openSemanticRecoveryArchive,type RecoveryScope} from '../examples/hdoc/editor/src/semanticRecoveryArchive.ts'
import {httpRecoveryVerifier,recoveryHash} from '../examples/hdoc/editor/src/semanticRecoveryTransfer.ts'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2]??'')
assert.equal(dirname(root),repo+'/target/hcd-preview-runtime');assert.ok(root.split('/').at(-1)!.startsWith('hcd-workbook-'))
const config=JSON.parse(await readFile(root+'/resource-private.json','utf8')),session:Session={documentId:'resource-reuse',format:'docx',scope:'write',token:config.writer,apiUrl:config.apiUrl}
const signal=AbortSignal.timeout(45000),manifest=await(await api(session,'',{signal})).json(),scope:RecoveryScope={documentId:session.documentId,epoch:0,model:'structure3',revision:manifest.revision,rootHash:manifest.rootHash}
const canonical=new Uint8Array(await(await api(session,`/export/hcdz?revision=${scope.revision}`,{signal})).arrayBuffer()),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema)
const content=Array.from({length:6},(_,i)=>{const bytes=new Uint8Array(256*1024);for(let j=0;j<bytes.length;j++)bytes[j]=(j*17+i*37)&255;return bytes}),resources=[]
try{
 for(let i=0;i<content.length;i++)resources.push(await archiveNodeResourceBytes(session,{bytes:content[i],name:`file-${i}.bin`,key:'file',mediaType:'application/octet-stream',expectedHash:await recoveryHash(content[i]),signal}))
 const nodes=resources.map((item,i)=>schema.nodeFromJSON({type:'hcdExtensionInline',attrs:{extension:{schemaVersion:'hcd.extension/2',instanceId:`x_${(i+1).toString(16).padStart(32,'0')}`,type:'example.file',version:1,display:'inline',data:{},fallback:{text:'file'},resources:[item]}}}))
 store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,nodes)]))
 async function profile(serial:boolean){
  let active=0,peak=0,reads=0,tail=Promise.resolve();const start=performance.now()
  const packet=await createSemanticRecoveryArchive({scope,document,schema,canonical,verifyCanonical:httpRecoveryVerifier(session,signal),pendingFiles:[],signal,readResource:async(resource,batchSignal)=>{
   let release=()=>{};if(serial){const previous=tail;tail=new Promise<void>(resolve=>{release=resolve});await previous}
   active++;reads++;peak=Math.max(peak,active);try{batchSignal.throwIfAborted();const bytes=await readNodeResourceBytes(session,resource,undefined,batchSignal);await new Promise<void>((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(batchSignal.reason)},timer=setTimeout(()=>{batchSignal.removeEventListener('abort',cancel);resolve()},100);batchSignal.addEventListener('abort',cancel,{once:true})});return bytes}finally{active--;release()}
  }})
  return{packet,reads,peak,elapsed:Math.round(performance.now()-start)}
 }
 const parallel=await profile(false),serial=await profile(true),packet=parallel.packet,opened=await openSemanticRecoveryArchive(packet,{scope,schema,verifyCanonical:httpRecoveryVerifier(session,signal)})
 try{for(let i=0;i<resources.length;i++)assert.deepEqual(opened.resources.get(resources[i].hash),content[i])}finally{opened.dispose()}
 assert.equal(parallel.reads,6);assert.equal(parallel.peak,4);assert.equal(serial.reads,6);assert.equal(serial.peak,1);assert.deepEqual(parallel.packet,serial.packet);const after=await(await api(session,'',{signal})).json();assert.equal(after.rootHash,manifest.rootHash);assert.equal(after.revision,manifest.revision)
 console.log(JSON.stringify({scope:'isolated native service with artificial 100 ms read latency',resources:parallel.reads,bytesPerResource:content[0].length,peakConcurrent:parallel.peak,parallelElapsedMs:parallel.elapsed,serialElapsedMs:serial.elapsed,packetBytes:packet.length,identicalPackets:true,byteReadback:true,revisionUnchanged:true}))
}finally{document.destroy()}
