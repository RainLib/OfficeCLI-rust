import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {FixedSaveController} from './fixedSaveController.ts'
import {TextDraftStore,type TextRun} from './textDrafts.ts'
import {ImageDraftStore,desiredAsset,type PositionedImage} from './imageDrafts.ts'
import type {Session} from './api.ts'
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const session:Session={documentId:'doc',userId:'alice',token:'token',scope:'write',format:'pptx',apiUrl:'http://test/v1/documents'}
const initial:TextRun={nodeId:'text',nodeHash:hash('Original 中文😀'),text:'Original 中文😀'}
const picture:PositionedImage={nodeId:'picture',visualHash:hash('image'),assetHash:hash('red'),geometry:{unit:'pt',x:10,y:20,width:100,height:50}}
function setup(format='pptx'){
 const texts=new TextDraftStore(),images=new ImageDraftStore(),controller=new FixedSaveController({...session,format},texts,images)
 return{texts,images,controller,history:controller.history}
}
function server(native=false){
 let revision=1,run=structuredClone(initial),image=structuredClone(picture)
 if(native)image.assetHash=undefined
 let reads=0,writes=0
 const fetch:typeof globalThis.fetch=async(url,init)=>{
  const path=String(url)
  if(!init?.method){reads++;if(path.endsWith('/text/text'))return Response.json({...run,revision});if(path.endsWith('/images/picture'))return Response.json({image,revision});throw new Error(path)}
  assert.ok(path.endsWith('/edits'));writes++
  const patch=JSON.parse(String(init.body));assert.equal(patch.baseRevision,revision)
  for(const op of patch.operations){
   if(op.op==='text.splice'){assert.equal(op.precondition.nodeHash,run.nodeHash);run={...run,text:op.insertText,nodeHash:hash(op.insertText)}}
   else{assert.equal(op.precondition.visualHash,image.visualHash);if(op.op==='image.replace')image={...image,assetHash:op.assetHash};else if(op.op==='image.restoreSource')image={...image,assetHash:undefined};else image={...image,geometry:op.geometry}}
  }
  revision++;image={...image,visualHash:hash(JSON.stringify({revision,image}))}
  return Response.json({patchId:patch.patchId,revision,nodeHashes:{text:run.nodeHash},images:[image]})
 }
 return{fetch,get revision(){return revision},get run(){return run},get image(){return image},get reads(){return reads},get writes(){return writes},peerImage(update:Partial<PositionedImage['geometry']>){revision++;image={...image,visualHash:hash('peer'+revision),geometry:{...image.geometry,...update}}},peerText(text:string){revision++;run={...run,text,nodeHash:hash(text)}}}
}
async function withServer(work:(s:ReturnType<typeof server>)=>Promise<void>){const original=globalThis.fetch,s=server();globalThis.fetch=s.fetch;try{await work(s)}finally{globalThis.fetch=original}}

test('one chronological history covers text, resource replacement and geometry after saved commits',async()=>withServer(async s=>{
 const{texts,images,controller,history}=setup()
 try{
  texts.edit(initial,1,'Own 中文😀',2);history.stopCapturing()
  const upload=images.prepareReplacement(picture,1,2);upload.commit(hash('blue'));upload.finish()
  images.edit(picture,1,{...picture.geometry,width:130},2,'width')
  assert.equal(await controller.save(1),2);assert.equal(texts.size+images.size,0)
  s.peerImage({height:75})
  const first=await history.step('undo');assert.equal(first.type,'image');assert.equal(first.page,2)
  assert.equal(images.get('picture')?.geometry.width,100);assert.equal(images.get('picture')?.geometry.height,75);assert.equal(desiredAsset(images.get('picture')!),hash('blue'))
  assert.equal(await controller.save(3),4)
  await history.step('undo');assert.equal(images.get('picture')?.assetHash,picture.assetHash);assert.equal(images.get('picture')?.geometry.height,75)
  assert.equal(await controller.save(4),5)
  await history.step('undo');assert.equal(texts.get('text')?.text,initial.text);assert.equal(await controller.save(5),6)
  assert.equal(s.image.geometry.height,75);assert.equal(s.image.assetHash,picture.assetHash);assert.equal(s.run.text,initial.text)
  await history.step('redo');await controller.save(6)
  await history.step('redo');await controller.save(7)
  await history.step('redo');await controller.save(8)
  assert.equal(s.run.text,'Own 中文😀');assert.equal(s.image.geometry.width,130);assert.equal(s.image.geometry.height,75);assert.equal(s.image.assetHash,hash('blue'));assert.equal(history.canRedo,false)
 }finally{controller.dispose()}
}))

