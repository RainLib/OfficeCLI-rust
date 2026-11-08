import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {MigrationJournal} from './migrationJournal.ts'
import {RoomMigrationGate} from './roomMigrationGate.ts'
import {SidecarMigration} from './sidecarMigration.ts'
import {legacyProtocol,structuralProtocol} from './collaborationProtocol.ts'
test('an authority outage cannot reopen an old room while publication may already have committed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hcd-sidecar-migration-test-')),gate=new RoomMigrationGate(),journal=new MigrationJournal(root,'http://api')
 let outage=false,calls=0,rollbacks=0
 const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
 const driver=new SidecarMigration(gate,journal,{
  session:async()=>{if(outage)throw new Error('authority unavailable');return{collaborationEpoch:0,collaborationProtocol:legacyProtocol}},
  prepare:async()=>{const document=new Y.Doc(),structure=new SemanticBlockStore(document,schema);structure.initialize(schema.nodes.doc.createChecked(null,schema.nodes.paragraph.createChecked()));const source=new Y.Doc();source.getMap('source').set('body','pending');const bytes=Y.encodeStateAsUpdate(source);source.destroy();return{document,structure,sourceHash:createHash('sha256').update(bytes).digest('hex'),sourceBytes:bytes,baseRevision:1,targetEpoch:1}},
  request:async(_id,_route,init)=>{calls++;if(calls===1)throw new Error('reply lost');const job=(await journal.load('doc'))!;assert.equal((init.headers as Record<string,string>)['X-HCD-Migration-Id'],job.id);return Response.json({collaborationEpoch:1,collaborationProtocol:structuralProtocol,migration:{id:job.id,stateHash:job.targetHash,sourceHash:job.sourceHash,fromEpoch:0,baseRevision:1}})},
  rollback:async()=>{rollbacks++},committed:async()=>{},
 })
 try{
  await assert.rejects(driver.negotiate('doc'),/outcome-unknown/);assert.equal(gate.blocked('doc'),true)
  outage=true;await assert.rejects(driver.negotiate('doc'),/outcome-unknown/);assert.equal(rollbacks,0);assert.equal(gate.blocked('doc'),true);assert.equal(calls,1)
  outage=false;assert.equal((await driver.negotiate('doc')).collaborationProtocol,structuralProtocol);assert.equal(gate.blocked('doc'),false);assert.equal(calls,2)
 }finally{await rm(root,{recursive:true,force:true})}
})
