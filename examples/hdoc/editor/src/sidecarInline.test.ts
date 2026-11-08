import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {schemaExtensions,type Projection} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {inlineRoomGuard} from './inlineRoomGuard.ts'
import {inlineRoomBootstrap} from './sidecarInline.ts'
import {MigrationJournal,validateMigrationJob} from './migrationJournal.ts'
import {RoomMigrationGate} from './roomMigrationGate.ts'
import {legacyProtocol,inlineProtocol,type CollaborationSession} from './collaborationProtocol.ts'

const schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity])
const projection:Projection={documentId:'doc',revision:8,blocks:[{blockId:'n_'+'1'.repeat(32),blockHash:'a'.repeat(64),region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text:'',content:{kind:'extension',extension:{schemaVersion:'hcd.extension/3',instanceId:'x_'+'1'.repeat(32),type:'example.field',version:1,display:'inline',contentModel:'inline',data:{},fallback:{text:'Field'}},inlines:[{text:'Canonical body'}]}}]}}]}
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'hcd-inline-bootstrap-')),journal=new MigrationJournal(root,'http://api'),gate=new RoomMigrationGate()
 let session:CollaborationSession={collaborationEpoch:0,collaborationProtocol:legacyProtocol},active=false,absent=true,lost=false,calls=0,canonicalCalls=0
 let lastHeaders:Headers|undefined,targetBytes:Uint8Array|undefined
 const host={session:async()=>session,active:()=>active,stateAbsent:async()=>absent,canonical:async()=>{canonicalCalls++;return projection},request:async(_id:string,_route:string,init:RequestInit)=>{
  calls++;lastHeaders=new Headers(init.headers);const job=(await journal.load('doc'))!;targetBytes=new Uint8Array(init.body as Uint8Array)
  const candidate=new Y.Doc({gc:false});try{Y.applyUpdate(candidate,targetBytes);const guard=inlineRoomGuard(candidate,schema);guard.destroy();assert.equal(new SemanticBlockStore(candidate,schema,undefined,{inlineContainers:true}).project().textContent,'Canonical body')}finally{candidate.destroy()}
  session={collaborationEpoch:1,collaborationProtocol:inlineProtocol}
  if(lost){lost=false;throw new Error('committed response lost')}
  return Response.json({...session,migration:{id:job.id,stateHash:job.targetHash,sourceHash:'none',fromEpoch:0,baseRevision:8}})
 }}
 return{journal,gate,host,driver:()=>inlineRoomBootstrap(gate,journal,schema,host),setActive:(v:boolean)=>{active=v},setAbsent:(v:boolean)=>{absent=v},loseReply:()=>{lost=true},calls:()=>calls,canonicalCalls:()=>canonicalCalls,headers:()=>lastHeaders,bytes:()=>targetBytes,close:()=>rm(root,{recursive:true,force:true})}
}
test('inline bootstrap uses real canonical projection and durable explicit target; reconnect does not reinitialize',async()=>{
 const f=await setup();try{
  assert.equal((await f.driver().negotiate('doc')).collaborationProtocol,inlineProtocol)
  const job=(await f.journal.load('doc'))!;assert.equal(job.targetProtocol,inlineProtocol);assert.equal(job.sourceHash,'none');assert.equal(job.sourceBytes,'');assert.equal(job.status,'committed')
  assert.equal(f.headers()!.get('X-HCD-Inline-Containers-Version'),'1');assert.equal(f.headers()!.get('X-HCD-Extension-Version'),'3')
  assert.equal((await f.driver().negotiate('doc')).collaborationEpoch,1);assert.equal(f.calls(),1);assert.equal(f.canonicalCalls(),1)
  assert.throws(()=>validateMigrationJob({...job,targetProtocol:undefined},'doc',f.journal.apiHash),/journal-invalid/)
  assert.throws(()=>validateMigrationJob({...job,sourceBytes:Buffer.from('old state').toString('base64')},'doc',f.journal.apiHash),/journal-invalid/)
 }finally{await f.close()}
})
test('lost initialization response is retried with the same bytes and id after driver restart',async()=>{
 const f=await setup();try{
  f.loseReply();await assert.rejects(f.driver().negotiate('doc'),/outcome-unknown/);assert.equal(f.gate.blocked('doc'),true)
  const prepared=(await f.journal.load('doc'))!;assert.equal(prepared.status,'prepared');const bytes=f.bytes()
  const session=await f.driver().negotiate('doc');assert.equal(session.collaborationProtocol,inlineProtocol);assert.equal(f.calls(),2);assert.deepEqual(f.bytes(),bytes);assert.equal((await f.journal.load('doc'))!.id,prepared.id);assert.equal(f.canonicalCalls(),1);assert.equal(f.gate.blocked('doc'),false)
 }finally{await f.close()}
})
for(const live of [false,true])test(`inline initialization preserves an existing ${live?'live old room':'durable draft'}`,async()=>{
 const f=await setup();try{if(live)f.setActive(true);else f.setAbsent(false);await assert.rejects(f.driver().negotiate('doc'),/inline-room-active|inline-state-exists/);assert.equal(f.calls(),0);assert.equal(f.canonicalCalls(),0);assert.equal(await f.journal.load('doc'),undefined);assert.equal(f.gate.blocked('doc'),false)}finally{await f.close()}
})
