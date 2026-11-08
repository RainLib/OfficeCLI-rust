import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {FixedImageFileJournal} from './fixedImageFiles.ts'
import {FixedImageFileClient} from './fixedImageFileClient.ts'

const name='hcd-fixed-draft-v1-'+'a'.repeat(64)+'-'+'b'.repeat(64)+'-imagefiles1',base={nodeId:'image',visualHash:'c'.repeat(64),geometry:{x:1,y:2,width:3,height:4,unit:'pt' as const}},file=()=>new File(['image bytes'],'image.png',{type:'image/png'})
test('image selection retains the target seen before its asynchronous file read',async()=>{
 const journal=await FixedImageFileJournal.open(name,new IDBFactory());let ready!:()=>void,release!:(value:ArrayBuffer)=>void
 const entered=new Promise<void>(resolve=>ready=resolve),wait=new Promise<ArrayBuffer>(resolve=>release=resolve)
 class SlowFile extends File{override arrayBuffer(){ready();return wait}}
 const client=new FixedImageFileClient(journal,{ready:()=>true,stage:async choice=>({hash:choice.hash}),flush:async()=>{}}),target=structuredClone(base)
 try{
  const selecting=client.choose(new SlowFile(['image'],'image.png'),target,4);await entered
  target.nodeId='different';target.geometry.width=99;release(new TextEncoder().encode('image').buffer)
  const choice=await selecting;assert.equal(choice.base.nodeId,'image');assert.equal(choice.base.geometry.width,3);assert.deepEqual((await journal.list())[0].base,choice.base)
 }finally{release?.(new ArrayBuffer(0));client.dispose();journal.close()}
})
test('closing during image file reading releases the selection without a late task',async()=>{
 const journal=await FixedImageFileJournal.open(name,new IDBFactory());let ready!:()=>void,release!:(value:ArrayBuffer)=>void
 const entered=new Promise<void>(resolve=>ready=resolve),wait=new Promise<ArrayBuffer>(resolve=>release=resolve)
 class SlowFile extends File{override arrayBuffer(){ready();return wait}}
 const client=new FixedImageFileClient(journal,{ready:()=>true,stage:async choice=>({hash:choice.hash}),flush:async()=>{}})
 try{const selecting=client.choose(new SlowFile(['image'],'image.png'),base,0),failure=assert.rejects(selecting,/unavailable/);await entered;client.dispose();await failure;release(new ArrayBuffer(1));await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(await journal.list(),[])}finally{release?.(new ArrayBuffer(0));client.dispose();journal.close()}
})
test('a failed upload preserves the exact choice, and completion waits for the draft to be durable',async()=>{
 const db=new IDBFactory(),journal=await FixedImageFileJournal.open(name,db);let fail=true,flushing=false,applied=0
 const client=new FixedImageFileClient(journal,{ready:()=>true,stage:async choice=>{if(fail)throw Error('offline');return{hash:choice.hash}},flush:async()=>{flushing=true;assert.equal((await journal.list())[0].phase,'staged')}})
 try{const choice=await client.choose(file(),base,4);await assert.rejects(client.resume(choice.id,async()=>{applied++}),/offline/);assert.deepEqual((await journal.list())[0].bytes,new Uint8Array(await file().arrayBuffer()));assert.equal(applied,0)
  fail=false;await client.resume(choice.id,async()=>{applied++});assert.equal(flushing,true);assert.equal(applied,1);assert.deepEqual(await journal.list(),[]);await assert.rejects(client.cancel(choice.id),/finished/)
 }finally{client.dispose();journal.close()}
})
test('an ignored abort or a different returned hash cannot attach bytes after cancellation',async()=>{
 const db=new IDBFactory(),journal=await FixedImageFileJournal.open(name,db),other=await FixedImageFileJournal.open(name,db);let release!:()=>void,entered!:()=>void,applied=0;const waiting=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve)
 const client=new FixedImageFileClient(journal,{ready:()=>true,stage:async choice=>{entered();await waiting;return{hash:choice.hash}},flush:async()=>{}})
 try{const choice=await client.choose(file(),base,0),run=client.resume(choice.id,async()=>{applied++});await started;await other.finish(choice.id,'cancelled');release();await assert.rejects(run,/finished/);assert.equal(applied,0);assert.deepEqual(await journal.list(),[])
  const second=await client.choose(file(),base,0),wrong=new FixedImageFileClient(journal,{ready:()=>true,stage:async()=>({hash:'f'.repeat(64)}),flush:async()=>{}});try{await assert.rejects(wrong.resume(second.id,async()=>{applied++}),/integrity/);assert.equal((await journal.list())[0].phase,'chosen');assert.equal(applied,0)}finally{wrong.dispose()}
 }finally{release?.();client.dispose();journal.close();other.close()}
})
test('failure to persist the draft does not acknowledge the image choice',async()=>{
 const journal=await FixedImageFileJournal.open(name,new IDBFactory());let applied=0
 const client=new FixedImageFileClient(journal,{ready:()=>true,stage:async choice=>({hash:choice.hash}),flush:async()=>{throw Error('disk failure')}})
 try{const choice=await client.choose(file(),base,0);await assert.rejects(client.resume(choice.id,async()=>{applied++}),/disk failure/);assert.equal(applied,1);assert.equal((await journal.list())[0].phase,'staged')}finally{client.dispose();journal.close()}
})
test('closing during target verification aborts it and retains the staged file',async()=>{
 const journal=await FixedImageFileJournal.open(name,new IDBFactory());let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve)
 const client=new FixedImageFileClient(journal,{ready:()=>true,stage:async choice=>({hash:choice.hash}),flush:async()=>{throw Error('must not flush')}})
 try{const choice=await client.choose(file(),base,0),run=client.resume(choice.id,async(_choice,signal)=>{entered();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});await started;client.dispose();await assert.rejects(run,/unavailable/);assert.equal((await journal.list())[0].phase,'staged')}finally{client.dispose();journal.close()}
})
