import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'
import { applyImageReplacement, acknowledgeImages, captureImages, CollaborativeImageDraftStore, imageDraftContents, imageDraftDigest, imageDraftMap, reconcileImageBaseline } from './collaborativeImages.ts'
import type { PositionedImage } from './imageDrafts.ts'
const image: PositionedImage={nodeId:`n_${'1'.repeat(32)}`,visualHash:'a'.repeat(64),assetHash:'b'.repeat(64),geometry:{x:1,y:2,width:30,height:40,unit:'pt'},preview:'data:image/png;base64,never-share-this'}
const saved=(x:number,width=30):PositionedImage=>({...image,visualHash:'c'.repeat(64),geometry:{...image.geometry,x,width}})
const replacement='d'.repeat(64), otherReplacement='e'.repeat(64)
const replaced=(assetHash=replacement):PositionedImage=>({...image,assetHash,visualHash:'f'.repeat(64)})

test('replacement and geometry merge across peers, survive encoding, and require the exact asset receipt',()=>{
  const {a,b,sa,sb}=peers()
  try{
    sa.replace(image,1,replacement);sb.edit(image,1,{...image.geometry,width:55});sync(a,b)
    const sent=captureImages(a);assert.equal(sent[0].change.assetHash,replacement);assert.equal(sent[0].change.geometry.width,55)
    assert.doesNotMatch(imageDraftContents(a),/never-share/)
    const restored=new Y.Doc();Y.applyUpdate(restored,Y.encodeStateAsUpdate(a));assert.deepEqual(captureImages(restored),sent);restored.destroy()
    assert.throws(()=>acknowledgeImages(a,sent,[{...replaced(otherReplacement),geometry:{...image.geometry,width:55}}],2,'test'),/captured asset/)
    assert.equal(a.getMap(imageDraftMap).size,2)
    acknowledgeImages(a,sent,[{...replaced(),geometry:{...image.geometry,width:55}}],2,'test');sync(a,b)
    assert.equal(sa.size,0);assert.equal(sb.currentImage(image,1).assetHash,replacement)
  }finally{a.destroy();b.destroy()}
})

test('identical concurrent replacements coalesce; different replacements need an explicit candidate',()=>{
  for(const identical of [true,false]){
    const {a,b,sa,sb}=peers()
    try{
      sa.replace(image,1,replacement);sb.replace(image,1,identical?replacement:otherReplacement);sync(a,b)
      if(identical){assert.equal(captureImages(a)[0].change.assetHash,replacement);assert.equal(captureImages(a)[0].intentIds.length,2)}
      else{
        assert.throws(()=>captureImages(a),/conflict/)
        const options=sa.get(image.nodeId)!.alternatives!
        assert.deepEqual(options.map(value=>value.assetHash).sort(),[replacement,otherReplacement].sort())
        sa.resolveVariant(image.nodeId,options.find(value=>value.assetHash===otherReplacement)!.intentId)
        assert.equal(captureImages(a)[0].change.assetHash,otherReplacement)
      }
    }finally{a.destroy();b.destroy()}
  }
})

test('geometry input retains replacement and late acknowledgement preserves a causal asset reversion',()=>{
  const doc=new Y.Doc(),store=new CollaborativeImageDraftStore(doc)
  try{
    store.replace(image,1,replacement);store.edit(image,1,{...image.geometry,width:55},undefined,'width')
    const sent=captureImages(doc);assert.equal(sent[0].change.assetHash,replacement)
    store.replace(image,1,image.assetHash!)
    acknowledgeImages(doc,sent,[{...replaced(),geometry:{...image.geometry,width:55}}],2,'test')
    const next=captureImages(doc)[0];assert.equal(next.change.assetHash,image.assetHash);assert.equal(next.change.geometry.width,55)
    assert.equal(next.base!.assetHash,replacement)
  }finally{doc.destroy()}
})

