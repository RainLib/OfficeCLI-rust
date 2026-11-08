import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import {WordUploadClient} from './wordUploadClient.ts'
import {WordDeviceDraft} from './wordDeviceDraft.ts'
import {CollaborativeImageDraftStore,applyImageReplacement,imageIntents} from './collaborativeImages.ts'
import type {WordBrowserState} from './wordBrowserState.ts'
import type {WordUploadRecord,WordUploadSelection} from './wordUploadTypes.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {wordRegionalProtocol,wordLayoutProtocol} from './collaborationProtocol.ts'
import type {WordBrowserProtocol} from './wordBrowserProtocol.ts'
const name='hcd-local-draft-v1-'+'a'.repeat(64)+'-1-wordregions1-device2',hash='b'.repeat(64),nodeId='n_'+'1'.repeat(32),image={nodeId,visualHash:hash,assetHash:'c'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:72,height:36}},file=()=>new File(['test replacement bytes'],'original.png',{type:'image/png'})
async function fixture(protocol:WordBrowserProtocol=wordRegionalProtocol){
 const document=new Y.Doc(),images=new CollaborativeImageDraftStore(document),factory=new IDBFactory(),cache=await WordDeviceDraft.open(protocol===wordLayoutProtocol?name.replace('wordregions1-device2','wordregions2-device1'):name,factory),records=new Map<string,WordUploadRecord>(),sent:Array<{method:string;body:any}>=[];let pending=true,ready=true,loseReserve=false,holdPut:(()=>Promise<void>)|undefined,applies=0
 const controller={state:()=>({revision:1,readOnly:false}),setLocalUploadPending:(value:boolean)=>{pending=value}} as unknown as WordBrowserState
 const network:typeof fetch=async(input,init)=>{const headers=new Headers(init?.headers);assert.equal(headers.get('X-HCD-Word-Regions-Version'),protocol===wordLayoutProtocol?'2':'1');assert.equal(headers.get('X-HCD-Word-Layout-Version'),protocol===wordLayoutProtocol?'1':null);assert.doesNotMatch(String(input),/secret/);const body=init!.method==='PUT'?null:JSON.parse(String(init!.body));sent.push({method:init!.method!,body});if(init!.method==='PUT'){
   await holdPut?.();const id=String(input).split('/').at(-1)!,record=records.get(id)!;if(record.phase==='cancelled')return Response.json({code:'word-upload-cancelled'},{status:409});if(record.phase!=='applied'){applyImageReplacement(document,{base:image,revision:1,clientId:record.clientId,seen:record.seen},record.assetHash,undefined,id);record.phase='applied';applies++}return Response.json({version:1,record})
  }
  if(body.operation==='list')return Response.json({version:1,records:[...records.values()]})
  if(body.operation==='reserve'||body.operation==='cancel-selection'){const selection=body.selection as WordUploadSelection;let record=records.get(selection.id);if(!record){record={...selection,regionId:'n_'+'2'.repeat(32),actor:{userId:'alice',displayName:'Alice'},base:image,phase:'reserved'};delete (record as any).visualHash;records.set(record.id,record)}if(body.operation==='cancel-selection')record.phase='cancelled';if(loseReserve&&body.operation==='reserve'){loseReserve=false;throw new Error('response lost')}return Response.json({version:1,record})}
  const record=records.get(body.id)!;if(body.operation==='cancel'){record.phase='cancelled';return Response.json({version:1,record})}if(record.phase==='applied')return Response.json({version:1,record});return Response.json({code:'word-upload-file-required'},{status:409})
 }
 const options={session:{documentId:'doc',token:'secret',scope:'write' as const,format:'docx',collabUrl:'ws://qa.invalid',collaborationEpoch:1,collaborationProtocol:protocol},document,cache,controller,images,ready:()=>ready,fetch:network},client=new WordUploadClient(options);await client.initialize()
 return{document,images,cache,factory,records,sent,options,client,pending:()=>pending,applies:()=>applies,lose:()=>{loseReserve=true},hold:(fn:()=>Promise<void>)=>{holdPut=fn},deny:()=>{ready=false},close:async()=>{client.dispose();await cache.close();document.destroy()}}
}
test('action boundary discovers another window’s image choice and fails closed on storage errors',async()=>{
 const f=await fixture(),otherCache=await WordDeviceDraft.open(name,f.factory),other=new WordUploadClient({...f.options,cache:otherCache})
 try{await other.initialize();assert.equal(other.state().pending,false);f.lose();await assert.rejects(f.client.start(file(),image),/unavailable/);assert.equal(other.state().pending,false);assert.equal(await other.checkPending(),true);assert.equal(other.state().jobs[0].choice?.name,'original.png')
  const read=otherCache.pendingUploads.bind(otherCache);otherCache.pendingUploads=async()=>{throw Error('storage failed')};assert.equal(await other.checkPending(),true);assert.equal(other.state().problem,'word-upload-local-invalid');otherCache.pendingUploads=read;assert.equal(await other.checkPending(),true);assert.equal(other.state().problem,undefined)
 }finally{other.dispose();await otherCache.close();await f.close()}
})
test('an unknown upload ledger cannot be treated as clear until refresh succeeds',async()=>{
 const f=await fixture(),client=new WordUploadClient({...f.options,fetch:async()=>{throw Error('network unavailable')}})
 try{await client.initialize();assert.ok(client.state().problem);assert.equal(client.state().pending,true);assert.equal(await client.checkPending(),true);client.options.fetch=f.options.fetch;await client.refresh();assert.equal(await client.checkPending(),false)}finally{client.dispose();await f.close()}
})
test('browser persists a choice before transport, records own replacement once, and clears pending only after application is visible',async()=>{const f=await fixture();try{const actions:any[]=[];f.images.actions.subscribe(value=>actions.push(value));await f.client.start(file(),image);assert.equal(f.pending(),false);assert.equal(f.applies(),1);assert.equal(actions.length,1);assert.equal(actions[0].kind,'replace');assert.deepEqual(await f.cache.pendingUploads(),[]);const id=f.client.state().jobs[0].id;await f.client.resume(id);assert.equal(f.applies(),1);assert.equal(actions.length,1);assert.equal(imageIntents(f.document).length,1)}finally{await f.close()}})
test('lost reservation replies preserve original bytes and resume only on explicit request',async()=>{const f=await fixture();try{f.lose();await assert.rejects(f.client.start(file(),image),/unavailable/);assert.equal(f.pending(),true);const stored=await f.cache.pendingUploads();assert.equal(stored.length,1);assert.deepEqual(stored[0].bytes,new Uint8Array(await file().arrayBuffer()));const id=f.client.state().jobs[0].id;f.client.dispose();const resumed=new WordUploadClient(f.options);try{await resumed.initialize();assert.equal(f.applies(),0);assert.equal(resumed.state().pending,true);await assert.rejects(resumed.resume(id,new File(['wrong'],'other.png')),/file-differs/);assert.equal(f.applies(),0);await resumed.resume(id);assert.equal(f.applies(),1);assert.equal((await f.cache.pendingUploads()).length,0)}finally{resumed.dispose()}}finally{await f.close()}})
test('old metadata-only choices still require the original file',async()=>{const f=await fixture();try{const id=crypto.randomUUID(),bytes=new Uint8Array(await file().arrayBuffer()),assetHash=await imageFileHash(bytes);await f.cache.putUpload({name:'original.png',before:image,selection:{id,nodeId,extension:'png',assetHash,byteLength:bytes.length,revision:1,clientId:42,visualHash:image.visualHash,seen:[]}});assert.equal(await f.client.checkPending(),true);await assert.rejects(f.client.resume(id),/file-required/);assert.equal(f.applies(),0);await f.client.resume(id,file());assert.equal(f.applies(),1)}finally{await f.close()}})
test('explicit cancellation wins over a slow PUT without resurrecting its local choice or undo record',async()=>{const f=await fixture();let release!:()=>void,arrived!:()=>void;const entered=new Promise<void>(resolve=>{arrived=resolve}),wait=new Promise<void>(resolve=>{release=resolve});try{f.hold(async()=>{arrived();await wait});const task=f.client.start(file(),image);await entered;const id=f.client.state().jobs[0].id;await f.client.cancel(id);assert.equal(f.pending(),false);release();await task;assert.equal(f.applies(),0);assert.equal(f.client.state().jobs[0].phase,'cancelled');assert.deepEqual(await f.cache.pendingUploads(),[])}finally{release?.();await f.close()}})
test('cancelling a stalled local image read ends preparation without reserving or uploading',async()=>{
 const f=await fixture();let release!:(bytes:ArrayBuffer)=>void,arrived!:()=>void
 const entered=new Promise<void>(resolve=>arrived=resolve),wait=new Promise<ArrayBuffer>(resolve=>release=resolve)
 class SlowFile extends File{override arrayBuffer(){arrived();return wait}}
 try{
  const task=f.client.start(new SlowFile(['image'],'slow.png'),image);await entered;const id=f.client.state().jobs[0].id
  await f.client.cancel(id);await task;assert.equal(f.client.state().busy,false);assert.equal(f.pending(),false)
  release(new TextEncoder().encode('image').buffer);await new Promise(resolve=>setTimeout(resolve,0))
  assert.equal(f.sent.some(entry=>entry.method==='PUT'||entry.body?.operation==='reserve'),false);assert.equal(f.applies(),0);assert.deepEqual(await f.cache.pendingUploads(),[])
 }finally{release?.(new ArrayBuffer(0));await f.close()}
})
test('cancelling a resumed upload during file read does not resend a late reservation',async()=>{
 const f=await fixture();let release!:(bytes:ArrayBuffer)=>void,arrived!:()=>void
 const entered=new Promise<void>(resolve=>arrived=resolve),wait=new Promise<ArrayBuffer>(resolve=>release=resolve)
 class SlowFile extends File{override arrayBuffer(){arrived();return wait}}
 try{
  f.lose();await assert.rejects(f.client.start(file(),image),/unavailable/);const id=f.client.state().jobs[0].id,prior=f.sent.filter(entry=>entry.body?.operation==='reserve').length
  const task=f.client.resume(id,new SlowFile(['image'],'slow.png'));await entered;await f.client.cancel(id);await task
  release(new TextEncoder().encode('image').buffer);await new Promise(resolve=>setTimeout(resolve,0))
  assert.equal(f.sent.filter(entry=>entry.body?.operation==='reserve').length,prior);assert.equal(f.applies(),0);assert.deepEqual(await f.cache.pendingUploads(),[]);assert.equal(f.pending(),false)
 }finally{release?.(new ArrayBuffer(0));await f.close()}
})
test('read-only or unsynchronized clients cannot start a file choice',async()=>{const f=await fixture();try{f.deny();const count=f.sent.length;await assert.rejects(f.client.start(file(),image),/sync-required/);assert.equal(f.sent.length,count);assert.deepEqual(await f.cache.pendingUploads(),[])}finally{await f.close()}})
test('cancelling during the device write keeps the cancellation ahead of any later reserve or PUT',async()=>{const f=await fixture();let release!:()=>void,arrive!:()=>void;const entered=new Promise<void>(resolve=>{arrive=resolve}),wait=new Promise<void>(resolve=>{release=resolve}),put=f.cache.putUpload.bind(f.cache);try{f.cache.putUpload=async value=>{await put(value);arrive();await wait};const task=f.client.start(file(),image);await entered;await f.client.cancel(f.client.state().jobs[0].id);release();await task;assert.equal(f.applies(),0);assert.equal(f.sent.some(value=>value.method==='PUT'),false);assert.deepEqual(await f.cache.pendingUploads(),[]);assert.equal(f.pending(),false)}finally{release?.();await f.close()}})
test('an unrelated successful response cannot acknowledge this image choice',async()=>{const f=await fixture();try{const original=f.options.fetch;f.options.fetch=async(input,init)=>{const response=await original(input,init),value=await response.json();if(value.record)value.record.id=crypto.randomUUID();return Response.json(value)};await assert.rejects(f.client.start(file(),image),/invalid-response/);assert.equal(f.pending(),true);assert.equal((await f.cache.pendingUploads()).length,1);assert.equal(f.applies(),0)}finally{await f.close()}})

test('layout browser image choices use their isolated journal and model-bound reserve, PUT and cancellation',async()=>{
 const f=await fixture(wordLayoutProtocol)
 try{
  await f.client.start(file(),image);assert.equal(f.applies(),1);assert.equal(f.pending(),false);assert.equal((await f.cache.pendingUploads()).length,0)
  f.lose();await assert.rejects(f.client.start(file(),image),/unavailable/);const pending=f.client.state().jobs.find(item=>item.phase==='interrupted')!;assert.ok(pending.choice)
  await f.client.cancel(pending.id);assert.equal(f.client.state().jobs.find(item=>item.id===pending.id)!.phase,'cancelled');assert.equal((await f.cache.pendingUploads()).length,0)
  assert.throws(()=>new WordUploadClient({...f.options,session:{...f.options.session,collaborationProtocol:wordRegionalProtocol}}),/word-device-protocol/)
 }finally{await f.close()}
})
