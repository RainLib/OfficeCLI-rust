import {nativeRecoveryVerifier} from './semanticRecoveryFileVerifier.ts'
/** File verification hook intentionally invokes the bounded native HCDZ reader.
 * No arbitrary archive path, secret or authority is copied into the transport. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {schemaExtensions} from '../src/schema.ts'
import {SemanticInlineContainerNode} from '../src/semanticInlineNode.ts'
import {SemanticStructureIdentity} from '../src/semanticStructureIdentity.ts'
import {createSemanticRecoveryArchive,openSemanticRecoveryArchive,type RecoveryScope} from '../src/semanticRecoveryArchive.ts'
import {NodeExtensionRegistry} from '../src/extensionRegistry.ts'
import {deletionReviews} from '../src/deletionReview.ts'

const [configPath,phase]=process.argv.slice(2),config=JSON.parse(await readFile(configPath,'utf8')),schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity]),hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const verifyRecoveryCanonical=nativeRecoveryVerifier(config)
const scope:RecoveryScope=config.recoveryScope,output=join(config.root,'pending-collaboration.hcd-recovery')
if(phase==='archive'){
 const doc=new Y.Doc({gc:false});Y.applyUpdate(doc,new Uint8Array(await readFile(join(config.root,'lost-state.yjs'))))
 try{
  const original=new TextEncoder().encode('未完成资源 original bytes 😀'),resource={key:'r_pending',hash:hash(original),byteLength:original.length,name:'待归档.txt',mediaType:'text/plain'},registry=new NodeExtensionRegistry([{type:'example.pending',version:1,display:'inline',label:'Pending',defaultData:{},validate:()=>true,fallback:()=> 'Pending file target'}]),expected=registry.create('example.pending'),pendingFiles=[{version:1 as const,id:crypto.randomUUID(),regionId:'body',expected,resource,bytes:original,phase:'chosen' as const}]
  let reads=0,requests=0;const bytes=await createSemanticRecoveryArchive({scope,document:doc,schema,canonical:new Uint8Array(await readFile(join(config.root,'recovery-canonical.hcdz'))),verifyCanonical:verifyRecoveryCanonical,pendingFiles,readResource:async resource=>{reads++;requests++;let response=await fetch(config.apiUrl+'/staged-assets/'+resource.hash,{headers:{Authorization:`Bearer ${config.bob}`}});if(response.status===404){requests++;response=await fetch(config.apiUrl+'/assets/'+resource.hash+'?revision=9',{headers:{Authorization:`Bearer ${config.bob}`}})}assert.equal(response.status,200);return new Uint8Array(await response.arrayBuffer())}})
  await writeFile(output,bytes);assert.equal(reads,2);for(const credential of [config.secret,config.service,config.alice,config.bob,config.reader])assert.equal(new TextDecoder().decode(bytes).includes(credential),false)
  const packet=JSON.parse(new TextDecoder().decode(bytes));assert.equal(packet.resources.length,3);assert.equal(packet.pendingFiles[0].bytes,undefined);await writeFile(join(config.root,'recovery-archive-create.json'),JSON.stringify({scope:'Portable candidate only; native verifier required and no automatic room merge',bytes:bytes.length,sha256:hash(bytes),resources:3,resourceLoads:reads,httpResourceRequests:requests,pendingOriginalByteLength:original.length,credentialsNotIncluded:true,canonicalRevision:9},null,2)+'\n')
 }finally{doc.destroy()}
}else{
 const packet=await openSemanticRecoveryArchive(new Uint8Array(await readFile(output)),{scope,schema,verifyCanonical:verifyRecoveryCanonical})
 try{const groups=deletionReviews(packet.store);assert.equal(groups.length,1);assert.match(groups[0].node.textContent,/迟到删除正文😀 /);assert.equal(packet.resources.size,3);assert.equal(packet.pendingFiles.length,1);assert.equal(new TextDecoder().decode(packet.pendingFiles[0].bytes),'未完成资源 original bytes 😀');const uncommitted=JSON.parse(await readFile(join(config.root,'uncommitted-resource.json'),'utf8'));assert.equal(new TextDecoder().decode(packet.resources.get(uncommitted.hash)),'已上传未提交 attachment bytes 😀');assert.equal(packet.store.project().textContent.includes('迟到删除正文😀'),false);await writeFile(join(config.root,'recovery-archive-offline.json'),JSON.stringify({scope:'Separate process with no network calls; canonical HCDZ validated by native reader, state opened as an isolated candidate',deletionReviews:1,hiddenBodyAndPropertyRetained:true,pendingOriginalBytesExact:true,uncommittedNodeResourceBytesExact:true,resourcesVerified:3,roomJoined:false,canonicalRevision:packet.scope.revision},null,2)+'\n')}
 finally{packet.dispose()}
}
console.log(`PASS ${phase}: canonical HCDZ + pending Yjs review + verified resources and uncompleted file bytes`)