test('an unseen replacement arriving during acknowledgement retains both resources',()=>{
  const {a,b,sa,sb}=peers()
  try{
    sa.replace(image,1,replacement);const sent=captureImages(a)
    sb.replace(image,1,otherReplacement);Y.applyUpdate(a,Y.encodeStateAsUpdate(b))
    acknowledgeImages(a,sent,[replaced()],2,'test')
    assert.throws(()=>captureImages(a),/conflict/)
    assert.deepEqual(sa.get(image.nodeId)!.alternatives!.map(value=>value.assetHash).sort(),[replacement,otherReplacement].sort())
    const choice=sa.get(image.nodeId)!.alternatives!.find(value=>value.assetHash===otherReplacement)!
    sa.resolveVariant(image.nodeId,choice.intentId);assert.equal(captureImages(a)[0].change.assetHash,otherReplacement)
  }finally{a.destroy();b.destroy()}
})

test('immutable replacement baselines rebase disjoint geometry and retain overlapping resource choices',()=>{
  for(const overlapping of [true,false]){
    const doc=new Y.Doc(),store=new CollaborativeImageDraftStore(doc)
    try{
      if(overlapping)store.replace(image,1,otherReplacement);else store.edit(image,1,{...image.geometry,x:8})
      const originals=new Map([...doc.getMap(imageDraftMap).keys()].map(id=>[id,image]))
      reconcileImageBaseline(doc,replaced(),2,originals,'test')
      if(overlapping){assert.throws(()=>captureImages(doc),/conflict/);assert.deepEqual(store.get(image.nodeId)!.alternatives!.map(value=>value.assetHash).sort(),[replacement,otherReplacement].sort())}
      else{const sent=captureImages(doc)[0];assert.equal(sent.base!.assetHash,replacement);assert.equal(sent.change.geometry.x,8);assert.equal(sent.change.assetHash,undefined)}
    }finally{doc.destroy()}
  }
})
function peers(){const a=new Y.Doc(),b=new Y.Doc();return{a,b,sa:new CollaborativeImageDraftStore(a),sb:new CollaborativeImageDraftStore(b)}}
function sync(a:Y.Doc,b:Y.Doc){const update=Y.encodeStateAsUpdate(a);Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(b,update)}

test('simultaneous different image fields merge and captured acknowledgements clear only their intent IDs',async()=> {
  const {a,b,sa,sb}=peers()
  try{
    sa.edit(image,1,{...image.geometry,x:12});sb.edit(image,1,{...image.geometry,width:50});sync(a,b)
    assert.equal(sa.size,1);assert.equal(sb.get(image.nodeId)?.geometry.x,12);assert.equal(sa.get(image.nodeId)?.geometry.width,50)
    assert.equal(sa.get(image.nodeId)?.remote,undefined);assert.equal(a.getMap(imageDraftMap).size,2)
    assert.equal(await imageDraftDigest(a),await imageDraftDigest(b));assert.doesNotMatch(imageDraftContents(a),/never-share/)
    const sent=captureImages(a);assert.equal(sent[0].intentIds.length,2)
    acknowledgeImages(a,sent,[saved(12,50)],2,'test');sync(a,b)
    assert.equal(sa.size,0);assert.equal(sb.size,0);assert.equal(sb.currentImage(image,1).geometry.width,50)
  }finally{a.destroy();b.destroy()}
})

test('same-field concurrent values remain visible until explicitly resolved',()=>{
  const {a,b,sa,sb}=peers()
  try{
    sa.edit(image,1,{...image.geometry,x:12});sb.edit(image,1,{...image.geometry,x:22});sync(a,b)
    assert.equal(sa.get(image.nodeId)?.geometry.x,12);assert.equal(sb.get(image.nodeId)?.geometry.x,22)
    assert.equal(sa.get(image.nodeId)?.remote?.image.geometry.x,22);assert.equal(sb.get(image.nodeId)?.remote?.image.geometry.x,12)
    assert.throws(()=>captureImages(a),/image-drafts-conflict/)
    assert.throws(()=>sa.edit(image,1,{...image.geometry,y:4}),/Resolve/)
    sa.resolve(image.nodeId,true);sync(a,b)
    assert.equal(captureImages(b)[0].change.geometry.x,12);assert.equal(a.getMap(imageDraftMap).size,1)
  }finally{a.destroy();b.destroy()}
})

