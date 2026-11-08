import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ImageDraftStore, validGeometry, type PositionedImage } from './imageDrafts.ts'
import { TextDraftStore } from './textDrafts.ts'
import { saveEdits } from './saveEdits.ts'

const image: PositionedImage = { nodeId: 'picture', visualHash: 'original', assetHash: 'asset', geometry: { x: 1, y: 2, width: 30, height: 40, unit: 'pt' } }
const positioned = (x: number, hash = `at-${x}`): PositionedImage => ({ ...image, visualHash: hash, geometry: { ...image.geometry, x } })

test('image drafts survive unmounts, off-screen reloads and unrelated revisions', () => {
  const store = new ImageDraftStore()
  store.edit(image, 1, { ...image.geometry, x: 12 }, 3)
  store.reconcile([], 2)
  store.reconcile([image], 2)
  assert.equal(store.get(image.nodeId)?.geometry.x, 12)
  assert.equal(store.get(image.nodeId)?.page, 3)
  assert.equal(store.get(image.nodeId)?.remote, undefined)
  store.reconcile([positioned(22)], 3)
  store.reconcile([image], 2)
  assert.equal(store.get(image.nodeId)?.geometry.x, 12)
  assert.equal(store.get(image.nodeId)?.remote?.image.geometry.x, 22)
  store.resolve(image.nodeId, true)
  assert.equal(store.get(image.nodeId)?.base.visualHash, 'at-22')
  assert.equal(store.get(image.nodeId)?.geometry.x, 12)
  store.reconcile([positioned(25)], 4)
  store.resolve(image.nodeId, false)
  assert.equal(store.size, 0)
  assert.equal(store.currentImage(image, 1).geometry.x, 25)
})

test('image save receipts preserve newer inputs, including reverting to the original value', () => {
  const store = new ImageDraftStore()
  store.edit(image, 1, positioned(12).geometry)
  const sent = store.entries()
  store.beginSave(sent)
  store.edit(image, 1, image.geometry)
  store.reconcile([image], 1)
  store.acknowledge(sent, 2, [positioned(12)])
  store.endSave(sent)
  assert.equal(store.get(image.nodeId)?.geometry.x, 1)
  assert.equal(store.get(image.nodeId)?.base.geometry.x, 12)
  store.reconcile([positioned(12)], 2)
  assert.equal(store.get(image.nodeId)?.remote, undefined)
})

test('late image receipts do not clear a newer remote conflict or deleted object', () => {
  for (const deleted of [false, true]) {
    const store = new ImageDraftStore()
    store.edit(image, 1, positioned(12).geometry)
    const sent = store.entries()
    store.beginSave(sent)
    if (deleted) store.markDeleted(image.nodeId, 3)
    else store.reconcile([positioned(22)], 3)
    store.reconcile([image], 2)
    store.acknowledge(sent, 2, [positioned(12)])
    store.endSave(sent)
    assert.equal(store.get(image.nodeId)?.geometry.x, 12)
    assert.equal(deleted ? store.get(image.nodeId)?.deleted : store.get(image.nodeId)?.remote?.revision, deleted ? true : 3)
  }
})

test('own revision update arriving before its response can settle, then old previews use confirmed geometry', () => {
  const store = new ImageDraftStore()
  store.edit(image, 1, positioned(12).geometry)
  const sent = store.entries()
  store.beginSave(sent)
  store.reconcile([positioned(12)], 2)
  store.acknowledge(sent, 2, [positioned(12)])
  store.endSave(sent)
  assert.equal(store.size, 0)
  store.edit(image, 1, positioned(14).geometry)
  assert.equal(store.get(image.nodeId)?.base.geometry.x, 12)
  assert.equal(store.get(image.nodeId)?.revision, 2)
})

test('invalid numeric drafts are retained without serializing NaN as a valid change', () => {
  const store = new ImageDraftStore()
  for (const geometry of [{ ...image.geometry, x: NaN }, { ...image.geometry, width: 0 }, { ...image.geometry, height: Infinity }]) {
    store.edit(image, 1, geometry)
    assert.equal(validGeometry(store.get(image.nodeId)!.geometry), false)
  }
  store.markDeleted(image.nodeId, 2)
  store.reconcile([], 1)
  assert.equal(store.get(image.nodeId)?.deleted, true)
  store.discard(image.nodeId)
  assert.equal(store.size, 0)
})

