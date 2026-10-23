import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {ImageDraftStore,desiredAsset,type PositionedImage,type ImageDraft} from './imageDrafts.ts'
import {TextDraftStore} from './textDrafts.ts'
import {fixedEditPatch,captureFixedEdits} from './saveEdits.ts'
import {validateFixedDraft} from './fixedDraftJournal.ts'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const image:PositionedImage={nodeId:'image',visualHash:hash('original'),assetHash:hash('blue'),geometry:{unit:'pt',x:10,y:20,width:100,height:50}}
const snapshot=(revision:number,rect:Partial<PositionedImage['geometry']>={},assetHash=image.assetHash):PositionedImage=>({...image,visualHash:hash(`snapshot-${revision}-${JSON.stringify(rect)}-${assetHash}`),geometry:{...image.geometry,...rect},assetHash})
const local=(store:ImageDraftStore)=>store.get(image.nodeId)!
function upload(store:ImageDraftStore,asset=hash('red')){const job=store.prepareReplacement(image,1,0);job.commit(asset);job.finish()}
function patch(store:ImageDraftStore,revision:number){const session={documentId:'doc',token:'t',scope:'write' as const,format:'pptx'},captured=captureFixedEdits(revision,new TextDraftStore(),store)!;return fixedEditPatch(session,captured)}

test('ordinary local geometry merges remote height and resource without claiming either field',()=>{
 const store=new ImageDraftStore();store.edit(image,1,{...image.geometry,width:130},0,'width')
 const peer=snapshot(2,{height:75},hash('green'));store.reconcile([peer],2)
 assert.equal(local(store).base.visualHash,peer.visualHash);assert.equal(local(store).geometry.width,130);assert.equal(local(store).geometry.height,75)
 assert.equal(desiredAsset(local(store)),hash('green'));assert.equal(local(store).assetHash,undefined);assert.deepEqual(local(store).touched,['width']);assert.equal(local(store).remote,undefined)
 const body=patch(store,2);assert.deepEqual(body.operations.map(op=>op.op),['image.geometry']);assert.ok('visualHash' in body.operations[0].precondition);assert.equal(body.operations[0].precondition.visualHash,peer.visualHash)
 store.reconcile([image],1);assert.equal(local(store).geometry.height,75)
})

test('stale widgets apply only their edited field against the newest observed canonical image',()=>{
 const store=new ImageDraftStore(),peer=snapshot(2,{height:75},hash('green'))
 store.reconcile([peer],2) // No draft existed when the peer committed.
 store.edit(image,1,{...image.geometry,width:130},0,'width')
 assert.equal(local(store).base.visualHash,peer.visualHash);assert.equal(local(store).geometry.height,75);assert.equal(desiredAsset(local(store)),hash('green'));assert.equal(local(store).revision,2)
})

test('same-field choices retain disjoint local and remote edits in both directions',()=>{
 for(const keepLocal of [false,true]){
  const store=new ImageDraftStore();store.edit(image,1,{...image.geometry,width:130,x:22});upload(store)
  const peer=snapshot(2,{width:150,height:75,y:35},hash('green'));store.reconcile([peer],2)
  assert.deepEqual(new Set(local(store).conflictingFields),new Set(['width','assetHash']))
  assert.equal(local(store).geometry.height,75);assert.equal(local(store).geometry.y,35);assert.equal(local(store).geometry.x,22)
  store.resolve(image.nodeId,keepLocal)
  assert.equal(local(store).geometry.width,keepLocal?130:150);assert.equal(local(store).geometry.x,22);assert.equal(local(store).geometry.height,75)
  assert.equal(desiredAsset(local(store)),keepLocal?hash('red'):hash('green'));assert.equal(local(store).remote,undefined)
  assert.deepEqual(new Set(local(store).touched),new Set(keepLocal?['width','x','assetHash']:['x']))
 }
})

