import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MigrationJournal} from './migrationJournal.ts'
test('a restart reuses the exact prepared ID and bytes and cannot replace an unknown job',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hcd-migration-journal-'))
 try{
  const a=new MigrationJournal(root,'http://api'),job=a.job('doc',2,7,new Uint8Array([1,2]),new Uint8Array([3,4]));await a.save(job)
  const b=new MigrationJournal(root,'http://api');assert.deepEqual(await b.load('doc'),job)
  assert.equal((await stat(join(root,b.apiHash,'doc.json'))).mode&0o777,0o600)
  await assert.rejects(b.save(b.job('doc',2,7,new Uint8Array([1,2]),new Uint8Array([5,6]))),/unresolved/)
  await b.save({...job,status:'committed',receipt:{epoch:3}});assert.equal((await a.load('doc'))!.status,'committed')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('API namespaces are separate and rejected jobs retain both original and converted bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hcd-migration-journal-'))
 try{
  const a=new MigrationJournal(root,'http://one'),b=new MigrationJournal(root,'http://two'),job=a.job('doc',0,1,new Uint8Array([1]),new Uint8Array([2]));await a.save(job)
  assert.equal(await b.load('doc'),undefined);await a.archive(job);assert.equal(await a.load('doc'),undefined)
  const archived=JSON.parse(await readFile(join(root,a.apiHash,`doc.${job.id}.rejected.json`),'utf8'));assert.equal(archived.sourceBytes,job.sourceBytes);assert.equal(archived.targetBytes,job.targetBytes)
  await assert.rejects(a.save({...job,targetBytes:'AAAA'}),/invalid/)
 }finally{await rm(root,{recursive:true,force:true})}
})
