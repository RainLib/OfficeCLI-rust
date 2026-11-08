import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import {SemanticImageFiles} from './semanticImageFiles.ts'
import {SemanticImageFileClient} from './semanticImageFileClient.ts'
import {imageIntents,applyImageReplacement as applyForTest} from './collaborativeImages.ts'
const scope='hcd-local-draft-v1-'+'a'.repeat(64)+'-2-structure3-nodefiles1',base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:30,height:40}},capture={base,revision:2,clientId:123,seen:[]}
async function fixture(){const old=globalThis.navigator;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name:string,optionsOrWork:unknown,callback?:()=>Promise<unknown>)=>(callback??optionsOrWork as ()=>Promise<unknown>)()}}});const files=await SemanticImageFiles.open(scope,new IDBFactory()),doc=new Y.Doc();let fail=false,synced=true,stages=0;const client=new SemanticImageFileClient(files,doc,{ready:()=>true,verify:async()=>{},stage:async choice=>{stages++;if(fail)throw new Error('offline');return{hash:choice.hash}},flush:async()=>{},synchronize:async()=>synced});return{files,doc,client,setOffline:(value:boolean)=>{fail=value},setSynced:(value:boolean)=>{synced=value},stages:()=>stages,close:async()=>{client.dispose();await files.close();doc.destroy();Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:old})}}}
test('failed upload preserves original file and explicit retry applies captured intent once',async()=>{
 const f=await fixture();try{const choice=await f.client.choose(new File(['image'],'x.png'),capture);f.setOffline(true);await assert.rejects(f.client.resume(choice.id),/offline/);assert.equal((await f.files.list())[0].phase,'chosen');assert.equal(imageIntents(f.doc).length,0);f.setOffline(false);await f.client.resume(choice.id);assert.equal((await f.files.list()).length,0);assert.equal(imageIntents(f.doc)[0].intentId,choice.id);assert.equal(f.stages(),2)}finally{await f.close()}
})
test('closing during image file reading releases preparation without a late task',async()=>{
 const f=await fixture();let ready!:()=>void,release!:(value:ArrayBuffer)=>void
 const entered=new Promise<void>(resolve=>ready=resolve),wait=new Promise<ArrayBuffer>(resolve=>release=resolve)
 class SlowFile extends File{override arrayBuffer(){ready();return wait}}
 try{const selecting=f.client.choose(new SlowFile(['image'],'x.png'),capture),failure=assert.rejects(selecting,/unavailable/);await entered;f.client.dispose();await failure;release(new ArrayBuffer(1));await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(await f.files.list(),[]);assert.equal(f.stages(),0)}finally{release?.(new ArrayBuffer(0));await f.close()}
})
test('closing during target verification aborts it and retains the original choice',async()=>{
 const f=await fixture();let entered!:()=>void,stages=0
 const started=new Promise<void>(resolve=>entered=resolve)
 const client=new SemanticImageFileClient(f.files,f.doc,{ready:()=>true,verify:async(_choice,signal)=>{entered();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))},stage:async choice=>{stages++;return{hash:choice.hash}},flush:async()=>{},synchronize:async()=>true})
 try{const choice=await client.choose(new File(['image'],'x.png'),capture),work=client.resume(choice.id),failure=assert.rejects(work,/unavailable/);await started;client.dispose();await failure;assert.equal(stages,0);assert.equal((await f.files.list())[0].phase,'chosen');assert.equal(imageIntents(f.doc).length,0)}finally{client.dispose();await f.close()}
})
test('a late target verification that ignores cancellation cannot stage an image',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void,stages=0
 const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve)
 const client=new SemanticImageFileClient(f.files,f.doc,{ready:()=>true,verify:async()=>{entered();await wait},stage:async choice=>{stages++;return{hash:choice.hash}},flush:async()=>{},synchronize:async()=>true})
 try{const choice=await client.choose(new File(['image'],'x.png'),capture),work=client.resume(choice.id),failure=assert.rejects(work,/unavailable/);await started;client.dispose();await failure;release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(stages,0);assert.equal((await f.files.list())[0].phase,'chosen');assert.equal(imageIntents(f.doc).length,0)}finally{release?.();client.dispose();await f.close()}
})
test('closing while waiting for a device lock cancels the queued action',async()=>{
 const f=await fixture();let entered!:()=>void,stages=0
 const started=new Promise<void>(resolve=>entered=resolve),choice=await f.client.choose(new File(['image'],'x.png'),capture)
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name:string,options:{signal:AbortSignal})=>{entered();return new Promise<never>((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})})}}}})
 const client=new SemanticImageFileClient(f.files,f.doc,{ready:()=>true,verify:async()=>{},stage:async value=>{stages++;return{hash:value.hash}},flush:async()=>{},synchronize:async()=>true})
 try{const work=client.resume(choice.id),failure=assert.rejects(work,/unavailable/);await started;client.dispose();await failure;assert.equal(stages,0);assert.equal((await f.files.list())[0].phase,'chosen');assert.equal(imageIntents(f.doc).length,0)}finally{client.dispose();await f.close()}
})
test('closing after applying an image leaves its uncertain record and shared intent intact',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve)
 const client=new SemanticImageFileClient(f.files,f.doc,{ready:()=>true,verify:async()=>{},stage:async choice=>({hash:choice.hash}),flush:async()=>{entered();await wait},synchronize:async()=>true})
 try{const choice=await client.choose(new File(['image'],'x.png'),capture),work=client.resume(choice.id),failure=assert.rejects(work,/unavailable/);await started;client.dispose();release();await failure;assert.equal((await f.files.list())[0].phase,'applying');assert.equal(imageIntents(f.doc)[0].intentId,choice.id)}finally{release?.();client.dispose();await f.close()}
})
test('lost synchronization keeps applying record and retries exact existing intent without duplication',async()=>{
 const f=await fixture();try{const choice=await f.client.choose(new File(['image'],'x.png'),capture);f.setSynced(false);await assert.rejects(f.client.resume(choice.id),/uncertain/);assert.equal((await f.files.list())[0].phase,'applying');await assert.rejects(f.client.cancel(choice.id),/uncertain/);f.setSynced(true);await f.client.resume(choice.id);assert.equal(imageIntents(f.doc).length,1);assert.deepEqual(await f.files.list(),[])}finally{await f.close()}
})
test('a consumed applying intent remains uncertain and never silently replays',async()=>{
 const f=await fixture();try{const choice=await f.client.choose(new File(['image'],'x.png'),capture);f.setSynced(false);await assert.rejects(f.client.resume(choice.id),/uncertain/);f.doc.getMap('hcdImageDrafts').delete(choice.id);f.setSynced(true);await assert.rejects(f.client.resume(choice.id),/uncertain/);assert.equal(imageIntents(f.doc).length,0);assert.equal((await f.files.list())[0].bytes.length,5)}finally{await f.close()}
})
test('explicitly discarding an uncertain local retry does not undo the shared image intent',async()=>{
 const f=await fixture();try{const choice=await f.client.choose(new File(['image'],'x.png'),capture);f.setSynced(false);await assert.rejects(f.client.resume(choice.id),/uncertain/);assert.equal(imageIntents(f.doc).length,1);await f.client.discardUncertain(choice.id);assert.equal(imageIntents(f.doc).length,1);assert.deepEqual(await f.files.list(),[])}finally{await f.close()}
})
test('an outgoing CRDT update can synchronize after application without being mistaken for lost permission',async()=>{
 const old=globalThis.navigator;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name:string,optionsOrWork:unknown,callback?:()=>Promise<unknown>)=>(callback??optionsOrWork as ()=>Promise<unknown>)()}}});const files=await SemanticImageFiles.open(scope,new IDBFactory()),doc=new Y.Doc();let synced=true
 const client=new SemanticImageFileClient(files,doc,{ready:()=>synced,readyAfterApply:()=>true,verify:async()=>{},stage:async choice=>({hash:choice.hash}),apply:(value,hash,id)=>{synced=false;applyForTest(doc,value,hash,'hcd-image-edit',id)},flush:async()=>{},synchronize:async()=>{synced=true;return true}})
 try{const choice=await client.choose(new File(['image'],'x.png'),capture);await client.resume(choice.id);assert.deepEqual(await files.list(),[]);assert.equal(imageIntents(doc).length,1)}finally{client.dispose();await files.close();doc.destroy();Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:old})}
})
test('an imported choice with no exact shared intent cannot automatically upload or replay',async()=>{
 const f=await fixture();try{const choice=await f.client.choose(new File(['image'],'x.png'),capture);await f.files.finish(choice.id,'cancelled');const other=await SemanticImageFiles.open('hcd-local-draft-v1-'+'c'.repeat(64)+'-2-structure3-nodefiles1',new IDBFactory());try{await other.importChoices([choice]);let posts=0;const resumed=new SemanticImageFileClient(other,f.doc,{ready:()=>true,verify:async()=>{},stage:async()=>{posts++;return{hash:choice.hash}},flush:async()=>{},synchronize:async()=>true});try{await assert.rejects(resumed.resume(choice.id),/uncertain/);assert.equal(posts,0);assert.equal((await other.list())[0].phase,'applying')}finally{resumed.dispose()}}finally{await other.close()}}finally{await f.close()}
})