test('a conflict follows newer canonical fields and does not disappear after an unrelated local edit',()=>{
 const store=new ImageDraftStore();store.edit(image,1,{...image.geometry,width:130},0,'width')
 store.reconcile([snapshot(2,{width:150,height:75})],2)
 store.reconcile([snapshot(3,{width:150,height:80},hash('green'))],3)
 store.edit(image,1,{...image.geometry,y:35},0,'y')
 assert.deepEqual(local(store).conflictingFields,['width']);assert.equal(local(store).geometry.width,130);assert.equal(local(store).geometry.height,80);assert.equal(local(store).geometry.y,35);assert.equal(desiredAsset(local(store)),hash('green'))
 store.resolve(image.nodeId,false);assert.equal(local(store).geometry.width,150);assert.equal(local(store).geometry.y,35)
})

test('agreeing canonical fields settle individually and later peer changes to them are retained',()=>{
 const store=new ImageDraftStore();store.edit(image,1,{...image.geometry,width:130,x:22})
 store.reconcile([snapshot(2,{width:130,height:75})],2);assert.deepEqual(local(store).touched,['x'])
 store.reconcile([snapshot(3,{width:150,height:80})],3);assert.equal(local(store).geometry.width,150);assert.equal(local(store).geometry.x,22);assert.equal(local(store).remote,undefined)
})

test('late own receipt preserves newer input while retaining a later disjoint peer commit',()=>{
 for(const newer of [false,true]){
  const store=new ImageDraftStore();store.edit(image,1,{...image.geometry,width:130});const sent=structuredClone(store.entries());store.beginSave(sent)
  if(newer)store.edit(image,1,{...image.geometry,width:100},0,'width')
  store.reconcile([snapshot(3,{width:130,height:75},hash('green'))],3)
  store.acknowledge(sent,2,[snapshot(2,{width:130})]);store.endSave(sent)
  if(newer){assert.equal(local(store).geometry.width,100);assert.equal(local(store).geometry.height,75);assert.equal(desiredAsset(local(store)),hash('green'));assert.equal(local(store).remote,undefined);assert.equal(local(store).revision,3)}
  else{assert.equal(store.size,0);assert.equal(store.currentImage(image,1).geometry.height,75);assert.equal(store.currentImage(image,1).assetHash,hash('green'))}
 }
})

test('a peer revert after an unseen own commit is still an explicit conflict at receipt time',()=>{
 const store=new ImageDraftStore();store.edit(image,1,{...image.geometry,width:130});const sent=structuredClone(store.entries());store.beginSave(sent)
 store.reconcile([snapshot(3,{width:100,height:75})],3) // Own r2 was not observed.
 store.acknowledge(sent,2,[snapshot(2,{width:130})]);store.endSave(sent)
 assert.deepEqual(local(store).conflictingFields,['width']);assert.equal(local(store).geometry.height,75);assert.equal(local(store).geometry.width,130);assert.equal(local(store).remote?.image.geometry.width,100)
})

test('v3 backups preserve authored reversions and conflicts without changing the captured request body',()=>{
 const store=new ImageDraftStore();store.edit(image,1,{...image.geometry,width:130});const attempt=captureFixedEdits(1,new TextDraftStore(),store)!
 store.beginSave(attempt.images);store.edit(image,1,{...image.geometry,width:100},0,'width')
 const saved=validateFixedDraft({version:3,texts:[],images:store.entries(),attempt})
 assert.equal(saved.version,3);assert.deepEqual(saved.images[0][1].touched,['width'])
 const reopened=new ImageDraftStore();reopened.restore(saved.images);reopened.beginSave(saved.attempt!.images)
 const before=JSON.stringify(fixedEditPatch({documentId:'doc',token:'t',scope:'write',format:'pptx'},saved.attempt!))
 reopened.reconcile([snapshot(3,{width:130,height:75})],3);reopened.acknowledge(saved.attempt!.images,2,[snapshot(2,{width:130})]);reopened.endSave(saved.attempt!.images)
 assert.equal(local(reopened).geometry.width,100);assert.equal(local(reopened).geometry.height,75)
 assert.equal(JSON.stringify(fixedEditPatch({documentId:'doc',token:'t',scope:'write',format:'pptx'},saved.attempt!)),before)
 const legacy=structuredClone(saved.images);delete legacy[0][1].touched
 const old=new ImageDraftStore();old.restore(legacy);old.beginSave(saved.attempt!.images);old.reconcile([snapshot(2,{width:130})],2);old.acknowledge(saved.attempt!.images,2,[snapshot(2,{width:130})]);old.endSave(saved.attempt!.images)
 assert.equal(local(old).geometry.width,100)
})

