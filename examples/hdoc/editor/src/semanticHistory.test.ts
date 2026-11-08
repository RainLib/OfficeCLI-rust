import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'
import { acknowledgeImages, captureImages, CollaborativeImageDraftStore, imageDraftMap, reconcileImageBaseline } from './collaborativeImages.ts'
import type { PositionedImage } from './imageDrafts.ts'
import { SemanticHistory } from './semanticHistory.ts'

const image: PositionedImage = { nodeId: `n_${'1'.repeat(32)}`, visualHash: 'a'.repeat(64), assetHash: 'b'.repeat(64), geometry: { x: 1, y: 2, width: 30, height: 40, unit: 'pt' } }
const saved = (width = 30): PositionedImage => ({ ...image, visualHash: 'c'.repeat(64), geometry: { ...image.geometry, width } })
const replacement = 'd'.repeat(64)
const otherReplacement = 'e'.repeat(64)

function peers() {
  const a = new Y.Doc(), b = new Y.Doc()
  return { a, b, sa: new CollaborativeImageDraftStore(a), sb: new CollaborativeImageDraftStore(b) }
}
function sync(a: Y.Doc, b: Y.Doc) {
  const update = Y.encodeStateAsUpdate(a)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, update)
}

test('recovered image fields become a new local intent and support personal undo without removing peer changes',async()=>{
 const {a,b,sa,sb}=peers(),history=new SemanticHistory(sa,new Y.UndoManager(a.getXmlFragment('default')),()=>false,async()=>({image,revision:1}));history.connect()
 try{
  assert.equal(sa.applyRecovery(image,1,{...image.geometry,x:9},replacement),true)
  const recovered=imageIntentsForTest(a)[0];assert.equal(recovered.clientId,a.clientID);assert.deepEqual(recovered.touched,['assetHash','x']);assert.equal(recovered.ancestors.length,0)
  sb.edit(image,1,{...image.geometry,height:80},undefined,'height');sync(a,b)
  await history.step('undo');const remaining=imageIntentsForTest(a);assert.equal(remaining.length,1);assert.equal(remaining[0].clientId,b.clientID);assert.deepEqual(remaining[0].touched,['height'])
  assert.throws(()=>sa.applyRecovery(image,1,{...image.geometry,x:11}),/room-draft/)
 }finally{history.dispose();a.destroy();b.destroy()}
})
function imageIntentsForTest(doc:Y.Doc){return [...doc.getMap(imageDraftMap).values()] as Array<{clientId:number;touched:string[];ancestors:string[]}>}

test('image undo restores only the local field and leaves a peer field in place', async () => {
  const { a, b, sa, sb } = peers()
  const undo = new Y.UndoManager(a.getXmlFragment('default'))
  const history = new SemanticHistory(sa, undo, () => false,async()=>({image,revision:1}))
  history.connect()
  try {
    sa.edit(image, 1, { ...image.geometry, x: 9 })
    sb.edit(image, 1, { ...image.geometry, width: 80 })
    sync(a, b)
    assert.equal(undo.undoStack.length, 0)
    await history.step('undo')
    const sent = captureImages(a)[0].change
    assert.equal(sent.geometry.x, 1)
    assert.equal(sent.geometry.width, 80)
    assert.equal(b.getMap(imageDraftMap).size >= 1, true)
  } finally { history.dispose(); a.destroy(); b.destroy() }
})

test('the same field edited by a peer blocks undo and keeps both intents', async () => {
  const { a, b, sa, sb } = peers()
  const history = new SemanticHistory(sa, new Y.UndoManager(a.getXmlFragment('default')), () => false,async()=>({image,revision:1}))
  history.connect()
  try {
    sa.edit(image, 1, { ...image.geometry, x: 9 })
    sb.edit(image, 1, { ...image.geometry, x: 12 })
    sync(a, b)
    await assert.rejects(history.step('undo'), /historyConflict/)
    assert.equal(history.canUndo, true)
    assert.equal(a.getMap(imageDraftMap).size, 2)
  } finally { history.dispose(); a.destroy(); b.destroy() }
})

test('saving an image does not become an undo step, and undo writes a new intent', async () => {
  const { a, sa } = peers()
  const undo = new Y.UndoManager(a.getXmlFragment('default'))
  const history = new SemanticHistory(sa, undo, () => false,async()=>({image:saved(55),revision:2}))
  history.connect()
  try {
    sa.edit(image, 1, { ...image.geometry, width: 55 })
    const before = history.snapshot()
    const sent = captureImages(a)
    const intentId = sent[0].intentId
    acknowledgeImages(a, sent, [saved(55)], 2, 'hcd-save-coordinator')
    reconcileImageBaseline(a, saved(55), 2, new Map(), 'hcd-save-coordinator')
    assert.equal(history.snapshot(), before)
    assert.equal(undo.undoStack.length, 0)
    assert.equal(a.getMap(imageDraftMap).size, 0)
    await history.step('undo')
    const next = captureImages(a)[0]
    assert.equal(next.change.geometry.width, 30)
    assert.notEqual(next.intentId, intentId)
    assert.equal(undo.undoStack.length, 0)
  } finally { history.dispose(); a.destroy() }
})

