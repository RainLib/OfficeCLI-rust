import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import {SemanticImageFiles,type SemanticImageChoice} from './semanticImageFiles.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {applyImageReplacement,imageIntents} from './collaborativeImages.ts'
import {withDeviceFileLock} from './regionalFileBoundary.ts'
const scope='hcd-local-draft-v1-'+'a'.repeat(64)+'-2-structure3-nodefiles1'
async function choice():Promise<SemanticImageChoice>{const bytes=new Uint8Array([1,2,3]),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:30,height:40}};return{version:1,id:crypto.randomUUID(),name:'image.png',extension:'png',hash:await imageFileHash(bytes),bytes,base,revision:2,phase:'chosen',capture:{base,revision:2,clientId:123,seen:[]}}}
test('semantic image choice keeps exact bytes and choice-time intents across reopening',async()=>{
 const factory=new IDBFactory(),a=await SemanticImageFiles.open(scope,factory),value=await choice();await a.put(value);await a.close();const b=await SemanticImageFiles.open(scope,factory)
 try{const [restored]=await b.list();assert.deepEqual(restored,value);const staged=await b.stage(restored);assert.equal(staged.phase,'staged');assert.equal(await b.finish(value.id,'linked'),'linked');assert.deepEqual(await b.list(),[]);assert.equal(await b.finish(value.id,'cancelled'),'linked');assert.equal((await b.stage(restored)).phase,'linked') }finally{await b.close()}
})
test('corruption and changed capture are rejected while cancellation remains terminal',async()=>{
 const f=await SemanticImageFiles.open(scope,new IDBFactory()),value=await choice()
 try{await assert.rejects(f.put({...value,bytes:new Uint8Array([4])}),/integrity/);await f.put(value);await assert.rejects(f.stage({...value,capture:{...value.capture,clientId:124}}),/changed/);assert.equal(await f.finish(value.id,'cancelled'),'cancelled');assert.equal((await f.stage(value)).phase,'cancelled');assert.deepEqual(await f.list(),[])}finally{await f.close()}
})
test('recovery capture does not consume an unseen peer replacement',async()=>{
 const f=await SemanticImageFiles.open(scope,new IDBFactory()),value=await choice(),doc=new Y.Doc()
 try{await f.put(value);applyImageReplacement(doc,{...value.capture,clientId:456},'c'.repeat(64));const [stored]=await f.list();applyImageReplacement(doc,stored.capture,stored.hash,undefined,stored.id);assert.equal(imageIntents(doc).length,2);assert.deepEqual(new Set(imageIntents(doc).map(intent=>intent.assetHash)),new Set([stored.hash,'c'.repeat(64)]))}finally{doc.destroy();await f.close()}
})
test('device action lock orders publication and close waits for accepted write',async()=>{
 const previous=globalThis.navigator,tails=new Map<string,Promise<void>>()
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(key:string,work:()=>Promise<unknown>)=>{const before=tails.get(key)??Promise.resolve();let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve}),tail=before.then(()=>hold);tails.set(key,tail);await before;try{return await work()}finally{release();if(tails.get(key)===tail)tails.delete(key)}}}}})
 const factory=new IDBFactory(),a=await SemanticImageFiles.open(scope,factory),b=await SemanticImageFiles.open(scope,factory),value=await choice()
 try{let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve}),hold=new Promise<void>(resolve=>{release=resolve});const action=withDeviceFileLock(scope,async()=>{entered();await hold;assert.deepEqual(await b.list(),[])});await started
  const write=a.put(value);await new Promise<void>(resolve=>setTimeout(resolve,0));const closing=a.close();assert.equal(a.close(),closing);release();await action;await write;await closing;assert.equal((await b.list())[0].id,value.id)
 }finally{await a.close();await b.close();Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:previous})}
})
test('scope and capture are validated and an accepted choice is isolated from later mutation',async()=>{
 const factory=new IDBFactory();await assert.rejects(SemanticImageFiles.open('wrong-scope',factory),/scope/)
 const f=await SemanticImageFiles.open(scope,factory),value=await choice()
 try{await assert.rejects(f.put({...value,capture:{...value.capture,revision:3}}),/invalid/);const write=f.put(value);value.bytes[0]=99;value.capture.clientId=987;await write;const [stored]=await f.list();assert.equal(stored.bytes[0],1);assert.equal(stored.capture.clientId,123)}finally{await f.close()}
})
test('recovery image batches are atomic, idempotent and preserve the most conservative phase',async()=>{
 const f=await SemanticImageFiles.open(scope,new IDBFactory()),first=await choice(),second=await choice()
 try{
  assert.deepEqual(await f.importChoices([first,second]),{added:2,upgraded:0});assert.deepEqual(await f.importChoices([first,second]),{added:0,upgraded:0})
  assert.equal((await f.list()).find(v=>v.id===first.id)?.phase,'applying');assert.deepEqual(await f.importChoices([{...first,phase:'applying'}]),{added:0,upgraded:0});assert.deepEqual(await f.importChoices([first]),{added:0,upgraded:0});assert.equal((await f.list()).find(v=>v.id===first.id)?.phase,'applying')
  const third=await choice();await assert.rejects(f.importChoices([third,{...second,name:'different.png'}]),/changed/);assert.equal((await f.list()).length,2)
  await f.finish(first.id,'cancelled');assert.deepEqual(await f.importChoices([first]),{added:0,upgraded:0});assert.equal((await f.list()).some(v=>v.id===first.id),false)
 }finally{await f.close()}
})
test('a damaged file or full recovery batch writes nothing',async()=>{
 const f=await SemanticImageFiles.open(scope,new IDBFactory()),drafts=await Promise.all(Array.from({length:16},()=>choice()))
 try{await assert.rejects(f.importChoices([drafts[0],{...drafts[1],bytes:new Uint8Array([7])}]),/integrity/);assert.deepEqual(await f.list(),[]);assert.deepEqual(await f.importChoices(drafts),{added:16,upgraded:0});await assert.rejects(f.importChoices([await choice()]),/limit/);assert.equal((await f.list()).length,16)}finally{await f.close()}
})
test('an older recovery copy upgrades an existing choice to uncertain, never downgrades it',async()=>{
 const f=await SemanticImageFiles.open(scope,new IDBFactory()),value=await choice()
 try{await f.put(value);assert.deepEqual(await f.importChoices([{...value,phase:'applying'}]),{added:0,upgraded:1});assert.equal((await f.list())[0].phase,'applying');await f.importChoices([value]);assert.equal((await f.list())[0].phase,'applying')}finally{await f.close()}
})
