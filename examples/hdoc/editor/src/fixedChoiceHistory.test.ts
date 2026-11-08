import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {FixedSaveController} from './fixedSaveController.ts'
import {TextDraftStore,type TextRun} from './textDrafts.ts'
import {ImageDraftStore,desiredAsset,type PositionedImage} from './imageDrafts.ts'
import type {Session} from './api.ts'
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const initial:TextRun={nodeId:'text',text:'Original',nodeHash:hash('Original')}
const picture:PositionedImage={nodeId:'picture',visualHash:hash('initial'),assetHash:hash('blue'),geometry:{unit:'pt',x:0,y:0,width:100,height:50}}
const session:Session={documentId:'doc',token:'private',scope:'write',format:'pptx',apiUrl:'http://test/v1/documents'}
function fixture(){
 let revision=1,run=structuredClone(initial),image=structuredClone(picture),lost=false,receiptsAvailable=true,writes=0
 const receipts=new Map<string,unknown>(),texts=new TextDraftStore(),images=new ImageDraftStore(),controller=new FixedSaveController(session,texts,images)
 const api:typeof fetch=async(url,init)=>{
  const path=String(url)
  if(!init?.method){if(path.endsWith('/images/picture'))return Response.json({image,revision});if(path.endsWith('/text/text'))return Response.json({...run,revision});throw new Error(path)}
  const patch=JSON.parse(String(init.body))
  if(path.endsWith('/edits/receipt'))return receiptsAvailable?Response.json(receipts.get(patch.patchId)??{status:'missing',patchId:patch.patchId}):new Response('temporarily unknown',{status:503})
  assert.ok(path.endsWith('/edits'));assert.equal(patch.baseRevision,revision);writes++
  for(const operation of patch.operations){if(operation.op==='text.splice')run={...run,text:operation.insertText,nodeHash:hash(operation.insertText)};else if(operation.op==='image.replace')image={...image,assetHash:operation.assetHash};else if(operation.op==='image.restoreSource')image={...image,assetHash:undefined};else image={...image,geometry:operation.geometry}}
  revision++;image={...image,visualHash:hash('image'+revision)}
  const receipt={status:'committed',patchId:patch.patchId,revision,nodeHashes:{text:run.nodeHash},images:[image]};receipts.set(patch.patchId,receipt)
  if(lost){lost=false;throw new Error('response lost after commit')}
  return Response.json(receipt)
 }
 return{texts,images,controller,history:controller.history,api,get revision(){return revision},get image(){return image},get run(){return run},get writes(){return writes},peerImage(fields:Partial<PositionedImage['geometry']>,assetHash=image.assetHash){revision++;image={...image,assetHash,geometry:{...image.geometry,...fields},visualHash:hash('peer'+revision)};images.reconcile([image],revision)},peerText(text:string){revision++;run={...run,text,nodeHash:hash(text)};texts.reconcile([run],revision)},loseNext(){lost=true;receiptsAvailable=false},allowReceipts(){receiptsAvailable=true}}
}
async function exercise(work:(state:ReturnType<typeof fixture>)=>Promise<void>){const original=globalThis.fetch,state=fixture();globalThis.fetch=state.api;try{await work(state)}finally{state.controller.dispose();globalThis.fetch=original}}
function ownImage(s:ReturnType<typeof fixture>){s.images.edit(picture,1,{...picture.geometry,x:9},0,'x');s.images.edit(picture,1,{...picture.geometry,width:130},0,'width');s.peerImage({width:150,height:75})}

