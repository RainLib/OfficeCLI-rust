import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {WordDeviceDraft} from './wordDeviceDraft.ts'
import {WordNodeResourceClient,nodeResourceHash} from './wordNodeResources.ts'
import {regionalFileBoundary,withRegionalFileLock} from './regionalFileBoundary.ts'

test('regional action boundaries detect a missed file notification before and after a save',async()=>{
 const name='hcd-local-draft-v1-'+'a'.repeat(64)+'-1-wordregions1-device2',factory=new IDBFactory(),left=await WordDeviceDraft.open(name,factory),right=await WordDeviceDraft.open(name,factory)
 const client=new WordNodeResourceClient({cache:right,registry:{archiveResource:async()=>{throw Error('must not upload')}},ready:()=>true}),bytes=new Uint8Array([1,2,3]),node={schemaVersion:'hcd.extension/2' as const,instanceId:'x_'+'a'.repeat(32),type:'test.atom',version:1,display:'inline' as const,data:{},fallback:{text:'Atom'}}
 const guard=()=>regionalFileBoundary({nodeFiles:()=>client.checkPending(),uploads:async()=>false,resourcesBusy:()=>false,uploadsBusy:()=>false,imagesBusy:()=>false})
 try{await client.initialize();await guard();const id=crypto.randomUUID();await left.putNodeResource({version:1,id,regionId:'n_'+'1'.repeat(32),expected:node,resource:{key:'file',name:'data.bin',mediaType:'application/octet-stream',byteLength:bytes.length,hash:await nodeResourceHash(bytes)},bytes,phase:'chosen'});assert.equal(client.state().pending,false);await assert.rejects(guard(),/node-resource-pending/);assert.equal(client.state().jobs[0].id,id);await left.finishNodeResource(id,'cancelled');await guard()
 }finally{client.dispose();await left.close();await right.close()}
})
test('regional boundaries fail closed on uploads and work started during reads',async()=>{
 await assert.rejects(regionalFileBoundary({nodeFiles:async()=>false,uploads:async()=>true,resourcesBusy:()=>false,uploadsBusy:()=>false,imagesBusy:()=>false}),/word-upload-pending/)
 await assert.rejects(regionalFileBoundary({nodeFiles:async()=>false,uploads:async()=>false,resourcesBusy:()=>false,uploadsBusy:()=>true,imagesBusy:()=>false}),/word-upload-pending/)
 await assert.rejects(regionalFileBoundary({nodeFiles:async()=>false,uploads:async()=>false,resourcesBusy:()=>true,uploadsBusy:()=>false,imagesBusy:()=>false}),/node-resource-pending/)
 await assert.rejects(regionalFileBoundary({nodeFiles:async()=>false,uploads:async()=>false,resourcesBusy:()=>false,uploadsBusy:()=>false,imagesBusy:()=>true}),/word-browser-upload-pending/)
})