test('choosing another image candidate can be undone back to the local asset', async () => {
  const { a, b, sa, sb } = peers()
  const history = new SemanticHistory(sa, new Y.UndoManager(a.getXmlFragment('default')), () => false,async()=>({image,revision:1}))
  history.connect()
  try {
    sa.replace(image, 1, replacement)
    sb.replace(image, 1, otherReplacement)
    sync(a, b)
    const options = sa.get(image.nodeId)!.alternatives!
    sa.resolveVariant(image.nodeId, options.find(value => value.assetHash === otherReplacement)!.intentId)
    assert.equal(captureImages(a)[0].change.assetHash, otherReplacement)
    await history.step('undo')
    assert.equal(captureImages(a)[0].change.assetHash, replacement)
  } finally { history.dispose(); a.destroy(); b.destroy() }
})

test('text and image undo in one order, and text undo does not roll back image intents', async () => {
  const doc = new Y.Doc()
  const images = new CollaborativeImageDraftStore(doc)
  const undo = new Y.UndoManager(doc.getXmlFragment('default'))
  const history = new SemanticHistory(images, undo, () => false,async()=>({image,revision:1}))
  history.connect()
  try {
    doc.transact(() => {
      const text = new Y.XmlText()
      doc.getXmlFragment('default').insert(0, [text])
      text.insert(0, 'Hello')
    })
    images.edit(image, 1, { ...image.geometry, x: 9 })
    await history.step('undo')
    assert.equal(images.size, 0)
    assert.equal(doc.getXmlFragment('default').length, 1)
    await history.step('undo')
    assert.equal(doc.getXmlFragment('default').length, 0)
    await history.step('redo')
    assert.equal(doc.getXmlFragment('default').length, 1)
    await history.step('redo')
    assert.equal(captureImages(doc)[0].change.geometry.x, 9)
  } finally { history.dispose(); doc.destroy() }
})