test('different local image fields survive an inverse together with disjoint canonical peer edits',async()=>withServer(async s=>{
 const{images,controller,history}=setup()
 try{
  images.edit(picture,1,{...picture.geometry,width:130},2,'width');await controller.save(1)
  s.peerImage({height:75})
  images.edit(s.image,3,{...s.image.geometry,x:22},2,'x')
  await history.step('undo');assert.equal(images.size,0)
  await history.step('undo');assert.equal(images.get('picture')?.geometry.width,100);assert.equal(images.get('picture')?.geometry.height,75)
  await history.step('redo');assert.equal(images.size,0)
  await history.step('redo');assert.equal(images.get('picture')?.geometry.x,22);assert.equal(images.get('picture')?.geometry.height,75)
 }finally{controller.dispose()}
}))

test('same-field peer text/image changes reject both directions and retain the action without a write',async()=>withServer(async s=>{
 const{texts,images,controller,history}=setup()
 try{
  texts.edit(initial,1,'Own');await controller.save(1);s.peerText('Peer 中文😀')
  await assert.rejects(history.step('undo'),/historyConflict/);assert.equal(history.canUndo,true);assert.equal(texts.size,0);assert.equal(s.writes,1)
  const upload=images.prepareReplacement(s.image,s.revision);upload.commit(hash('blue'));upload.finish();await controller.save(s.revision)
  s.peerImage({width:180})
  await history.step('undo');assert.equal(images.get('picture')?.geometry.width,180);assert.equal(images.get('picture')?.assetHash,picture.assetHash)
  await controller.save(s.revision);s.peerImage({width:190})
  await history.step('redo');assert.equal(images.get('picture')?.geometry.width,190)
  await controller.save(s.revision)
  images.edit(s.image,s.revision,{...s.image.geometry,width:210});await controller.save(s.revision);s.peerImage({width:230})
  await assert.rejects(history.step('undo'),/historyConflict/);assert.equal(images.size,0);assert.equal(s.image.geometry.width,230)
 }finally{controller.dispose()}
}))

test('local edit capture groups continuous typing but Save and explicit boundaries split groups',async()=>withServer(async s=>{
 const{texts,controller,history}=setup()
 try{
  texts.edit(initial,1,'A');texts.edit(initial,1,'AB');texts.edit(initial,1,'ABC')
  await history.step('undo');assert.equal(texts.size,0);assert.equal(history.canUndo,false)
  await history.step('redo');assert.equal(texts.get('text')?.text,'ABC')
  await controller.save(1);texts.edit(initial,1,'After save')
  await history.step('undo');assert.equal(texts.size,0);assert.equal(history.canUndo,true)
  await history.step('undo');assert.equal(texts.get('text')?.text,initial.text)
  texts.edit(s.run,s.revision,'New branch');assert.equal(history.canRedo,false)
 }finally{controller.dispose()}
}))

test('new input or reconciliation during async history lookup is preserved; unmount aborts application',async()=>{
 const original=globalThis.fetch,{texts,controller,history}=setup();let resolve!:(response:Response)=>void
 try{
  texts.edit(initial,1,'Own');globalThis.fetch=()=>new Promise(done=>{resolve=done})
  const pending=history.step('undo');texts.edit(initial,1,'Newer input')
  resolve(Response.json({...initial,revision:1}));await assert.rejects(pending,/historyChanged/)
  assert.equal(texts.get('text')?.text,'Newer input');assert.equal(history.canUndo,true)
  const closing=history.step('undo');controller.dispose();resolve(Response.json({...initial,revision:1}));await assert.rejects(closing,/historyBusy/)
  assert.equal(texts.get('text')?.text,'Newer input')
 }finally{controller.dispose();globalThis.fetch=original}
})

test('uploads, saves and unknown outcomes prevent history requests or draft mutation',async()=>{
 const original=globalThis.fetch,{texts,images,controller,history}=setup()
 try{
  texts.edit(initial,1,'Own');let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('offline')}
  const upload=images.prepareReplacement(picture,1)
  assert.equal(history.canUndo,false);await assert.rejects(history.step('undo'),/historyBusy/);assert.equal(calls,0);upload.finish()
  await assert.rejects(controller.save(1),/fixedSaveUnknown/)
  const before=calls;assert.equal(history.canUndo,false);await assert.rejects(history.step('undo'),/historyBusy/);assert.equal(calls,before);assert.equal(texts.get('text')?.text,'Own')
 }finally{controller.dispose();globalThis.fetch=original}
})

test('missing/deleted targets and transport failures leave both history and all drafts intact',async()=>{
 const original=globalThis.fetch,{texts,controller,history}=setup()
 try{
  texts.edit(initial,1,'Own')
  for(const response of [()=>Promise.resolve(new Response('missing',{status:404})),()=>Promise.resolve(Response.json({...initial,revision:-1})),()=>Promise.reject(new Error('offline'))]){
   globalThis.fetch=response;await assert.rejects(history.step('undo'));assert.equal(history.canUndo,true);assert.equal(texts.get('text')?.text,'Own')
  }
  texts.discard('text');assert.equal(history.canUndo,false)
 }finally{controller.dispose();globalThis.fetch=original}
})