test('a later unrelated revision can confirm the sent geometry, but a remote revert remains a conflict', () => {
  for (const revert of [false, true]) {
    const store = new ImageDraftStore()
    store.edit(image, 1, positioned(12).geometry)
    const sent = store.entries()
    store.beginSave(sent)
    store.reconcile([positioned(12)], 2)
    store.reconcile([revert ? image : positioned(12)], 3)
    store.acknowledge(sent, 2, [positioned(12)])
    store.endSave(sent)
    if (revert) {
      assert.equal(store.get(image.nodeId)?.geometry.x, 12)
      assert.equal(store.get(image.nodeId)?.remote?.image.visualHash, 'original')
    } else {
      assert.equal(store.size, 0)
      assert.equal(store.currentImage(image, 1).geometry.x, 12)
    }
  }
})

test('one save sends text and all image drafts with their original preconditions, and keeps newer edits', async () => {
  const texts = new TextDraftStore(), images = new ImageDraftStore()
  const text = { nodeId: 'text', nodeHash: 'text-before', text: 'before' }
  texts.edit(text, 1, 'after')
  images.edit(image, 1, positioned(12).geometry, 0)
  images.edit({ ...image, nodeId: 'off-screen' }, 1, positioned(18).geometry, 99)
  const fetchBefore = globalThis.fetch
  let finish!: (response: Response) => void
  let submitted!: () => void
  const started = new Promise<void>(resolve => { submitted = resolve })
  let requests = 0
  globalThis.fetch = async (_url, init) => {
    requests++
    const patch = JSON.parse(String(init!.body))
    assert.equal(patch.baseRevision, 1)
    assert.deepEqual(patch.operations.map((operation: { op: string }) => operation.op), ['text.splice', 'image.geometry', 'image.geometry'])
    assert.equal(patch.operations[1].precondition.visualHash, 'original')
    return new Promise<Response>(resolve => { finish = resolve; submitted() })
  }
  try {
    const save = saveEdits({ documentId: 'doc', token: 'test', format: 'pptx', scope: 'write', apiUrl: 'http://test' }, 1, texts, images)
    await Promise.race([started, save])
    texts.edit(text, 1, 'newer text')
    images.edit(image, 1, positioned(15).geometry)
    finish(Response.json({ revision: 2, nodeHashes: { text: createHash('sha256').update('after').digest('hex') }, images: [positioned(12), { ...positioned(18), nodeId: 'off-screen' }] }))
    assert.equal(await save, 2)
    assert.equal(requests, 1)
    assert.equal(texts.get('text')?.text, 'newer text')
    assert.equal(images.get(image.nodeId)?.geometry.x, 15)
    assert.equal(images.get(image.nodeId)?.base.geometry.x, 12)
    assert.equal(images.get('off-screen'), undefined)
    assert.equal(images.saving, false)
  } finally { globalThis.fetch = fetchBefore }
})

test('failed requests and invalid image dimensions never clear any text or image draft', async () => {
  const texts = new TextDraftStore(), images = new ImageDraftStore()
  texts.edit({ nodeId: 'text', text: 'old', nodeHash: 'hash' }, 1, 'new')
  images.edit(image, 1, positioned(12).geometry)
  const session = { documentId: 'doc', token: 'test', format: 'pdf', scope: 'write' as const, apiUrl: 'http://test' }
  const fetchBefore = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; return new Response('conflict', { status: 409 }) }
  try {
    await assert.rejects(saveEdits(session, 1, texts, images), /409/)
    assert.equal(texts.size, 1)
    assert.equal(images.size, 1)
    assert.equal(images.saving, false)
    images.edit(image, 1, { ...image.geometry, width: NaN })
    await assert.rejects(saveEdits(session, 1, texts, images), /draftsNotReady/)
    assert.equal(requests, 1)
  } finally { globalThis.fetch = fetchBefore }
})

const replacement='a'.repeat(64),laterReplacement='b'.repeat(64)
function replace(store:ImageDraftStore,hash=replacement){const upload=store.prepareReplacement(image,1,7);upload.commit(hash);upload.finish()}