test('undo remote image choice restores its conflict and rebases unrelated newer peer fields',async()=>exercise(async s=>{
 ownImage(s);s.images.resolve('picture',false);assert.equal(s.images.get('picture')?.geometry.width,150)
 s.peerImage({height:90})
 await s.history.step('undo');const restored=s.images.get('picture')!;assert.deepEqual(restored.conflictingFields,['width']);assert.equal(restored.geometry.width,130);assert.equal(restored.geometry.x,9);assert.equal(restored.geometry.height,90)
 await assert.rejects(s.controller.save(s.revision),/draftsNotReady/)
 await s.history.step('redo');assert.equal(s.images.get('picture')?.geometry.width,150);assert.equal(s.images.get('picture')?.geometry.height,90);assert.equal(s.images.get('picture')?.remote,undefined)
 await s.controller.save(s.revision);assert.equal(s.image.geometry.width,150);assert.equal(s.image.geometry.x,9)
}))
test('an unsaved keep-local choice is an undo step even when its visible value is unchanged',async()=>exercise(async s=>{
 ownImage(s);s.images.resolve('picture',true);assert.equal(s.images.get('picture')?.geometry.width,130);assert.equal(s.images.get('picture')?.remote,undefined)
 await s.history.step('undo');assert.ok(s.images.get('picture')?.remote);assert.equal(s.images.get('picture')?.geometry.width,130)
 await s.history.step('redo');assert.equal(s.images.get('picture')?.remote,undefined)
}))
test('saved keep-local image choice undoes its committed fields, preserving older local and peer fields',async()=>exercise(async s=>{
 ownImage(s);s.images.resolve('picture',true);await s.controller.save(s.revision)
 await s.history.step('undo');assert.equal(s.images.get('picture')?.geometry.width,150);assert.equal(s.images.get('picture')?.geometry.x,9);assert.equal(s.images.get('picture')?.geometry.height,75);assert.equal(s.images.get('picture')?.remote,undefined)
 await s.controller.save(s.revision);assert.equal(s.image.geometry.width,150)
 await assert.rejects(s.history.step('undo'),/historyConflict/);assert.equal(s.image.geometry.width,150)
 await s.history.step('redo');await s.controller.save(s.revision);assert.equal(s.image.geometry.width,130);assert.equal(s.image.geometry.height,75)
}))
test('redo of a remote choice cannot silently accept a different newer peer value',async()=>exercise(async s=>{
 ownImage(s);s.images.resolve('picture',false);await s.history.step('undo');s.peerImage({width:170})
 await assert.rejects(s.history.step('redo'),/historyConflict/);assert.equal(s.images.get('picture')?.geometry.width,130);assert.equal(s.images.get('picture')?.remote?.image.geometry.width,170);assert.equal(s.writes,0)
}))
test('resource choice has saved undo/redo without undoing independent dimensions',async()=>exercise(async s=>{
 const upload=s.images.prepareReplacement(picture,1);upload.commit(hash('red'));upload.finish();s.peerImage({height:75},hash('green'))
 s.images.resolve('picture',true);await s.controller.save(s.revision)
 await s.history.step('undo');assert.equal(desiredAsset(s.images.get('picture')!),hash('green'));assert.equal(s.images.get('picture')?.geometry.height,75);await s.controller.save(s.revision)
 await s.history.step('redo');await s.controller.save(s.revision);assert.equal(s.image.assetHash,hash('red'))
}))
test('remote text choice can restore the rejected local text as an unresolved draft',async()=>exercise(async s=>{
 s.texts.edit(initial,1,'Own text');s.peerText('Peer text');s.texts.resolve(s.run,s.revision,false);assert.equal(s.texts.size,0)
 await s.history.step('undo');assert.equal(s.texts.get('text')?.text,'Own text');assert.equal(s.texts.get('text')?.remote?.text,'Peer text')
 await assert.rejects(s.controller.save(s.revision),/draftsNotReady/)
 await s.history.step('redo');assert.equal(s.texts.size,0);assert.equal(s.run.text,'Peer text')
}))
test('saved keep-local text choice reverses its publication and rejects newer peer overwrite',async()=>exercise(async s=>{
 s.texts.edit(initial,1,'Own text');s.peerText('Peer text');s.texts.resolve(s.run,s.revision,true);await s.controller.save(s.revision)
 await s.history.step('undo');assert.equal(s.texts.get('text')?.text,'Peer text');await s.controller.save(s.revision);assert.equal(s.run.text,'Peer text')
 await s.history.step('redo');await s.controller.save(s.revision);assert.equal(s.run.text,'Own text')
 s.peerText('Newer peer text');await assert.rejects(s.history.step('undo'),/historyConflict/);assert.equal(s.texts.size,0)
}))
test('lost response confirms only the captured choice and keeps later local input',async()=>exercise(async s=>{
 ownImage(s);s.images.resolve('picture',true);s.loseNext();await assert.rejects(s.controller.save(s.revision),/fixedSaveUnknown/)
 s.images.edit(s.image,s.revision,{...s.image.geometry,x:22},0,'x');s.allowReceipts();await s.controller.save(s.revision)
 assert.equal(s.images.get('picture')?.geometry.x,22);await s.history.step('undo');assert.equal(s.images.size,0)
 await s.history.step('undo');assert.equal(s.images.get('picture')?.geometry.width,150);assert.equal(s.images.get('picture')?.geometry.x,9);assert.equal(s.writes,1)
}))