test('undoing a later local field preserves an earlier unsaved field',async()=>{
 const {a,sa}=peers(),manager=new Y.UndoManager(a.getXmlFragment('default'))
 const history=new SemanticHistory(sa,manager,()=>false,async()=>({image,revision:1}));history.connect()
 try{
  sa.edit(image,1,{...image.geometry,x:9},undefined,'x');sa.edit(image,1,{...image.geometry,width:55},undefined,'width')
  await history.step('undo');assert.equal(captureImages(a)[0].change.geometry.x,9);assert.equal(captureImages(a)[0].change.geometry.width,30)
  await history.step('undo');assert.equal(sa.size,0)
  await history.step('redo');await history.step('redo');assert.deepEqual(captureImages(a)[0].change.geometry,{...image.geometry,x:9,width:55})
 }finally{history.dispose();a.destroy()}
})
test('an inverse never claims another client unsaved field',async()=>{
 const {a,b,sa,sb}=peers(),history=new SemanticHistory(sa,new Y.UndoManager(a.getXmlFragment('default')),()=>false,async()=>({image,revision:1}));history.connect()
 try{
  sa.edit(image,1,{...image.geometry,x:9});sb.edit(image,1,{...image.geometry,width:80});sync(a,b);await history.step('undo')
  assert.equal(a.getMap(imageDraftMap).size,1)
  const entry=[...a.getMap(imageDraftMap).values()][0] as {clientId:number;touched:string[]};assert.equal(entry.clientId,b.clientID);assert.deepEqual(entry.touched,['width'])
 }finally{history.dispose();a.destroy();b.destroy()}
})
test('saved image undo uses the current authority and preserves a newer peer field',async()=>{
 const {a,sa}=peers();let current=saved(55)
 const history=new SemanticHistory(sa,new Y.UndoManager(a.getXmlFragment('default')),()=>false,async()=>({image:current,revision:3}));history.connect()
 try{
  sa.edit(image,1,{...image.geometry,width:55});acknowledgeImages(a,captureImages(a),[saved(55)],2,'hcd-save-coordinator')
  current={...current,geometry:{...current.geometry,height:90}};await history.step('undo');assert.deepEqual(captureImages(a)[0].change.geometry,{...image.geometry,height:90})
 }finally{history.dispose();a.destroy()}
})
test('an authoritative same-field change blocks saved undo even before its receipt arrives',async()=>{
 const {a,sa}=peers();const history=new SemanticHistory(sa,new Y.UndoManager(a.getXmlFragment('default')),()=>false,async()=>({image:saved(80),revision:3}));history.connect()
 try{
  sa.edit(image,1,{...image.geometry,width:55});acknowledgeImages(a,captureImages(a),[saved(55)],2,'hcd-save-coordinator')
  await assert.rejects(history.step('undo'),/historyConflict/);assert.equal(sa.size,0);assert.equal(history.canUndo,true)
  history.skip('undo',history.snapshot());assert.equal(history.canUndo,false)
 }finally{history.dispose();a.destroy()}
})
test('new input during an image authority check remains in history and invalidates that attempt',async()=>{
 const {a,sa}=peers(),fragment=a.getXmlFragment('default');let resolve!:(result:{image:PositionedImage;revision:number})=>void
 const history=new SemanticHistory(sa,new Y.UndoManager(fragment),()=>false,()=>new Promise(done=>{resolve=done}));history.connect()
 try{
  sa.edit(image,1,{...image.geometry,width:55});const pending=history.step('undo');fragment.insert(0,[new Y.XmlText('new input')])
  resolve({image,revision:1});await assert.rejects(pending,/historyChanged/);assert.equal(sa.get(image.nodeId)?.geometry.width,55)
  await history.step('undo');assert.equal(fragment.length,0)
 }finally{history.dispose();a.destroy()}
})
test('effect cleanup and setup retain one active action subscription',async()=>{
 const {a,sa}=peers(),history=new SemanticHistory(sa,new Y.UndoManager(a.getXmlFragment('default')),()=>false,async()=>({image,revision:1}));const cleanup=history.connect();cleanup();history.connect()
 try{sa.edit(image,1,{...image.geometry,x:9});await history.step('undo');assert.equal(history.canUndo,false);assert.equal(sa.size,0)}finally{history.dispose();a.destroy()}
})
test('a peer-deleted text action does not undo older text across an image action',async()=>{
 const {a,b,sa}=peers(),fragment=a.getXmlFragment('default'),manager=new Y.UndoManager(fragment),history=new SemanticHistory(sa,manager,()=>false,async()=>({image,revision:1}));history.connect()
 try{
  fragment.insert(0,[new Y.XmlText('older')]);sa.edit(image,1,{...image.geometry,x:9});fragment.insert(1,[new Y.XmlText('newer')]);sync(a,b);b.getXmlFragment('default').delete(1,1);sync(a,b)
  await history.step('undo');assert.equal(fragment.toString(),'older');assert.equal(sa.size,1)
  await history.step('undo');assert.equal(sa.size,0);assert.equal(fragment.toString(),'older')
  await history.step('undo');assert.equal(fragment.length,0)
 }finally{history.dispose();a.destroy();b.destroy()}
})
test('discard clears only that image target and cannot resurrect it through redo',async()=>{
 const {a,sa}=peers(),fragment=a.getXmlFragment('default'),history=new SemanticHistory(sa,new Y.UndoManager(fragment),()=>false,async()=>({image,revision:1}));history.connect()
 try{
  fragment.insert(0,[new Y.XmlText('kept')]);sa.edit(image,1,{...image.geometry,width:55});sa.discard(image.nodeId)
  await history.step('undo');assert.equal(fragment.length,0);await history.step('redo');assert.equal(fragment.toString(),'kept');assert.equal(history.canRedo,false)
 }finally{history.dispose();a.destroy()}
})
test('new image edits invalidate a text redo branch in both timelines',async()=>{
 const {a,sa}=peers(),fragment=a.getXmlFragment('default'),manager=new Y.UndoManager(fragment),history=new SemanticHistory(sa,manager,()=>false,async()=>({image,revision:1}));history.connect()
 try{
  fragment.insert(0,[new Y.XmlText('old branch')]);await history.step('undo');assert.equal(manager.canRedo(),true)
  sa.edit(image,1,{...image.geometry,x:9});assert.equal(history.canRedo,false);assert.equal(manager.canRedo(),false)
 }finally{history.dispose();a.destroy()}
})
test('a continuous image edit returning to its initial value has no undo action',()=>{
 const {a,sa}=peers(),history=new SemanticHistory(sa,new Y.UndoManager(a.getXmlFragment('default')),()=>false,async()=>({image,revision:1}),()=>100);history.connect()
 try{sa.edit(image,1,{...image.geometry,x:9});sa.edit(image,1,{...image.geometry,x:1});assert.equal(history.canUndo,false)}finally{history.dispose();a.destroy()}
})
test('initial rendering while the editor is protected is excluded from user history',async()=>{
 const {a,sa}=peers(),fragment=a.getXmlFragment('default');let ready=false
 const history=new SemanticHistory(sa,new Y.UndoManager(fragment),()=>false,async()=>({image,revision:1}),Date.now,()=>ready);history.connect()
 try{
  fragment.insert(0,[new Y.XmlText('Original')]);assert.equal(history.canUndo,false)
  ready=true;fragment.insert(1,[new Y.XmlText('user')]);await history.step('undo');assert.equal(fragment.toString(),'Original')
 }finally{history.dispose();a.destroy()}
})
