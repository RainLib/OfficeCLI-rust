/** Real-client exercise used only by the isolated native layout fixture. */
import assert from 'node:assert/strict'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {WordRegionStore,wordRegionStoreField} from '../examples/hdoc/editor/src/wordRegionStore.ts'
import {WordSaveCoordinator} from '../examples/hdoc/editor/src/wordSaveCoordinator.ts'
import {WordCheckpointJournal} from '../examples/hdoc/editor/src/wordCheckpointJournal.ts'
import {CollaborativeImageDraftStore,imageIntents} from '../examples/hdoc/editor/src/collaborativeImages.ts'

type Client={doc:Y.Doc;model:WordRegionStore}
export async function exerciseLayoutLive({owner,journal,alice,bob,request,wait,setHook,submissions}: {
 owner:WordSaveCoordinator;journal:WordCheckpointJournal;alice:Client;bob:Client
 request:(route:string,init?:RequestInit)=>Promise<Response>;wait:(check:()=>boolean)=>Promise<void>
 setHook:(hook:((response:Response)=>Promise<void>)|undefined)=>void;submissions:()=>number
}){
 const region=owner.model.layoutState().layout.sections[0].id,header=owner.model.layoutState().layout.stories.find(story=>story.kind==='header')!.id,footer=owner.model.layoutState().layout.stories.find(story=>story.kind==='footer')!.id
 const edit=(client:Client,id:string,text:string)=>{const before=client.model.region(id),item=before.find(entry=>entry.node.type.name==='paragraph'&&entry.node.firstChild?.isText);assert.ok(item);client.model.reconcile(id,before,before.map(entry=>entry.key===item.key?{key:item.key,node:item.node.type.createChecked(item.node.attrs,client.model.schema.text(text,item.node.firstChild!.marks))}:entry))}
 const sync=async()=>{
  const revision=owner.state().revision,response=await request(`/editor?revision=${revision}`);assert.equal(response.status,200);const projection=await response.json();assert.equal(projection.revision,revision)
  await wait(()=>[alice,bob].every(client=>client.doc.getMap(wordRegionStoreField).get('layoutHash')===projection.flowLayoutHash))
  for(const client of [alice,bob])client.model.syncLayout(projection.flowLayout,projection.flowLayoutHash)
 }
 edit(bob,header,'Live header from Bob 😀');edit(alice,footer,'Live footer from Alice 😀');await wait(()=>owner.model.project(header).textContent.includes('Live header from Bob')&&owner.model.project(footer).textContent.includes('Live footer from Alice'))
 const before=owner.state().revision,imagesResponse=await request(`/images?revision=${before}`);assert.equal(imagesResponse.status,200);const image=(await imagesResponse.json()).entries[0];assert.ok(image?.assetHash)
 const capturedWidth=Math.round(image.geometry.width*.8),finalWidth=Math.round(image.geometry.width*.6)
 new CollaborativeImageDraftStore(alice.doc).edit(image,before,{...image.geometry,width:capturedWidth},undefined,'width');await wait(()=>imageIntents(owner.model.document).length===1)
 let entered!:()=>void,release!:()=>void;const arrived=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve)
 try{
  setHook(async response=>{setHook(undefined);assert.ok(response.ok);entered();await held})
  const saving=owner.save();await Promise.race([arrived,saving.then(()=>{throw Error('live submission finished before fixture hold')})])
  edit(bob,region,'Bob typed during live submission 😀')
  new CollaborativeImageDraftStore(alice.doc).edit(image,before,{...image.geometry,width:finalWidth},undefined,'width')
  await wait(()=>owner.model.project(region).textContent.includes('Bob typed during live submission')&&imageIntents(owner.model.document).some(entry=>entry.geometry.width===finalWidth))
  await owner.persist();const late=(await journal.load())!.capsule;assert.equal(late.pending!.request.coordinatorVersion,6);assert.ok(late.actors.some(actor=>actor.userId==='bob'))
  release();assert.equal((await saving).status,'editing');assert.equal(owner.state().revision,before+1);assert.equal(owner.model.project(region).textContent,'Bob typed during live submission 😀');owner.assertAcceptingPackets()
  await sync();assert.equal((await owner.save()).status,'saved');assert.equal(owner.state().revision,before+2);await sync()
  edit(bob,header,'Live header with lost response 😀');await wait(()=>owner.model.project(header).textContent.includes('lost response'))
  setHook(async response=>{setHook(undefined);assert.ok(response.ok);throw Error('fixture-live-response-lost')})
  await assert.rejects(owner.save(),/fixture-live-response-lost/);const original=(await journal.load())!.capsule.pending!.request,posted=submissions()
  edit(alice,region,'Alice after unknown live outcome 😀');await wait(()=>owner.model.project(region).textContent.includes('Alice after unknown'))
  await owner.persist();assert.deepEqual((await journal.load())!.capsule.pending!.request,original)
  assert.equal((await owner.save()).status,'editing');assert.equal(submissions(),posted);assert.equal(owner.state().revision,before+3);await sync()
  assert.equal((await owner.save()).status,'saved');assert.equal(owner.state().revision,before+4);await sync();owner.assertAcceptingPackets()
  assert.equal(submissions(),4)
  return{revision:owner.state().revision,imageNodeId:image.nodeId,imageAssetHash:image.assetHash,imageWidth:finalWidth,continuousLiveSave:true,lateTextAndImageDurableDuringSubmission:true,bodyAndHeaderFooterAndImageSavedTogether:true,unknownResponseRecoveredWithoutResubmission:true,liveEditSubmissions:submissions(),finalBody:'Alice after unknown live outcome 😀',finalHeader:'Live header with lost response 😀',finalFooter:'Live footer from Alice 😀'}
 }finally{release();setHook(undefined)}
}
