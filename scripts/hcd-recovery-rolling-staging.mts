/** Read/write only a disposable workbook preview's synthetic resource document. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {applyRecoveryTransfer,recoveryHash,stageRecoveryResource,type RecoveryTransferReview} from '../examples/hdoc/editor/src/semanticRecoveryTransfer.ts'
import {semanticRecoveryResources} from '../examples/hdoc/editor/src/semanticRecoveryArchive.ts'
import {api,type Session} from '../examples/hdoc/editor/src/api.ts'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2]),output=resolve(process.argv[3])
assert.equal(dirname(root),repo+'/target/hcd-preview-runtime');assert.ok(root.split('/').at(-1)!.startsWith('hcd-workbook-'))
const config=JSON.parse(await readFile(root+'/resource-private.json','utf8')),session:Session={documentId:'resource-reuse',format:'docx',scope:'write',token:config.writer,apiUrl:config.apiUrl}
const signal=AbortSignal.timeout(45000),before=await(await api(session,'',{signal})).json(),schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
const live=new Y.Doc({gc:false}),candidate=new Y.Doc({gc:false}),merged=new Y.Doc({gc:false}),current=new SemanticBlockStore(live,schema),file=new SemanticBlockStore(candidate,schema),resources=new Map<string,Uint8Array>(),descriptors=[]
try{
 for(let i=0;i<6;i++){const bytes=new TextEncoder().encode(`Synthetic recovered attachment ${i}`),hash=await recoveryHash(bytes);resources.set(hash,bytes);descriptors.push({key:`file${i}`,hash,byteLength:bytes.length,name:`file-${i}.txt`,mediaType:'text/plain'})}
 const extension={schemaVersion:'hcd.extension/2',instanceId:'x_'+'a'.repeat(32),type:'example.file',version:1,display:'inline',data:{},fallback:{text:'Recovered files'},resources:descriptors}
 current.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,schema.text('Live'))]))
 file.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,schema.nodeFromJSON({type:'hcdExtensionInline',attrs:{extension}}))]))
 Y.applyUpdate(merged,Y.encodeStateAsUpdate(live));Y.applyUpdate(merged,Y.encodeStateAsUpdate(candidate))
 const preview={text:'',business:'',truncated:false},review:RecoveryTransferReview={candidate:{kind:'isolated-recovery-candidate',scope:{documentId:'resource-reuse',epoch:0,model:'structure3',revision:before.revision,rootHash:before.rootHash},canonical:new Uint8Array([1]),document:candidate,store:file,resources,pendingFiles:[],pendingImages:[],dispose:()=>{}},merged,stamp:await recoveryHash(Y.encodeStateAsUpdate(live)),packetHash:'a'.repeat(64),deletions:0,before:preview,after:preview,currentImageDrafts:[],recoveredImageDrafts:[],imageBaselines:null,imageDraftsIntegrated:true,dispose:()=>{}}
 let started=0,active=0,peak=0,release!:()=>void,fifth!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve}),seenFifth=new Promise<void>(resolve=>{fifth=resolve}),history=current.undoManager()
 try{
  const operation=applyRecoveryTransfer(review,{current:live,history,signal,canWrite:()=>true,authorize:async()=>{},importFiles:async()=>assert.fail('no pending files'),stageResource:async(resource,bytes,cancel)=>{const index=++started;peak=Math.max(peak,++active);if(index===5)fifth();try{if(index===1)await hold;await stageRecoveryResource(session,resource,bytes,cancel)}finally{active--}}})
  let timer:ReturnType<typeof setTimeout>|undefined
  try{await Promise.race([seenFifth,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('rolling staging did not advance')),10000)})])}finally{clearTimeout(timer)}
  assert.ok(peak<=4);release();await operation
  assert.equal(started,6);assert.equal(semanticRecoveryResources(current).length,6)
  for(const item of descriptors){const actual=new Uint8Array(await(await api(session,`/staged-assets/${item.hash}`,{signal})).arrayBuffer());assert.deepEqual(actual,resources.get(item.hash))}
  const after=await(await api(session,'',{signal})).json();assert.equal(after.revision,before.revision);assert.equal(after.rootHash,before.rootHash)
  const result={fixture:'isolated native service and synthetic resources',resourceCount:started,peakConcurrent:peak,fifthStartedWhileFirstHeld:true,stagedByteReadback:true,canonicalRevision:after.revision,canonicalRootUnchanged:true}
  await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
 }finally{release();history.destroy()}
}finally{live.destroy();candidate.destroy();merged.destroy()}