test('invalid numeric edits can be undone and redone without bypassing save validation',async()=>withServer(async()=>{
 const{images,controller,history}=setup()
 try{
  images.edit(picture,1,{...picture.geometry,width:NaN})
  await history.step('undo');assert.equal(images.size,0)
  await history.step('redo');assert.ok(Number.isNaN(images.get('picture')?.geometry.width))
  await assert.rejects(controller.save(1),/draftsNotReady/)
 }finally{controller.dispose()}
}))


test('native PDF source-only images use an explicit source restore; redo can replace again',async()=>{
 const original=globalThis.fetch,s=server(true),{images,controller,history}=setup('pdf');globalThis.fetch=s.fetch
 try{
  const source=structuredClone(s.image),upload=images.prepareReplacement(source,1,0)
  upload.commit(hash('blue'));upload.finish();await controller.save(1)
  s.peerImage({height:75});await history.step('undo')
  assert.equal(images.get('picture')?.restoreSource,true);assert.equal(images.get('picture')?.assetHash,undefined)
  await controller.save(3);assert.equal(s.image.assetHash,undefined);assert.equal(s.image.geometry.height,75)
  await history.step('redo');assert.equal(images.get('picture')?.assetHash,hash('blue'));assert.equal(images.get('picture')?.restoreSource,undefined)
  await controller.save(4);assert.equal(s.image.assetHash,hash('blue'));assert.equal(s.image.geometry.height,75)
 }finally{controller.dispose();globalThis.fetch=original}
})


test('explicit skip of a conflicting action preserves current document and drafts; stale review cannot skip new input',async()=>withServer(async s=>{
 const{texts,images,controller,history}=setup()
 try{
  images.edit(picture,1,{...picture.geometry,width:130});await controller.save(1)
  texts.edit(initial,2,'Own');await controller.save(2);s.peerText('Peer')
  await assert.rejects(history.step('undo'),/historyConflict/)
  const review=history.snapshot();texts.edit(s.run,s.revision,'New input')
  assert.throws(()=>history.skip('undo',review),/historyChanged/)
  assert.equal(texts.get('text')?.text,'New input')
  texts.discard('text') // Explicit target reset removes its old actions.
  await history.step('undo');assert.equal(images.get('picture')?.geometry.width,100);assert.equal(s.run.text,'Peer')
 }finally{controller.dispose()}
}))

test('skipping an unchanged reviewed conflict exposes earlier actions without changing the peer field',async()=>withServer(async s=>{
 const{texts,images,controller,history}=setup()
 try{
  images.edit(picture,1,{...picture.geometry,width:130});await controller.save(1)
  texts.edit(initial,2,'Own');await controller.save(2);s.peerText('Peer')
  await assert.rejects(history.step('undo'),/historyConflict/)
  history.skip('undo',history.snapshot());assert.equal(texts.size,0);assert.equal(s.run.text,'Peer')
  await history.step('undo');assert.equal(images.get('picture')?.geometry.width,100);assert.equal(s.run.text,'Peer')
 }finally{controller.dispose()}
}))


test('geometry undo does not replace an unchanged original image payload',async()=>{
 const original=globalThis.fetch,s=server(),{images,controller,history}=setup('pdf');const patches:any[]=[]
 globalThis.fetch=async(url,init)=>{if(init?.method==='POST')patches.push(JSON.parse(String(init.body)));return s.fetch(url,init)}
 try{
  images.edit(picture,1,{...picture.geometry,width:130});await controller.save(1)
  await history.step('undo');await controller.save(2)
  assert.equal(s.image.assetHash,picture.assetHash)
  assert.equal(s.image.geometry.width,picture.geometry.width)
  assert.deepEqual(patches.map(patch=>patch.operations.map((op:any)=>op.op)),[['image.geometry'],['image.geometry']])
 }finally{controller.dispose();globalThis.fetch=original}
})


test('a rebased same-field conflict cannot be bypassed by undoing an uncommitted local image edit',async()=>withServer(async s=>{
 const{images,controller,history}=setup()
 try{
  images.edit(picture,1,{...picture.geometry,width:130});s.peerImage({width:180,height:75});images.reconcile([s.image],s.revision)
  assert.deepEqual(images.get('picture')?.conflictingFields,['width'])
  const before=structuredClone(images.entries())
  await assert.rejects(history.step('undo'),/historyConflict/)
  assert.deepEqual(images.entries(),before);assert.equal(s.image.geometry.width,180)
 }finally{controller.dispose()}
}))
