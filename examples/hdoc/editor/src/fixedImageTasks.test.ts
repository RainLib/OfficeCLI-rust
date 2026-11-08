import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {FixedImageTasks} from './fixedImageTasks.ts'
import {FixedSaveController} from './fixedSaveController.ts'
import {TextDraftStore} from './textDrafts.ts'
import {ImageDraftStore} from './imageDrafts.ts'
import type {Session} from './api.ts'
import {imageFileHash} from './imageFileIntegrity.ts'

const session:Session={documentId:'task-test',token:'test',scope:'write',format:'pptx',userId:'alice',apiUrl:'http://fixture/v1/documents'}
const source='a'.repeat(64),base={nodeId:'img',visualHash:'b'.repeat(64),geometry:{x:1,y:2,width:3,height:4,unit:'pt' as const}}

test('device choices survive reopening and block another window until explicitly resumed',async()=>{
 const previous={window:globalThis.window,navigator:globalThis.navigator,indexedDB:globalThis.indexedDB,fetch:globalThis.fetch,BroadcastChannel:globalThis.BroadcastChannel}
 const events=new EventTarget(),held=new Set<string>()
 Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(events,{location:{href:'http://fixture/'}})})
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name:string,_options:unknown,fn:(lock:unknown)=>Promise<unknown>)=>{if(held.has(name))return fn(null);held.add(name);try{return await fn({name})}finally{held.delete(name)}}}}})
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()})
 Object.defineProperty(globalThis,'BroadcastChannel',{configurable:true,value:undefined})
 let offline=true,busyOnce=false,attempts=0,entered!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>entered=resolve),blocked=new Promise<void>(resolve=>release=resolve)
 globalThis.fetch=async(input,init)=>{const url=String(input);if(url.endsWith('/resources/reuse'))return new Response('missing',{status:404});if(url.includes('/staged-assets')){attempts++;if(offline){entered();await blocked;return new Response('offline',{status:503})};if(busyOnce){busyOnce=false;return Response.json({error:'HCD_RESOURCE_BUSY'},{status:409})}const bytes=new Uint8Array(await (init!.body as Blob).arrayBuffer());return Response.json({hash:await imageFileHash(bytes)})}if(url.endsWith('/auth'))return Response.json({scope:'write',userId:'alice'});if(url.includes('/images/'))return Response.json({revision:0,image:base});return Response.json({revision:0,source:{sha256:source}})}
 const make=async()=>{const images=new ImageDraftStore(),save=new FixedSaveController(session,new TextDraftStore(),images,{write:async()=>{},flush:async()=>{}});await save.connect();const tasks=new FixedImageTasks(session,source,images,save,()=>true);await tasks.start();return{tasks,save,images}}
 const a=await make(),b=await make()
 try{
  const selecting=a.tasks.choose(new File(['image'],'x.png'),base,0);await started;await assert.rejects(b.tasks.withClear(async()=>42),/imageUploadPending/);release();await assert.rejects(selecting,/503/);assert.equal(a.tasks.choices.length,1);a.tasks.dispose()
  await b.tasks.refresh();assert.equal(b.tasks.choices.length,1);assert.equal(await b.tasks.checkPending(),true);await assert.rejects(b.tasks.withClear(async()=>42),/imageUploadPending/)
  offline=false;busyOnce=true;await b.tasks.resume(b.tasks.choices[0].id);assert.equal(attempts,3);assert.equal(b.tasks.choices.length,0);assert.equal(b.images.get('img')?.assetHash,await imageFileHash(new TextEncoder().encode('image')));assert.equal(await b.tasks.withClear(async()=>42),42)
 }finally{a.tasks.dispose();b.tasks.dispose();a.save.dispose();b.save.dispose();for(const [key,value] of Object.entries(previous))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})}
})
test('closing a window during a stalled image read releases the shared action lock',async()=>{
 const previous={window:globalThis.window,navigator:globalThis.navigator,indexedDB:globalThis.indexedDB,fetch:globalThis.fetch,BroadcastChannel:globalThis.BroadcastChannel},held=new Set<string>(),events=new EventTarget()
 Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(events,{location:{href:'http://fixture/'}})})
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name:string,_options:unknown,fn:(lock:unknown)=>Promise<unknown>)=>{if(held.has(name))return fn(null);held.add(name);try{return await fn({name})}finally{held.delete(name)}}}}})
 class TestChannel{closed=false;onmessage:((event:unknown)=>void)|null=null;postMessage(){if(this.closed)throw new Error('channel already closed')}close(){this.closed=true}}
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});Object.defineProperty(globalThis,'BroadcastChannel',{configurable:true,value:TestChannel})
 globalThis.fetch=async input=>String(input).endsWith('/auth')?Response.json({scope:'write',userId:'alice'}):Response.json({revision:0,source:{sha256:source}})
 const make=async()=>{const images=new ImageDraftStore(),save=new FixedSaveController(session,new TextDraftStore(),images,{write:async()=>{},flush:async()=>{}});await save.connect();const tasks=new FixedImageTasks(session,source,images,save,()=>true);await tasks.start();return{tasks,save}}
 const a=await make(),b=await make();let entered!:()=>void,release!:(value:ArrayBuffer)=>void
 const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<ArrayBuffer>(resolve=>release=resolve)
 class SlowFile extends File{override arrayBuffer(){entered();return wait}}
 try{
  const selecting=a.tasks.choose(new SlowFile(['image'],'x.png'),base,0),failure=assert.rejects(selecting,/not-recorded/);await started
  await assert.rejects(b.tasks.withClear(async()=>42),/imageUploadPending/)
  a.tasks.dispose();await failure;assert.equal(await b.tasks.withClear(async()=>42),42)
  release(new TextEncoder().encode('image').buffer);await new Promise(resolve=>setTimeout(resolve,0));await b.tasks.refresh();assert.deepEqual(b.tasks.choices,[])
 }finally{release?.(new ArrayBuffer(0));a.tasks.dispose();b.tasks.dispose();a.save.dispose();b.save.dispose();for(const [key,value] of Object.entries(previous))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})}
})
test('out-of-order journal reads cannot overwrite a newer visible state or mask a pending guard',async()=>{
 let finishFirst!:(value:unknown[])=>void,finishSecond!:(value:unknown[])=>void,calls=0
 const first=new Promise<unknown[]>(resolve=>finishFirst=resolve),second=new Promise<unknown[]>(resolve=>finishSecond=resolve)
 const images=new ImageDraftStore(),save=new FixedSaveController(session,new TextDraftStore(),images),tasks=new FixedImageTasks(session,source,images,save,()=>true)
 ;(tasks as unknown as {journal:unknown}).journal={list:()=>++calls===1?first:second}
 const a=tasks.refresh(),b=tasks.refresh();finishSecond([]);assert.equal(await b,false);finishFirst([{id:'older'}]);assert.equal(await a,true);assert.deepEqual(tasks.choices,[]);assert.equal(tasks.pending,false)
 save.dispose()
})
test('a superseded guard read still blocks the operation when its own result contains a choice',async()=>{
 const previous=globalThis.navigator;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}})
 let finishGuard!:(value:unknown[])=>void,finishNewer!:(value:unknown[])=>void,calls=0,executed=false
 const guard=new Promise<unknown[]>(resolve=>finishGuard=resolve),newer=new Promise<unknown[]>(resolve=>finishNewer=resolve)
 const images=new ImageDraftStore(),save=new FixedSaveController(session,new TextDraftStore(),images),tasks=new FixedImageTasks(session,source,images,save,()=>true)
 ;(tasks as unknown as {journal:unknown}).journal={list:()=>++calls===1?guard:newer};tasks.loading=false
 try{const guarded=tasks.withClear(async()=>{executed=true});const latest=tasks.refresh();finishNewer([]);await latest;finishGuard([{id:'pending'}]);await assert.rejects(guarded,/imageUploadPending/);assert.equal(executed,false);assert.deepEqual(tasks.choices,[])}finally{save.dispose();Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:previous})}
})