test('late acknowledgements rebase unseen fields and retain an explicit reversion',()=>{
  for(const revert of [true,false]){
    const {a,b,sa,sb}=peers()
    try{
      sa.edit(image,1,{...image.geometry,x:12});const sent=captureImages(a)
      a.getMap('hcdSave').set('imageAttempt','pending')
      if(revert)sa.edit(image,1,image.geometry)
      else {sb.edit(image,1,{...image.geometry,y:9});sync(a,b)}
      acknowledgeImages(a,sent,[saved(12)],2,'test');a.getMap('hcdSave').delete('imageAttempt')
      const next=captureImages(a)[0].change.geometry
      assert.equal(next.x,revert?1:12);assert.equal(next.y,revert?2:9)
      assert.equal(sa.get(image.nodeId)?.base.visualHash,'c'.repeat(64))
    }finally{a.destroy();b.destroy()}
  }
})

test('invalid numbers remain durable and schema corruption cannot silently disappear',async()=>{
  const doc=new Y.Doc(),store=new CollaborativeImageDraftStore(doc)
  try{
    store.edit(image,1,{...image.geometry,width:NaN});assert.match(imageDraftContents(doc),/invalidNumber/)
    assert.throws(()=>captureImages(doc),/image-drafts-not-ready/)
    const copy=new Y.Doc();Y.applyUpdate(copy,Y.encodeStateAsUpdate(doc));assert.equal(Number.isNaN(new CollaborativeImageDraftStore(copy).get(image.nodeId)?.geometry.width),true);copy.destroy()
    doc.getMap(imageDraftMap).set('bad',{geometry:null});assert.throws(()=>imageDraftContents(doc),/Invalid/)
  }finally{doc.destroy()}
})

test('discard during an unresolved save is blocked and observers can cleanly reconnect',()=>{
  const doc=new Y.Doc(),store=new CollaborativeImageDraftStore(doc);let changes=0
  const stop=store.subscribe(()=>changes++),disconnect=store.connect()
  try{
    store.edit(image,1,{...image.geometry,x:12});doc.getMap('hcdSave').set('imageAttempt','pending')
    store.discard(image.nodeId);assert.equal(store.size,1)
    disconnect();const before=changes;doc.getMap('hcdSave').delete('imageAttempt');assert.equal(changes,before)
    const detach=store.connect();store.discard(image.nodeId);assert.equal(store.size,0);detach()
  }finally{stop();doc.destroy()}
})


test('a stale rendered field cannot overwrite another field already received from a collaborator',()=>{
  const doc=new Y.Doc(),store=new CollaborativeImageDraftStore(doc)
  try{
    store.edit(image,1,{...image.geometry,x:12},undefined,'x')
    // The width input still holds an older geometry object from before React
    // rendered the new x. Only the actual width event is an edit intent.
    store.edit(image,1,{...image.geometry,width:50},undefined,'width')
    assert.equal(captureImages(doc)[0].change.geometry.x,12)
    assert.equal(captureImages(doc)[0].change.geometry.width,50)
  }finally{doc.destroy()}
})

test('three simultaneous writers retain every alternative and can explicitly select the third value',()=>{
  const a=new Y.Doc(),b=new Y.Doc(),c=new Y.Doc(),sa=new CollaborativeImageDraftStore(a),sb=new CollaborativeImageDraftStore(b),sc=new CollaborativeImageDraftStore(c)
  try{
    sa.edit(image,1,{...image.geometry,x:12});sb.edit(image,1,{...image.geometry,x:22});sc.edit(image,1,{...image.geometry,x:32})
    Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(a,Y.encodeStateAsUpdate(c))
    const options=sa.get(image.nodeId)!.alternatives!
    assert.deepEqual(options.map(value=>value.geometry.x).sort((a,b)=>a-b),[12,22,32])
    sa.resolveVariant(image.nodeId,options.find(value=>value.geometry.x===32)!.intentId)
    assert.equal(captureImages(a)[0].change.geometry.x,32);assert.equal(a.getMap(imageDraftMap).size,1)
  }finally{a.destroy();b.destroy();c.destroy()}
})