test('uploads bind resource choice before completion while adopting remote geometry',()=>{
 for(const changeAsset of [false,true]){
  const store=new ImageDraftStore(),job=store.prepareReplacement(image,1,0)
  store.reconcile([snapshot(2,{height:75},changeAsset?hash('green'):image.assetHash)],2)
  job.commit(hash('red'));job.finish()
  assert.equal(local(store).geometry.height,75);assert.equal(local(store).base.geometry.height,75)
  assert.deepEqual(local(store).conflictingFields,changeAsset?['assetHash']:undefined)
  if(changeAsset){store.resolve(image.nodeId,false);assert.equal(store.size,0)}
 }
})

test('deletion during upload is retained, stale observations and old receipts cannot resurrect it',()=>{
 const store=new ImageDraftStore(),job=store.prepareReplacement(image,1,0)
 store.markDeleted(image.nodeId,3);job.commit(hash('red'));job.finish()
 assert.equal(local(store).deleted,true);store.reconcile([image],2);assert.equal(local(store).deleted,true)
 assert.throws(()=>patch(store,3),/draftsNotReady/)
})

test('source restoration participates as a resource field while disjoint geometry still merges',()=>{
 const red=snapshot(1,{},hash('red')),store=new ImageDraftStore()
 store.applyHistory(red,1,{...red,assetHash:null})
 store.reconcile([{...snapshot(2,{height:75}),assetHash:hash('red')}],2)
 assert.equal(local(store).restoreSource,true);assert.equal(local(store).geometry.height,75);assert.equal(local(store).remote,undefined)
 store.reconcile([snapshot(3,{height:80},hash('green'))],3)
 assert.deepEqual(local(store).conflictingFields,['assetHash']);store.resolve(image.nodeId,true)
 assert.equal(local(store).restoreSource,true);assert.equal(local(store).geometry.height,80)
})

test('invalid field metadata is rejected rather than silently dropping recovery intent',()=>{
 const store=new ImageDraftStore();store.edit(image,1,{...image.geometry,width:130});const state={version:3,texts:[],images:store.entries(),attempt:null}
 assert.throws(()=>validateFixedDraft({...state,images:[[image.nodeId,{...local(store),touched:['width','width']}]]}),/Invalid/)
 assert.throws(()=>validateFixedDraft({...state,images:[[image.nodeId,{...local(store),conflictingFields:['token']}]]}),/Invalid/)
 for(const version of [1,2])assert.equal(validateFixedDraft({...state,version}).version,3)
})


test('legacy conflict edits retain the disputed field while merging the latest unedited fields',()=>{
 const store=new ImageDraftStore(),peer=snapshot(2,{width:150,height:75},hash('green'))
 const legacy:ImageDraft={base:image,revision:1,geometry:{...image.geometry,width:130},remote:{image:peer,revision:2}}
 store.restore([[image.nodeId,legacy]])
 store.edit(image,1,{...image.geometry,y:35},0,'y')
 assert.deepEqual(local(store).conflictingFields,['width']);assert.equal(local(store).geometry.height,75);assert.equal(local(store).geometry.y,35)
 store.resolve(image.nodeId,false);assert.equal(local(store).geometry.width,150);assert.equal(local(store).geometry.y,35);assert.equal(local(store).geometry.height,75)
})

test('upload-only targets remain in authoritative refresh tracking and cached images exclude rendering bytes',()=>{
 const store=new ImageDraftStore(),job=store.prepareReplacement(image,1,0)
 assert.deepEqual(store.trackingIds,[image.nodeId]);assert.equal(store.size,0)
 const peer={...snapshot(2,{height:75}),preview:'data:image/png;base64,private-rendering-only'}
 store.reconcile([peer],2);assert.equal(store.currentImage(image,1).preview,undefined)
 job.commit(hash('red'));job.finish();assert.equal(local(store).base.preview,undefined);assert.equal(local(store).geometry.height,75)
 store.discard(image.nodeId);assert.deepEqual(store.trackingIds,[])
})