test('regional save lock orders other windows file publication and checks pending choices',async()=>{
 const previous=globalThis.navigator,tails=new Map<string,Promise<void>>()
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name:string,work:()=>Promise<unknown>)=>{
  const before=tails.get(name)??Promise.resolve();let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve}),tail=before.then(()=>hold);tails.set(name,tail);await before;try{return await work()}finally{release();if(tails.get(name)===tail)tails.delete(name)}
 }}}})
 const name='hcd-local-draft-v1-'+'c'.repeat(64)+'-1-wordregions1-device2',factory=new IDBFactory(),left=await WordDeviceDraft.open(name,factory),right=await WordDeviceDraft.open(name,factory),bytes=new Uint8Array([1,2,3])
 const node={schemaVersion:'hcd.extension/2' as const,instanceId:'x_'+'a'.repeat(32),type:'test.atom',version:1,display:'inline' as const,data:{},fallback:{text:'Atom'}},id=crypto.randomUUID()
 const draft={version:1 as const,id,regionId:'n_'+'1'.repeat(32),expected:node,resource:{key:'file',name:'data.bin',mediaType:'application/octet-stream',byteLength:bytes.length,hash:await nodeResourceHash(bytes)},bytes,phase:'chosen' as const}
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve}),hold=new Promise<void>(resolve=>{release=resolve})
 try{
  const action=withRegionalFileLock(name,async()=>{enter();await hold;assert.deepEqual(await right.pendingNodeResources(),[])})
  await entered;let published=false;const choice=left.putNodeResource(draft).then(()=>{published=true})
  await Promise.resolve();assert.equal(published,false);assert.deepEqual(await right.pendingNodeResources(),[])
  release();await action;await choice;assert.equal((await right.pendingNodeResources())[0].id,id)
  await assert.rejects(withRegionalFileLock(name,()=>regionalFileBoundary({nodeFiles:async()=>(await right.pendingNodeResources()).length>0,uploads:async()=>false,resourcesBusy:()=>false,uploadsBusy:()=>false,imagesBusy:()=>false})),/node-resource-pending/)
  await left.finishNodeResource(id,'cancelled')
  const hash='a'.repeat(64),nodeId='n_'+'1'.repeat(32),choiceId=crypto.randomUUID(),upload={name:'x.png',selection:{id:choiceId,nodeId,extension:'png' as const,assetHash:hash,byteLength:24,revision:1,clientId:42,visualHash:hash,seen:[]},before:{nodeId,visualHash:hash,assetHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:72,height:36}}}
  let releaseUpload!:()=>void,enterUpload!:()=>void;const uploadStarted=new Promise<void>(resolve=>{enterUpload=resolve}),uploadHold=new Promise<void>(resolve=>{releaseUpload=resolve})
  const guarded=withRegionalFileLock(name,async()=>{enterUpload();await uploadHold;assert.deepEqual(await right.pendingUploads(),[])})
  await uploadStarted;let imagePublished=false;const pendingUpload=left.putUpload(upload).then(()=>{imagePublished=true});await Promise.resolve();assert.equal(imagePublished,false);assert.deepEqual(await right.pendingUploads(),[])
  releaseUpload();await guarded;await pendingUpload
  await assert.rejects(withRegionalFileLock(name,()=>regionalFileBoundary({nodeFiles:async()=>false,uploads:async()=>(await right.pendingUploads()).length>0,resourcesBusy:()=>false,uploadsBusy:()=>false,imagesBusy:()=>false})),/word-upload-pending/)
 }finally{release?.();await left.close();await right.close();Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:previous})}
})

test('regional device close waits for accepted file publications queued behind an action',async()=>{
 const previous=globalThis.navigator,tails=new Map<string,Promise<void>>()
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(key:string,work:()=>Promise<unknown>)=>{
  const before=tails.get(key)??Promise.resolve();let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve}),tail=before.then(()=>hold);tails.set(key,tail);await before;try{return await work()}finally{release();if(tails.get(key)===tail)tails.delete(key)}
 }}}})
 const factory=new IDBFactory(),name='hcd-local-draft-v1-'+'d'.repeat(64)+'-1-wordregions1-device2',right=await WordDeviceDraft.open(name,factory)
 try{
  for(const kind of ['node','image'] as const){
   const left=await WordDeviceDraft.open(name,factory),bytes=new Uint8Array([1,2,3]),id=crypto.randomUUID(),hash='a'.repeat(64),nodeId='n_'+'1'.repeat(32)
   const node={schemaVersion:'hcd.extension/2' as const,instanceId:'x_'+'a'.repeat(32),type:'test.atom',version:1,display:'inline' as const,data:{},fallback:{text:'Atom'}}
   const draft={version:1 as const,id,regionId:nodeId,expected:node,resource:{key:'file',name:'data.bin',mediaType:'application/octet-stream',byteLength:3,hash:await nodeResourceHash(bytes)},bytes,phase:'chosen' as const}
   const upload={name:'x.png',selection:{id,nodeId,extension:'png' as const,assetHash:hash,byteLength:24,revision:1,clientId:42,visualHash:hash,seen:[]},before:{nodeId,visualHash:hash,assetHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:72,height:36}}}
   let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve}),hold=new Promise<void>(resolve=>{release=resolve})
   const action=withRegionalFileLock(name,async()=>{entered();await hold});await started
   const write=kind==='node'?left.putNodeResource(draft):left.putUpload(upload),closing=left.close(),again=left.close();assert.equal(closing,again)
   await assert.rejects(left.putNodeResource(draft),/closed/);release();await action;await write;await closing
   if(kind==='node'){assert.equal((await right.pendingNodeResources())[0].id,id);await right.finishNodeResource(id,'cancelled')}else{assert.equal((await right.pendingUploads())[0].selection.id,id);await right.removeUpload(id)}
  }
 }finally{await right.close();Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:previous})}
})