test('an unseen overlapping intent arriving during acknowledgement keeps the committed value as an alternative',()=>{
  const {a,b,sa,sb}=peers()
  try{
    sa.edit(image,1,{...image.geometry,x:12});const sent=captureImages(a)
    sb.edit(image,1,{...image.geometry,x:22});Y.applyUpdate(a,Y.encodeStateAsUpdate(b))
    acknowledgeImages(a,sent,[saved(12)],2,'test')
    assert.equal(sa.get(image.nodeId)?.base.visualHash,'c'.repeat(64))
    assert.deepEqual(sa.get(image.nodeId)!.alternatives!.map(value=>value.geometry.x).sort((a,b)=>a-b),[12,22])
    assert.throws(()=>captureImages(a),/conflict/)
  }finally{a.destroy();b.destroy()}
})

test('prepared upload keeps concurrent geometry and blocks departure until its staged intent is registered',()=>{
  const {a,b,sa,sb}=peers()
  try{
    const upload=sa.prepareReplacement(image,1);assert.equal(sa.uploading,true);assert.equal(sa.saving,true)
    sb.edit(image,1,{...image.geometry,width:77});sync(a,b)
    upload.commit(replacement);upload.finish();upload.finish()
    assert.equal(sa.uploading,false);assert.equal(sa.saving,false)
    const sent=captureImages(a)[0].change;assert.equal(sent.assetHash,replacement);assert.equal(sent.geometry.width,77)
    assert.throws(()=>upload.commit(otherReplacement),/Invalid replacement upload/)
  }finally{a.destroy();b.destroy()}
})

test('sequential prepared replacement supersedes the seen resource while retaining geometry; unseen resources conflict',()=>{
  const {a,b,sa,sb}=peers()
  try{
    sa.replace(image,1,replacement);sa.edit(image,1,{...image.geometry,width:77},undefined,'width')
    const upload=sa.prepareReplacement(image,1);upload.commit(otherReplacement);upload.finish()
    const sent=captureImages(a)[0].change;assert.equal(sent.assetHash,otherReplacement);assert.equal(sent.geometry.width,77)
    const next=sa.prepareReplacement(image,1)
    sb.replace(image,1,'1'.repeat(64));sync(a,b)
    next.commit('2'.repeat(64));next.finish()
    assert.throws(()=>captureImages(a),/conflict/)
    assert.ok(sa.get(image.nodeId)!.alternatives!.some(value=>value.assetHash==='1'.repeat(64)))
    assert.ok(sa.get(image.nodeId)!.alternatives!.some(value=>value.assetHash==='2'.repeat(64)))
  }finally{a.destroy();b.destroy()}
})
test('server-acknowledged replacement from an older window can be undone before save without claiming peer geometry',()=>{
 const doc=new Y.Doc(),store=new CollaborativeImageDraftStore(doc),original={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),assetHash:'c'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:72,height:36}},own=crypto.randomUUID(),peer=crypto.randomUUID(),asset='d'.repeat(64)
 try{applyImageReplacement(doc,{base:original,revision:1,clientId:123,seen:[]},asset,undefined,own);doc.getMap(imageDraftMap).set(peer,{intentId:peer,clientId:456,ancestors:[],base:original,revision:1,geometry:{...original.geometry,width:90},touched:['width']});store.acceptServerReplacement(own,original.nodeId,asset,123);store.applyHistory(original,1,original,undefined,['assetHash']);assert.equal(doc.getMap(imageDraftMap).has(own),false);assert.equal(doc.getMap(imageDraftMap).has(peer),true)}finally{doc.destroy()}
})
test('an unclaimed peer reversion to the canonical value is a conflict, not a successful no-op undo',()=>{
 const doc=new Y.Doc(),store=new CollaborativeImageDraftStore(doc),original={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),assetHash:'c'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:72,height:36}},peer=crypto.randomUUID()
 try{applyImageReplacement(doc,{base:original,revision:1,clientId:123,seen:[]},'d'.repeat(64),undefined,peer);assert.throws(()=>store.applyHistory(original,1,original,undefined,['assetHash']),/historyConflict/);assert.equal(doc.getMap(imageDraftMap).has(peer),true)}finally{doc.destroy()}
})
