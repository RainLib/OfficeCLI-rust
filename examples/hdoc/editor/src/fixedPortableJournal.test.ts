import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {FixedPortableJournal} from './fixedPortableJournal.ts'
import {fixedImageHash} from './fixedImageFiles.ts'
const name='hcd-fixed-draft-v1-'+'a'.repeat(64)+'-'+'b'.repeat(64)+'-portable1'
test('reviewed import is durable across restart and repeated completion never reopens it',async()=>{
 const factory=new IDBFactory(),journal=await FixedPortableJournal.open(name,factory),bytes=new TextEncoder().encode('private backup')
 const first=await journal.begin(bytes);bytes[0]=0;assert.equal(first.phase,'pending');journal.close();const reopened=await FixedPortableJournal.open(name,factory)
 try{const copies=await reopened.pending();assert.equal(copies.length,1);assert.equal(new TextDecoder().decode(copies[0].bytes),'private backup');assert.equal(await fixedImageHash(copies[0].bytes),first.id);assert.equal((await reopened.begin(copies[0].bytes)).id,first.id);await reopened.complete(first.id);await reopened.complete(first.id);assert.deepEqual(await reopened.pending(),[]);assert.equal((await reopened.begin(copies[0].bytes)).phase,'complete')}finally{reopened.close()}
})
test('pending limit and corrupt journal records fail closed without losing earlier imports',async()=>{
 const factory=new IDBFactory(),journal=await FixedPortableJournal.open(name,factory)
 try{for(const text of ['one','two','three'])await journal.begin(new TextEncoder().encode(text));await assert.rejects(journal.begin(new TextEncoder().encode('four')),/limit/);assert.equal((await journal.pending()).length,3)
  const opening=factory.open(name,1),db=await new Promise<IDBDatabase>((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error)})
  try{const entry=(await journal.pending())[0],changed={...entry,bytes:new Uint8Array([99])},tx=db.transaction('meta','readwrite'),store=tx.objectStore('meta');store.put(changed,entry.id);await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)})}finally{db.close()}
  await assert.rejects(journal.pending(),/integrity/)
 }finally{journal.close()}
})
test('discard affects only a pending archive and a completed receipt stays closed',async()=>{
 const journal=await FixedPortableJournal.open(name,new IDBFactory()),first=new TextEncoder().encode('first'),second=new TextEncoder().encode('second')
 try{const a=await journal.begin(first),b=await journal.begin(second);await journal.complete(b.id);await assert.rejects(journal.discard(b.id),/missing/);await journal.discard(a.id);assert.deepEqual(await journal.pending(),[]);assert.equal((await journal.begin(second)).phase,'complete');assert.equal((await journal.begin(first)).phase,'pending')}finally{journal.close()}
})