test('staged replacements preserve geometry edits and cannot disappear when geometry returns to baseline',()=>{
 const store=new ImageDraftStore(),upload=store.prepareReplacement(image,1,7)
 assert.equal(store.saving,true);assert.equal(store.uploading,true)
 store.edit(image,1,positioned(12).geometry)
 upload.commit(replacement);upload.finish();upload.finish()
 assert.equal(store.get(image.nodeId)?.geometry.x,12)
 store.edit(image,1,image.geometry)
 assert.equal(store.get(image.nodeId)?.assetHash,replacement)
 store.reconcile([image],2)
 assert.equal(store.get(image.nodeId)?.assetHash,replacement)
 assert.equal(store.uploading,false)
 assert.throws(()=>upload.commit(laterReplacement),/Invalid/)
})

test('matching geometry with another asset neither reconciles nor acknowledges replacement drafts',()=>{
 const store=new ImageDraftStore();replace(store)
 const sent=store.entries();store.beginSave(sent)
 store.acknowledge(sent,2,[image]);assert.equal(store.size,1)
 store.endSave(sent)
 store.reconcile([{...image,assetHash:laterReplacement,visualHash:'remote-replacement'}],3)
 assert.equal(store.get(image.nodeId)?.remote?.revision,3)
 store.resolve(image.nodeId,true)
 assert.equal(store.get(image.nodeId)?.assetHash,replacement)
 assert.equal(store.get(image.nodeId)?.base.assetHash,laterReplacement)
})

test('one joint save captures the replacement and keeps a newer resource choice after its receipt',async()=>{
 const texts=new TextDraftStore(),images=new ImageDraftStore(),session={documentId:'doc',token:'test',format:'pptx',scope:'write' as const,apiUrl:'http://test'}
 texts.edit({nodeId:'text',text:'old',nodeHash:'before'},1,'new');replace(images)
 const originalFetch=globalThis.fetch
 let finish!:(response:Response)=>void
 let submitted!:()=>void
 const started=new Promise<void>(resolve=>{submitted=resolve})
 globalThis.fetch=async(_url,init)=>{
  const patch=JSON.parse(String(init!.body))
  assert.deepEqual(patch.operations.map((op:{op:string})=>op.op),['text.splice','image.replace','image.geometry'])
  assert.equal(patch.operations[1].assetHash,replacement)
  return new Promise<Response>(resolve=>{finish=resolve;submitted()})
 }
 try{
  const pending=saveEdits(session,1,texts,images)
  await Promise.race([started,pending])
  replace(images,laterReplacement)
  finish(Response.json({revision:2,nodeHashes:{text:createHash('sha256').update('new').digest('hex')},images:[{...image,assetHash:replacement,visualHash:'saved-replacement'}]}))
  await pending
  assert.equal(texts.size,0)
  assert.equal(images.get(image.nodeId)?.assetHash,laterReplacement)
  assert.equal(images.get(image.nodeId)?.base.assetHash,replacement)
  assert.equal(images.get(image.nodeId)?.revision,2)
  assert.equal(images.saving,false)
 }finally{globalThis.fetch=originalFetch}
})

test('upload pending and wrong-resource atomic receipts never clear the text subset',async()=>{
 const texts=new TextDraftStore(),images=new ImageDraftStore(),session={documentId:'doc',token:'test',format:'pdf',scope:'write' as const,apiUrl:'http://test'}
 texts.edit({nodeId:'text',text:'old',nodeHash:'before'},1,'new')
 const upload=images.prepareReplacement(image,1)
 await assert.rejects(saveEdits(session,1,texts,images),/imageUploadPending/)
 upload.commit(replacement);upload.finish()
 const originalFetch=globalThis.fetch
 globalThis.fetch=async()=>Response.json({revision:2,nodeHashes:{text:'after'},images:[image]})
 try{await assert.rejects(saveEdits(session,1,texts,images),/invalidSaveReceipt/);assert.equal(texts.size,1);assert.equal(images.size,1);assert.equal(images.saving,false)}
 finally{globalThis.fetch=originalFetch}
})