test('remote image choice can be undone across a later saved edit without saving every inverse',async()=>exercise(async s=>{
 ownImage(s);s.images.resolve('picture',false);s.images.edit(s.image,s.revision,{...s.image.geometry,width:200},0,'width');await s.controller.save(s.revision)
 await s.history.step('undo');assert.equal(s.images.get('picture')?.geometry.width,150)
 s.peerImage({height:90})
 await s.history.step('undo');assert.equal(s.images.get('picture')?.geometry.width,130);assert.ok(s.images.get('picture')?.remote)
 await s.history.step('redo');assert.equal(s.images.get('picture')?.geometry.width,150);assert.equal(s.images.get('picture')?.remote,undefined)
 await s.history.step('redo');assert.equal(s.images.size,0);assert.equal(s.image.geometry.width,200);assert.equal(s.image.geometry.height,90)
}))
test('remote text choice supports consecutive undo and redo after a later save',async()=>exercise(async s=>{
 s.texts.edit(initial,1,'Rejected own');s.peerText('Peer text');s.texts.resolve(s.run,s.revision,false);s.texts.edit(s.run,s.revision,'Later own');await s.controller.save(s.revision)
 await s.history.step('undo');assert.equal(s.texts.get('text')?.text,'Peer text')
 await s.history.step('undo');assert.equal(s.texts.get('text')?.text,'Rejected own');assert.ok(s.texts.get('text')?.remote)
 await s.history.step('redo');assert.equal(s.texts.get('text')?.text,'Peer text');assert.equal(s.texts.get('text')?.remote,undefined)
 await s.history.step('redo');assert.equal(s.texts.size,0);assert.equal(s.run.text,'Later own')
}))
test('history continuation survives an interleaved target but cannot bypass a new peer conflict',async()=>exercise(async s=>{
 ownImage(s);s.images.resolve('picture',false);s.texts.edit(initial,1,'Other target input');s.images.edit(s.image,s.revision,{...s.image.geometry,width:200},0,'width');await s.controller.save(s.revision,'picture')
 await s.history.step('undo');await s.history.step('undo');assert.equal(s.texts.size,0)
 await s.history.step('undo');assert.equal(s.images.get('picture')?.geometry.width,130);assert.ok(s.images.get('picture')?.remote)
 await s.history.step('redo');assert.equal(s.images.get('picture')?.geometry.width,150)
 // The same choice is undone again after another participant changes its field.
 s.peerImage({width:230});await s.history.step('undo');assert.ok(s.images.get('picture')?.remote)
 await s.history.step('redo');assert.ok(s.images.get('picture')?.remote);await assert.rejects(s.controller.save(s.revision),/draftsNotReady/)
 await s.history.step('undo');s.peerImage({width:240})
 await assert.rejects(s.history.step('redo'),/historyConflict/);assert.equal(s.image.geometry.width,240)
}))
test('a superseded local choice cannot borrow a later save and undo another decision',async()=>exercise(async s=>{
 ownImage(s);s.images.resolve('picture',true)
 s.peerImage({width:180});s.images.resolve('picture',false)
 s.images.edit(s.image,s.revision,{...s.image.geometry,width:200},0,'width');await s.controller.save(s.revision)
 await s.history.step('undo');await s.history.step('undo');assert.ok(s.images.get('picture')?.remote)
 s.images.resolve('picture',true);await s.controller.save(s.revision);assert.equal(s.image.geometry.width,130)
 s.history.skip('undo',s.history.snapshot())
 await s.history.step('undo');assert.equal(s.images.size,0);assert.equal(s.image.geometry.width,130)
}))
