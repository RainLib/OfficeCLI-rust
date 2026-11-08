import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {FixedImageFileJournal,fixedImageHash,type FixedImageChoice} from './fixedImageFiles.ts'

const name='hcd-fixed-draft-v1-'+'a'.repeat(64)+'-'+'b'.repeat(64)+'-imagefiles1'
async function choice():Promise<FixedImageChoice>{const bytes=new Uint8Array([1,2,3]);return{version:1,id:crypto.randomUUID(),name:'example.png',extension:'png',hash:await fixedImageHash(bytes),bytes,base:{nodeId:'image',visualHash:'c'.repeat(64),geometry:{x:1,y:2,width:3,height:4,unit:'pt'}},revision:4,page:0,phase:'chosen'}}
test('image choices survive reopen with exact bytes and no transient preview or credentials',async()=>{
 const factory=new IDBFactory(),first=await FixedImageFileJournal.open(name,factory),input=await choice();(input.base as any).preview='secret-url';(input as any).token='secret-token'
 try{await first.put(input);first.close();const next=await FixedImageFileJournal.open(name,factory);try{const saved=(await next.list())[0];assert.deepEqual(saved.bytes,input.bytes);assert.equal(saved.base.nodeId,'image');assert.doesNotMatch(JSON.stringify(saved),/secret/);assert.equal(saved.phase,'chosen')}finally{next.close()}}finally{first.close()}
})
test('choice and stage retain the captured bytes and target across asynchronous hashing',async()=>{
 const journal=await FixedImageFileJournal.open(name,new IDBFactory()),value=await choice(),original=Uint8Array.from(value.bytes)
 try{
  const writing=journal.put(value);value.bytes[0]=9;value.base.nodeId='changed';await writing
  const [stored]=await journal.list();assert.deepEqual(stored.bytes,original);assert.equal(stored.base.nodeId,'image')
  const staging=journal.stage(stored);stored.bytes[0]=8;stored.base.nodeId='another';const result=await staging
  assert.equal(result.phase,'staged');assert.deepEqual(result.bytes,original);assert.equal(result.base.nodeId,'image')
 }finally{journal.close()}
})
test('cancellation in another window prevents a late stage response from reviving a choice',async()=>{
 const factory=new IDBFactory(),a=await FixedImageFileJournal.open(name,factory),b=await FixedImageFileJournal.open(name,factory),value=await choice()
 try{await a.put(value);await b.finish(value.id,'cancelled');const late=await a.stage(value);assert.equal(late.phase,'cancelled');assert.equal(late.bytes.length,0);assert.deepEqual(await a.list(),[]);await assert.rejects(a.put(value),/exists/)}finally{a.close();b.close()}
})
test('invalid bytes, changed targets and over-capacity choices do not alter existing records',async()=>{
 const journal=await FixedImageFileJournal.open(name,new IDBFactory()),value=await choice()
 try{await assert.rejects(journal.put({...value,bytes:new Uint8Array([9])}),/integrity/);await journal.put(value);await assert.rejects(journal.stage({...value,base:{...value.base,nodeId:'other'}}),/changed/);await assert.rejects(journal.stage({...value,bytes:new Uint8Array([9])}),/integrity/);assert.deepEqual((await journal.list())[0].bytes,value.bytes)
  for(let i=1;i<16;i++)await journal.put(await choice());await assert.rejects(journal.put(await choice()),/limit/);assert.equal((await journal.list()).length,16)
 }finally{journal.close()}
})
test('staging is idempotent but linking never changes another target or reopens a finished choice',async()=>{
 const journal=await FixedImageFileJournal.open(name,new IDBFactory()),value=await choice()
 try{await journal.put(value);const staged=await journal.stage(value);assert.equal(staged.phase,'staged');assert.equal((await journal.stage(value)).phase,'staged');await journal.finish(value.id,'linked');assert.equal((await journal.stage(value)).phase,'linked');assert.deepEqual(await journal.list(),[])}finally{journal.close()}
})
test('portable task imports are atomic and idempotent without reviving completed choices',async()=>{
 const journal=await FixedImageFileJournal.open(name,new IDBFactory()),first=await choice(),second=await choice(),third=await choice()
 try{assert.equal(await journal.importChoices([first,second]),2);assert.equal(await journal.importChoices([first,second]),0);await journal.finish(first.id,'cancelled');assert.equal(await journal.importChoices([first]),0);assert.deepEqual((await journal.list()).map(value=>value.id),[second.id]);await assert.rejects(journal.importChoices([third,{...second,name:'changed.png'}]),/changed/);assert.deepEqual((await journal.list()).map(value=>value.id),[second.id]);await assert.rejects(journal.importChoices([{...third,bytes:new Uint8Array([9])}]),/integrity/);assert.deepEqual((await journal.list()).map(value=>value.id),[second.id])}finally{journal.close()}
})
