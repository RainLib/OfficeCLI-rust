import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,createHmac} from 'node:crypto'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import * as fs from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {HocuspocusProvider} from '@hocuspocus/provider'
import * as Y from 'yjs'
import {WordCheckpointJournal,wordSaveCapsule,wordStoryRequestHash,wordStoryPendingHash,type WordPendingStory} from './wordCheckpointJournal.ts'
import {RestoreJournal} from './restoreJournal.ts'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`,hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex'),secret='test-only-sidecar-secret-over-thirty-two-bytes'
async function wait(check:()=>boolean|Promise<boolean>){for(let n=0;n<200;n++){if(await check())return;await delay(50)}throw Error('sidecar test timed out')}
test('layout-aware negotiation fails closed before any legacy migration or room access',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'hcd-layout-negotiation-'));let unexpected=0,expiresAt:unknown=Math.floor(Date.now()/1000)+3600,protocol='hcd-word-regions/2'
 const backend=createServer((req,res)=>{if(req.url==='/v1/documents/doc/auth'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({scope:'write',userId:'alice',displayName:'Alice',expiresAt,collaborationEpoch:0,collaborationProtocol:protocol,coordinatedRestore:true}))}else{unexpected++;res.writeHead(500);res.end()}})
 await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));const api=`http://127.0.0.1:${(backend.address() as {port:number}).port}`,reserve=createServer();await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=(reserve.address() as {port:number}).port;await new Promise<void>(resolve=>reserve.close(()=>resolve()))
 const child=spawn(process.execPath,['--import','tsx','sidecar.ts'],{cwd:process.cwd(),env:{...process.env,HCD_API_URL:api,HCD_COLLAB_PORT:String(port),HCD_TOKEN_SECRET:secret,HCD_SIDECAR_STATE_DIR:root,HCD_WORD_ROOMS:'1'},stdio:'ignore'})
 try{await wait(async()=>{if(child.exitCode!==null)throw Error('sidecar exited');try{return(await fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(200)})).ok}catch{return false}})
  const url=`http://127.0.0.1:${port}/v1/documents/doc/collaboration/negotiate`
  const modelHeaders:Record<string,string>[]=[{},{'X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Node-Edits-Version':'7'}]
  for(const headers of modelHeaders){const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer test',...headers}});assert.equal(response.status,426);assert.equal((await response.json()).code,'word-layout-room-unavailable')}
  for(const invalid of [undefined,null,'9999999999',Math.floor(Date.now()/1000)-1]){expiresAt=invalid;const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer test'}});assert.notEqual(response.status,200);assert.notEqual((await response.json()).code,'word-layout-room-unavailable')}
  protocol='hcd-word-regions/1';expiresAt=undefined;let rejected=false;const document=new Y.Doc(),provider=new HocuspocusProvider({url:`ws://127.0.0.1:${port}?hcdNodeEdits=7&hcdWordRegions=1`,name:'doc:0:wordregions1:save5',document,token:'test',onAuthenticationFailed:()=>{rejected=true}})
  try{await wait(()=>rejected);assert.equal(provider.isSynced,false)}finally{provider.destroy();document.destroy()}
  const preflight=await fetch(url,{method:'OPTIONS'});assert.match(preflight.headers.get('access-control-allow-headers')??'',/x-hcd-word-layout-version/);assert.equal(unexpected,0)
 }finally{child.kill('SIGTERM');if(child.exitCode===null)await new Promise<void>(resolve=>child.once('exit',()=>resolve()));await new Promise<void>(resolve=>backend.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true})}
})
for(const corrupt of [false,true])test(`sidecar fences old room on story recovery; invalid signature=${corrupt}`,async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'hcd-story-sidecar-')),actor={userId:'alice',displayName:'Alice',generation:1},schema=wordRegionSchema(),doc=new Y.Doc()
 const layout={schemaVersion:'hcd-flow-layout/2' as const,evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{},headers:{default:id(2)},footers:{}}],stories:[{id:id(2),kind:'header' as const,sourcePart:'word/header1.xml'}]}
 const previous:WordRegionProjection={documentId:'doc',revision:1,flowLayout:layout,flowLayoutHash:'a'.repeat(64),blocks:[1,2].map(n=>({flowRegionId:id(n),blockId:id(n+10),blockHash:'a'.repeat(64),region:n===1?'body':'header',readOnly:false,content:{kind:'paragraph',inlines:[{text:n===1?'Body':'Header',nodeId:id(n+20)}]}}))}
 const pending:WordPendingStory={request:{documentId:'doc',transactionId:'e'.repeat(32),expectedRevision:1,baseLayoutHash:previous.flowLayoutHash,candidateHash:'f'.repeat(64),actor:{userId:'alice',displayName:'Alice'}},actor,intent:{sectionId:id(1),kind:'footer',variant:'default',expectedInheritedStoryId:null},story:{id:id(3),kind:'footer',sourcePart:'word/footer-new.xml'},blocks:[{flowRegionId:id(3),region:'footer',blockId:id(13),blockHash:'a'.repeat(64),readOnly:false,content:{kind:'paragraph',inlines:[{text:'New footer',nodeId:id(23)}]}}]}
 const next=structuredClone(previous);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push(pending.story);next.flowLayout.sections[0].footers.default=pending.story.id;next.blocks.push(...pending.blocks)
 const record={documentId:'doc',authorId:'alice',authorName:'Alice',revision:2,patchBaseRevision:1,patchId:`word-story-unlink-${pending.request.transactionId}`,patchHash:wordStoryRequestHash(pending.request),rootHash:'d'.repeat(64),structuralChange:true}
 let tip='',lineage='',api='',leaseHash='none',released=0,receipts=0
 const backend=createServer(async(req,res)=>{try{
  const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{},route=new URL(req.url!,'http://localhost').pathname.replace('/v1/documents/doc','');let data:unknown
  if(route==='/auth')data={scope:'write',userId:'alice',displayName:'Alice',expiresAt:Math.floor(Date.now()/1000)+3600,collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/1',coordinatedRestore:true}
  else if(route==='/collaboration/word-owner'){assert.equal(req.headers['x-hcd-word-story-recovery'],'1');if(body.action==='record')leaseHash=body.journalHashes.at(-1);if(body.action==='release')released++;data={version:1,epoch:0,ownerId:body.ownerId,storeId:body.storeId,leaseId:'c'.repeat(32),remainingMs:15000,journalHash:leaseHash}}
  else if(route==='/revisions')data={headRevision:2}
  else if(route==='/revisions/1')data={revision:1,rootHash:'c'.repeat(64)}
  else if(route==='/revisions/2')data=record
  else if(route==='/editor')data=previous
  else if(route==='/word/story-receipt'){
   receipts++;assert.equal(req.headers['x-hcd-word-journal-hash'],tip);assert.equal(body.pendingHash,wordStoryPendingHash(pending));assert.equal(body.apiHash,hash(api))
   const proof={schemaVersion:'hcd-word-story-receipt/1',documentId:'doc',epoch:0,coordinatorId:lineage,journalHash:tip,expectedRevision:1,revision:2,transactionId:pending.request.transactionId,requestHash:record.patchHash,pendingHash:body.pendingHash,rootHash:record.rootHash,layoutHash:next.flowLayoutHash,initialUpdateHash:body.initialUpdateHash,signature:''}
   const message=JSON.stringify(['hcd-word-story-receipt/1',hash(api),'doc',0,lineage,tip,1,2,pending.request.transactionId,record.patchHash,proof.pendingHash,record.rootHash,pending.request.baseLayoutHash,proof.layoutHash,proof.initialUpdateHash]);proof.signature=corrupt?'x'.repeat(43):createHmac('sha256',secret).update(message).digest('base64url');data={...proof,projection:next}
  }else throw Error('unexpected '+route)
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data))
 }catch(error){res.writeHead(500);res.end(String(error))}})
 await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));api=`http://127.0.0.1:${(backend.address() as {port:number}).port}`
 const reserve=createServer();await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=(reserve.address() as {port:number}).port;await new Promise<void>(resolve=>reserve.close(()=>resolve()))
 lineage=createHmac('sha256',secret).update(`word-room/1:${api}:doc:0`).digest('hex').slice(0,32)
 const journal=new WordCheckpointJournal(root,api,'doc',0,lineage,secret,true,true),model=new WordRegionStore(doc,schema,'doc',layout,previous.flowLayoutHash);model.initialize(previous)
 const base={revision:1,rootHash:'c'.repeat(64),layoutHash:previous.flowLayoutHash,digest:hash(model.contents())},initial=wordSaveCapsule(journal.scope,model,base,[actor]),start=await journal.save(initial,'none'),prepared=await journal.prepareStory(pending,start,()=>{})
 const before=model.region(id(2)),node=before[0].node;model.reconcile(id(2),before,[{key:before[0].key,node:node.type.createChecked(node.attrs,schema.text('unsaved header'))}]);const late=structuredClone(prepared.capsule);late.document=Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');tip=await journal.save(late,prepared.tip)
 const child=spawn(process.execPath,['--import','tsx','sidecar.ts'],{cwd:process.cwd(),env:{...process.env,HCD_API_URL:api,HCD_COLLAB_PORT:String(port),HCD_TOKEN_SECRET:secret,HCD_SIDECAR_STATE_DIR:root,HCD_WORD_ROOMS:'1'},stdio:'ignore'})
 let provider:HocuspocusProvider|undefined;const client=new Y.Doc()
 try{
  await wait(async()=>{if(child.exitCode!==null)throw Error('sidecar exited');try{return(await fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(200)})).ok}catch{return false}})
  provider=new HocuspocusProvider({url:`ws://127.0.0.1:${port}?hcdNodeEdits=7&hcdWordRegions=1`,name:'doc:0:wordregions1:save5',document:client,token:'test'})
  await wait(()=>released>0);const loaded=await new WordCheckpointJournal(root,api,'doc',0,lineage,secret,true,true).load();assert.ok(loaded);assert.equal(provider.isSynced,false)
  if(corrupt){assert.equal(receipts,1);assert.equal(loaded.hash,tip);assert.ok(loaded.capsule.pendingStory)}else{assert.equal(receipts,2);assert.ok(loaded.capsule.storyAcknowledgement);assert.equal(loaded.capsule.pendingStory,undefined);const restored=new Y.Doc();try{Y.applyUpdate(restored,Buffer.from(loaded.capsule.document,'base64'));const recovered=new WordRegionStore(restored,schema,'doc',next.flowLayout,next.flowLayoutHash);assert.equal(recovered.project(id(2)).textContent,'unsaved header');assert.equal(recovered.project(id(3)).textContent,'New footer')}finally{restored.destroy()}}
 }finally{provider?.destroy();client.destroy();doc.destroy();child.kill('SIGTERM');if(child.exitCode===null)await new Promise<void>(resolve=>child.once('exit',()=>resolve()));await new Promise<void>(resolve=>backend.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true})}
})
test('layout negotiate replays a prepared restore journal and answers with the rotated epoch',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'hcd-layout-recover-')),requestId='a'.repeat(32)
 let restored=false,unexpected=0
 const backend=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part))
  const route=new URL(req.url!,'http://localhost').pathname.replace('/v1/documents/doc','')
  let data:unknown
  if(route==='/auth')data={scope:'write',userId:'alice',displayName:'Alice',expiresAt:Math.floor(Date.now()/1000)+3600,collaborationEpoch:restored?1:0,collaborationProtocol:'hcd-word-regions/2',coordinatedRestore:true}
  else if(route==='/collaboration/restore/1'&&req.method==='POST'){
   const body=JSON.parse(Buffer.concat(chunks).toString())
   assert.equal(body.requestId,requestId);assert.equal(body.expectedRevision,2);assert.equal(body.fromEpoch,0)
   assert.equal(req.headers['x-hcd-word-regions-version'],'2');assert.equal(req.headers['x-hcd-word-layout-version'],'1')
   restored=true
   data={requestId,revision:body.expectedRevision+1,restoredFrom:1,collaborationEpoch:body.fromEpoch+1,collaborationProtocol:'hcd-word-regions/2'}
  }
  else{unexpected++;res.writeHead(500);res.end('unexpected '+route);return}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data))
 })
 await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));const api=`http://127.0.0.1:${(backend.address() as {port:number}).port}`
 const reserve=createServer();await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=(reserve.address() as {port:number}).port;await new Promise<void>(resolve=>reserve.close(()=>resolve()))
 // A previous process died after persisting the restore intent: the journal
 // still says prepared while native has not rotated the epoch yet, so the
 // authority read underneath negotiate reports the stale E=0.
 const journal=new RestoreJournal(root,api)
 await journal.save({version:1,documentId:'doc',target:1,request:{requestId,expectedRevision:2,fromEpoch:0,fromProtocol:'hcd-word-regions/2',sourceHash:'c'.repeat(64),authorId:'alice',authorName:'Alice'},status:'prepared'})
 const child=spawn(process.execPath,['--import','tsx','sidecar.ts'],{cwd:process.cwd(),env:{...process.env,HCD_API_URL:api,HCD_COLLAB_PORT:String(port),HCD_TOKEN_SECRET:secret,HCD_SIDECAR_STATE_DIR:root,HCD_WORD_ROOMS:'1',HCD_WORD_LAYOUT_ROOMS:'1'},stdio:'ignore'})
 try{
  await wait(async()=>{if(child.exitCode!==null)throw Error('sidecar exited');try{return(await fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(200)})).ok}catch{return false}})
  const response=await fetch(`http://127.0.0.1:${port}/v1/documents/doc/collaboration/negotiate`,{method:'POST',headers:{Authorization:'Bearer test','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Node-Edits-Version':'7'}})
  assert.equal(response.status,200)
  const answer=await response.json() as Record<string,unknown>
  assert.deepEqual(answer,{collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2',wordRegionVersion:2,wordLayoutVersion:1,nodeEditVersion:7})
  assert.ok(restored)
  const job=await journal.load('doc');assert.equal(job?.status,'committed');assert.equal(job?.receipt?.collaborationEpoch,1)
  assert.equal(unexpected,0)
 }finally{child.kill('SIGTERM');if(child.exitCode===null)await new Promise<void>(resolve=>child.once('exit',()=>resolve()));await new Promise<void>(resolve=>backend.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true})}
})
