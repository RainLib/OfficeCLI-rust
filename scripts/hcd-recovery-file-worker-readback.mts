/** Actual Node worker thread runs the production browser codec. This is not
 * browser file-picker, main-page interaction or performance acceptance. */
import assert from 'node:assert/strict'
import {Worker as NodeWorker} from 'node:worker_threads'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {build} from '../examples/hdoc/editor/node_modules/esbuild/lib/main.js'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {schemaExtensions} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/SemanticStructureIdentity.ts'
import {SemanticInlineContainerNode} from '../examples/hdoc/editor/src/semanticInlineNode.ts'
import {parseSemanticRecoveryFileAsync} from '../examples/hdoc/editor/src/semanticRecoveryArchive.ts'
import {httpRecoveryVerifier} from '../examples/hdoc/editor/src/semanticRecoveryTransfer.ts'
import {inlineProtocol} from '../examples/hdoc/editor/src/collaborationProtocol.ts'

const root=resolve(process.argv[2]??''),out=resolve(process.argv[3]??''),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
assert.equal(config.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/hcd-inline-editor-[^/]+$/)
const source=resolve('examples/hdoc/editor/src/semanticRecoveryParseWorker.ts'),compiled=join(root,'recovery-codec.cjs')
await build({entryPoints:[source],outfile:compiled,bundle:true,platform:'node',format:'cjs',target:'node22'})
let threads=0,mainReads=0,terminated=0
class ThreadWorker{
 onmessage:((event:{data:unknown})=>void)|null=null;onerror:((error:unknown)=>void)|null=null;onmessageerror:((error:unknown)=>void)|null=null
 thread:NodeWorker
 constructor(){
  threads++
  this.thread=new NodeWorker(`const {parentPort}=require('node:worker_threads');globalThis.self={onmessage:null,postMessage:(value,transfer)=>parentPort.postMessage(value,transfer)};require(${JSON.stringify(compiled)});parentPort.on('message',data=>self.onmessage({data}));`,{eval:true,execArgv:[]})
  this.thread.on('message',data=>this.onmessage?.({data}));this.thread.on('error',error=>this.onerror?.(error));this.thread.on('messageerror',error=>this.onmessageerror?.(error))
 }
 postMessage(value:unknown,transfer?:Transferable[]){this.thread.postMessage(value,transfer as never)}
 terminate(){terminated++;void this.thread.terminate()}
}
const previous=globalThis.Worker
globalThis.Worker=ThreadWorker as unknown as typeof Worker
const session={documentId:'inline-native',scope:'read' as const,format:'html',token:config.tokens.reader,apiUrl:`http://127.0.0.1:${config.ports[0]}/v1/documents`,collaborationEpoch:0,collaborationProtocol:inlineProtocol},signal=new AbortController().signal
const head=async()=>{const response=await fetch(`${session.apiUrl}/inline-native`,{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(response.status,200);return(await response.json()).revision}
try{
 const packet=await readFile(join(root,'large-files.hcd-recovery')),expected=JSON.parse(await readFile(join(root,'large-files.json'),'utf8')),before=await head(),file=new Blob([packet]),hash=createHash('sha256').update(packet).digest('hex')
 file.arrayBuffer=async()=>{mainReads++;throw Error('whole-file main-thread fallback forbidden')}
 const parsed=await parseSemanticRecoveryFileAsync(file,signal);assert.equal(parsed.packetHash,hash);assert.equal(hash,expected.packetHash)
 const schema=getSchema([...schemaExtensions,SemanticStructureIdentity,SemanticInlineContainerNode]),candidate=await parsed.open({scope:parsed.scope,schema,signal,verifyCanonical:httpRecoveryVerifier(session,signal)})
 const recovered=[]
 try{
  assert.equal(candidate.pendingFiles.length,2)
  for(const item of candidate.pendingFiles){const actual=createHash('sha256').update(item.bytes).digest('hex');assert.equal(actual,item.resource.hash);assert.equal(actual,expected.files.find((value:any)=>value.name===item.resource.name).hash);assert.equal(item.bytes.length,6*1024*1024);recovered.push({name:item.resource.name,bytes:item.bytes.length,hash:actual})}
 }finally{candidate.dispose()}
 const damaged=JSON.parse(packet.toString());damaged.resources[0].base64=(damaged.resources[0].base64[0]==='A'?'B':'A')+damaged.resources[0].base64.slice(1)
 const damagedFile=new Blob([JSON.stringify(damaged)]);damagedFile.arrayBuffer=async()=>{mainReads++;throw Error('whole-file main-thread fallback forbidden')}
 const rejected=await parseSemanticRecoveryFileAsync(damagedFile,signal)
 await assert.rejects(rejected.open({scope:rejected.scope,schema,signal,verifyCanonical:httpRecoveryVerifier(session,signal)}),/semantic-recovery-integrity/)
 assert.equal(await head(),before);assert.equal(mainReads,0);assert.equal(threads,2);assert.equal(terminated,2)
 const evidence={scope:'Real Node worker thread executing bundled production codec, real local canonical verifier, actual synthetic file bytes; not browser UI/performance',revisionUnchanged:before,packetBytes:packet.length,packetHash:hash,workerThreads:threads,workerTerminated:terminated,mainWholeFileReadsDuringParsing:mainReads,independentResourceHashes:true,damagedResourceRejected:true,files:recovered,codecSourceHash:createHash('sha256').update(await readFile(source)).digest('hex')}
 await writeFile(join(out,'worker-readback.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence))
}finally{globalThis.Worker=previous}
