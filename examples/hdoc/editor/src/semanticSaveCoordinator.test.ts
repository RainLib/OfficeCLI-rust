import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, createHmac } from 'node:crypto'
import * as Y from 'yjs'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { SemanticSaveCoordinator } from './semanticSaveCoordinator.ts'
import { checkpointDigest, legacyCheckpointContents } from './checkpointSnapshot.ts'
import { legacySnapshot } from './sourceIdentityMigration.ts'
import { CollaborativeImageDraftStore, imageDraftDigest, imageDraftMap, captureImages } from './collaborativeImages.ts'
import type { PositionedImage } from './imageDrafts.ts'
import { requestCoordinatedSave } from './semanticSaveClient.ts'
import { jsonToSnapshot, projectionToJson, schemaExtensions, type Projection } from './schema.ts'
import { yBlocks } from './typographyMigration.ts'

const secret = 'coordinator-test-secret-at-least-32-bytes'
const root = (revision: number) => createHash('sha256').update(`root-${revision}`).digest('hex')
const initial = (): Projection => ({ documentId: 'doc', revision: 1, blocks: [{ blockId: 'original', blockHash: 'hash', region: 'body', readOnly: false, content: { kind: 'paragraph', inlines: [{ text: 'Original' }] } }] })
const documentFor = (projection: Projection) => {
  const doc = TiptapTransformer.toYdoc(projectionToJson(projection), 'default', schemaExtensions)
  doc.getMap('hcdSchema').set('typography', 2)
  return doc
}
const edit = (doc: Y.Doc, text: string) => {
  const leaf = yBlocks(doc)[0].get(0) as Y.XmlText
  leaf.delete(0, leaf.length); leaf.insert(0, text)
}

class FakeApi {
  head = initial()
  projections = new Map<number, Projection>([[1,initial()]])
  records = new Map<number, object>([[1, { revision: 1, rootHash: root(1) }]])
  stored = new Uint8Array()
  archives: Uint8Array[] = []
  requests: any[] = []
  hold: (() => Promise<void>) | null = null
  images = new Map<string,PositionedImage>()
  imageHistory = new Map<number,Map<string,PositionedImage>>()
  omitImageReceipt = false
  failStore = false
  loseResponse = false
  writes = 0
  maxWrites = 0
  async request(route: string, init?: RequestInit): Promise<Response> {
    if(route.startsWith('/images/')) { const [id,query]=route.slice('/images/'.length).split('?revision='); const revision=query?Number(query):this.head.revision;return Response.json({revision,image:(query?this.imageHistory.get(revision):this.images)?.get(id)??null}) }
    if (route.startsWith('/editor?revision=')) return Response.json(this.projections.get(Number(route.split('=').at(-1))))
    if (route === '/revisions?limit=1') return Response.json({ headRevision: this.head.revision })
    if (route.startsWith('/revisions/')) return Response.json(this.records.get(Number(route.split('/').at(-1))))
    if (route === '/collaboration/state') {
      if (this.failStore) return new Response('', { status: 503 })
      const expected = (init!.headers as Record<string, string>)['X-HCD-State-Hash']
      const actual = this.stored.length ? createHash('sha256').update(this.stored).digest('hex') : 'none'
      if (expected !== actual) return new Response('', { status: 412 })
      this.stored = new Uint8Array(Buffer.from(init!.body as Buffer))
      return Response.json({ saved: true, stateHash: createHash('sha256').update(this.stored).digest('hex') })
    }
    if (route === '/collaboration/recovery') {
      this.archives.push(new Uint8Array(Buffer.from(init!.body as Buffer)))
      return Response.json({ recoveryId: `recovery-${this.archives.length}` })
    }
    assert.equal(route, '/checkpoints')
    const request = JSON.parse(String(init!.body)); this.requests.push(request)
    this.writes++; this.maxWrites = Math.max(this.maxWrites, this.writes)
    try {
      if (this.hold) await this.hold()
      if (request.expectedRevision !== this.head.revision) return new Response('', { status: 409 })
      for(const image of request.images??[]) if(this.images.get(image.nodeId)?.visualHash!==image.precondition.visualHash) return new Response('',{status:409})
      const savedImages=(request.images??[]).map((value:any)=> ({...this.images.get(value.nodeId),nodeId:value.nodeId,geometry:value.geometry,...(value.assetHash?{assetHash:value.assetHash}:{}),visualHash:createHash('sha256').update(JSON.stringify({geometry:value.geometry,assetHash:value.assetHash??this.images.get(value.nodeId)?.assetHash})).digest('hex')}))
      savedImages.forEach((value:PositionedImage)=>this.images.set(value.nodeId,value))
      const revision = this.head.revision + 1
      this.head = { ...this.head, revision, blocks: request.blocks.map((block: any, index: number) => ({ blockId: `canonical-${revision}-${index}`, blockHash: 'hash', region: 'body', readOnly: false, content: block.content })) }
      this.projections.set(revision,structuredClone(this.head))
      this.imageHistory.set(revision,structuredClone(this.images))
      const bodyHash = createHash('sha256').update(JSON.stringify(request.images?.length?{blocks:request.blocks,images:request.images}:request.blocks)).digest('hex')
      const unsigned = `hcdsave${request.coordinatorVersion}:${request.coordinatorId}:${request.checkpointId}:${request.coordinatorDigest}:${bodyHash}`
      const mac = createHmac('sha256', secret).update(`doc:0:${request.expectedRevision}:${unsigned}`).digest('base64url')
      this.records.set(revision, { revision, rootHash: root(revision), patchBaseRevision: request.expectedRevision, patchId: `${unsigned}:${mac}` })
      if (this.loseResponse) { this.loseResponse = false; throw new Error('response lost after commit') }
      return Response.json({ revision, rootHash: root(revision), projection: this.head, images:this.omitImageReceipt?[]:savedImages, saveMode: 'source-text' })
    } finally { this.writes-- }
  }
}
async function setup(api = new FakeApi(), doc = documentFor(initial())) {
  const states: object[] = []
  const coordinator = new SemanticSaveCoordinator({ documentId: 'doc', epoch: 0, document: doc, secret, stateHash: api.stored.length ? createHash('sha256').update(api.stored).digest('hex') : 'none', request: (route, init) => api.request(route, init), broadcast: state => states.push(state) })
  await coordinator.initialize(api.head)
  return { api, doc, coordinator, states }
}

test('manual requests share one coordinator and do not create duplicate commits', async () => {
  const { api, doc, coordinator } = await setup()
  try {
    edit(doc, 'Changed'); coordinator.changed({ userId: 'alice' })
    const digest = await checkpointDigest(jsonToSnapshot(TiptapTransformer.fromYdoc(doc, 'default')))
    const [a, b] = await Promise.all([coordinator.save(digest), coordinator.save(digest)])
    assert.equal(api.requests.length, 1)
    assert.equal(a.revision, 2); assert.equal(b.revision, 2)
    assert.equal(b.pending, false)
    assert.equal(api.maxWrites, 1)
  } finally { await coordinator.close(); doc.destroy() }
})

test('typography object key order from Rust and Yjs does not make a clean document an unbound draft', async () => {
  const api = new FakeApi()
  api.head.blocks[0].content.inlines[0].typography = { eastAsia: '宋体', family: 'Arial,serif', latin: 'Arial', sizePt: 14 }
  const doc = documentFor(api.head)
  const { coordinator } = await setup(api, doc)
  try { assert.equal(coordinator.state().status, 'saved'); assert.equal(coordinator.state().pending, false); assert.equal(api.archives.length, 0) }
  finally { await coordinator.close(); doc.destroy() }
})

test('adjacent identical source runs can bootstrap without a false draft conflict', async () => {
  const api = new FakeApi()
  api.head.blocks[0].content.inlines = [{ text:'A中😀 B', bold:true, typography:{ sizePt:14 } }, { text:'after', bold:true, typography:{ sizePt:14 } }]
  const doc = documentFor(api.head)
  const { coordinator } = await setup(api, doc)
  try {
    assert.equal(coordinator.state().status, 'saved')
    assert.equal(coordinator.state().pending, false)
    assert.equal(api.archives.length, 0)
    assert.equal(api.requests.length, 0)
  } finally { await coordinator.close(); doc.destroy() }
})

const legacyHash = (projection: Projection) => createHash('sha256').update(legacyCheckpointContents(legacySnapshot(projectionToJson(projection)))).digest('hex')
function installLegacyReceipt(doc: Y.Doc, projection: Projection, digest=legacyHash(projection)) {
  const base={version:1,documentId:'doc',epoch:0,lineage:'c'.repeat(32),revision:projection.revision,rootHash:root(projection.revision),digest}
  const value=JSON.stringify(base)
  doc.getMap('hcdSave').set('receipt',`${Buffer.from(value).toString('base64url')}.${createHmac('sha256',secret).update(value).digest('base64url')}`)
}
function legacyDocument(projection: Projection) {
  const snapshot=legacySnapshot(projectionToJson(projection))
  return documentFor({...projection,blocks:projection.blocks.map((block,index)=>({...block,content:snapshot[index].content}))})
}

test('verified v1 receipts migrate pending sizes to source-aware v2 without losing the draft', async () => {
  const api=new FakeApi(); api.head.blocks[0].content.inlines=[{text:'Original',nodeId:`n_${'1'.repeat(32)}`,typography:{family:'Arial',sizePt:14}}]
  const doc=legacyDocument(api.head); installLegacyReceipt(doc,api.head)
  const leaf=yBlocks(doc)[0].get(0) as Y.XmlText
  leaf.format(0,leaf.length,{textTypography:{family:'Arial',sizePt:28.5}})
  const {coordinator}=await setup(api,doc)
  try {
    assert.equal(coordinator.state().status,'editing'); assert.equal(coordinator.state().conflict,undefined)
    assert.equal(yBlocks(doc)[0].get(0),leaf)
    const snapshot=jsonToSnapshot(TiptapTransformer.fromYdoc(doc,'default'))
    assert.equal(snapshot[0].content.inlines[0].nodeId,api.head.blocks[0].content.inlines[0].nodeId)
    assert.equal(snapshot[0].content.inlines[0].fontSizeExplicit,true)
    await coordinator.save(await checkpointDigest(snapshot))
    assert.equal(api.requests[0].coordinatorVersion,4)
    assert.equal(coordinator.state().pending,false)
    const receipt=String(doc.getMap('hcdSave').get('receipt')).split('.')[0]
    assert.equal(JSON.parse(Buffer.from(receipt,'base64url').toString()).version,4)
  } finally {await coordinator.close();doc.destroy()}
})

test('legacy pending text or a mismatched signed baseline stays in a recoverable conflict', async () => {
  for(const changed of [true,false]) {
    const api=new FakeApi(); api.head.blocks[0].content.inlines=[{text:'Original',nodeId:`n_${'1'.repeat(32)}`,typography:{sizePt:14}},{text:' neighbor',nodeId:`n_${'2'.repeat(32)}`,typography:{sizePt:14}}]
    const doc=legacyDocument(api.head); installLegacyReceipt(doc,api.head,changed?legacyHash(api.head):'f'.repeat(64))
    if(changed) edit(doc,'pending 中文😀')
    const {coordinator}=await setup(api,doc)
    try {
      assert.equal(coordinator.state().status,'conflict');assert.equal(api.requests.length,0);assert.equal(api.archives.length,1)
      assert.equal(doc.getMap('hcdSchema').get('sourceIdentity'),undefined)
      if(changed) assert.match(TiptapTransformer.fromYdoc(doc,'default').content![0].content![0].text!,/pending 中文😀/)
    } finally {await coordinator.close();doc.destroy()}
  }
})

test('migration adopts only authenticated v1 commits from its own lineage before binding source IDs', async () => {
  const api=new FakeApi();api.head.blocks[0].content.inlines=[{text:'Original',nodeId:`n_${'1'.repeat(32)}`}]
  const baseline=structuredClone(api.head)
  api.head={...api.head,revision:2,blocks:api.head.blocks.map(block=>({...block,content:{...block.content,inlines:[{...block.content.inlines[0],text:'Committed'}]}}))}
  const doc=legacyDocument(api.head);installLegacyReceipt(doc,baseline)
  const unsigned=`hcdsave1:${'c'.repeat(32)}:${'a'.repeat(32)}:${legacyHash(api.head)}:${'b'.repeat(64)}`
  const mac=createHmac('sha256',secret).update(`doc:0:1:${unsigned}`).digest('base64url')
  api.records.set(2,{revision:2,rootHash:root(2),patchBaseRevision:1,patchId:`${unsigned}:${mac}`})
  const {coordinator}=await setup(api,doc)
  try {assert.equal(coordinator.state().revision,2);assert.equal(coordinator.state().status,'saved');assert.equal(api.archives.length,0)}
  finally {await coordinator.close();doc.destroy()}
})

test('reverting pending edits confirms the persisted document without a duplicate canonical revision', async () => {
  const { api, doc, coordinator, states } = await setup()
  try {
    edit(doc, 'Temporary'); coordinator.changed({ userId: 'alice' })
    edit(doc, 'Original'); coordinator.changed({ userId: 'alice' })
    const saved = await coordinator.save()
    assert.equal(saved.status, 'saved'); assert.equal(saved.pending, false)
    assert.equal(api.requests.length, 0)
    assert.equal((states.at(-1) as { status: string }).status, 'saved')
  } finally { await coordinator.close(); doc.destroy() }
})

test('a new connection cancelling unload leaves an operational save coordinator', async () => {
  const { api, doc, coordinator } = await setup()
  try {
    await coordinator.prepareUnload()
    edit(doc, 'After cancelled unload'); coordinator.changed({ userId: 'alice' })
    assert.equal((await coordinator.save()).revision, 2)
    assert.equal(api.head.blocks[0].content.inlines[0].text, 'After cancelled unload')
  } finally { await coordinator.close(); doc.destroy() }
})

test('typing during a save keeps newer content and contributors and schedules the next serial save', async () => {
  const { api, doc, coordinator } = await setup()
  let release!: () => void, started!: () => void
  const captured = new Promise<void>(resolve => { started = resolve })
  api.hold = () => { started(); return new Promise<void>(resolve => { release = resolve }) }
  try {
    edit(doc, 'First'); coordinator.changed({ userId: 'alice', displayName: 'Alice' })
    const saving = coordinator.save(); await captured
    edit(doc, 'Newer'); coordinator.changed({ userId: 'alice', displayName: 'Alice' }); coordinator.changed({ userId: 'bob' })
    // A second person actually changes the document while the first is saving.
    edit(doc, 'Newest'); coordinator.changed({ userId: 'bob', displayName: 'Bob' })
    const next = coordinator.save()
    api.hold = null; release()
    const first = await saving
    assert.equal(first.pending, true)
    assert.equal(first.status, 'editing')
    assert.equal((await next).pending, false)
    assert.equal(api.requests[0].blocks[0].content.inlines[0].text, 'First')
    assert.equal(api.requests[1].blocks[0].content.inlines[0].text, 'Newest')
    assert.equal(api.requests[1].expectedRevision, 2)
    assert.deepEqual(api.requests[1].contributors.map((user: any) => user.userId), ['alice', 'bob'])
    assert.equal(api.maxWrites, 1)
  } finally { await coordinator.close(); doc.destroy() }
})

test('a fresh external head never becomes the base of a stale room snapshot', async () => {
  const { api, doc, coordinator } = await setup()
  try {
    edit(doc, 'Local draft'); coordinator.changed({ userId: 'alice' })
    api.head = { ...api.head, revision: 2, blocks: [{ ...api.head.blocks[0], content: { kind: 'paragraph', inlines: [{ text: 'Remote canonical text' }] } }] }
    api.records.set(2, { revision: 2, rootHash: root(2), patchId: 'external' })
    const result = await coordinator.save()
    assert.equal(api.requests.length, 0)
    assert.equal(result.revision, 1)
    assert.equal(result.status, 'conflict')
    assert.equal(api.head.blocks[0].content.inlines[0].text, 'Remote canonical text')
    assert.equal(TiptapTransformer.fromYdoc(doc, 'default').content![0].content![0].text, 'Local draft')
    assert.equal(api.archives.length, 1)
    const retained = new Y.Doc(); Y.applyUpdate(retained, api.archives[0])
    assert.equal(TiptapTransformer.fromYdoc(retained, 'default').content![0].content![0].text, 'Local draft')
    retained.destroy()
  } finally { await coordinator.close(); doc.destroy() }
})

test('canonical IDs attach to captured CRDT nodes, never to replacement blocks at the same index', async () => {
  const { api, doc, coordinator } = await setup()
  let release!: () => void, started!: () => void
  const captured = new Promise<void>(resolve => { started = resolve })
  api.hold = () => { started(); return new Promise<void>(resolve => { release = resolve }) }
  try {
    edit(doc, 'First'); coordinator.changed({ userId: 'alice' })
    const saving = coordinator.save(); await captured
    const replacement = new Y.XmlElement('paragraph'), leaf = new Y.XmlText(); leaf.insert(0, 'Replacement'); replacement.insert(0, [leaf])
    doc.transact(() => { const fragment = doc.getXmlFragment('default'); fragment.delete(0, 1); fragment.insert(0, [replacement]) })
    coordinator.changed({ userId: 'bob' }); api.hold = null; release()
    assert.equal((await saving).pending, true)
    assert.equal(replacement.getAttribute('hcdBlockId'), undefined)
    assert.equal(TiptapTransformer.fromYdoc(doc, 'default').content![0].content![0].text, 'Replacement')
  } finally { await coordinator.close(); doc.destroy() }
})

test('persistence must succeed before canonical commit and a failed save never clears the draft', async () => {
  const { api, doc, coordinator } = await setup()
  try {
    edit(doc, 'Durable first'); coordinator.changed({ userId: 'alice' })
    api.failStore = true
    await assert.rejects(coordinator.save(), /persistence/)
    assert.equal(api.requests.length, 0)
    assert.equal(coordinator.state().pending, true)
    api.failStore = false
    assert.equal((await coordinator.save()).revision, 2)
  } finally { api.failStore = false; await coordinator.close(); doc.destroy() }
})

test('a restart recovers a committed-but-unacknowledged lineage and keeps newer durable edits', async () => {
  const { api, doc, coordinator } = await setup()
  edit(doc, 'Committed'); coordinator.changed({ userId: 'alice' }); api.loseResponse = true
  await assert.rejects(coordinator.save(), /response lost/)
  edit(doc, 'Newer durable draft'); coordinator.changed({ userId: 'alice' }); await coordinator.persist()
  const bytes = api.stored.slice()
  await coordinator.close(); doc.destroy()
  const restored = new Y.Doc(); Y.applyUpdate(restored, bytes)
  const next = await setup(api, restored)
  try {
    assert.equal(next.coordinator.state().revision, 2)
    assert.equal(next.coordinator.state().pending, true)
    assert.equal((await next.coordinator.save()).revision, 3)
    assert.equal(api.requests.at(-1).expectedRevision, 2)
    assert.equal(api.head.blocks[0].content.inlines[0].text, 'Newer durable draft')
  } finally { await next.coordinator.close(); restored.destroy() }
})

test('legacy pending text is retained as an unbound draft instead of adopting the current head', async () => {
  const doc = documentFor(initial()); edit(doc, 'Unbound legacy draft')
  const { api, coordinator } = await setup(new FakeApi(), doc)
  try {
    assert.equal(coordinator.state().status, 'conflict')
    assert.equal(coordinator.state().conflict, 'unbound-draft')
    await coordinator.save()
    assert.equal(api.requests.length, 0)
    assert.equal(api.archives.length, 1)
  } finally { await coordinator.close(); doc.destroy() }
})

test('tampering with replicated receipt metadata cannot move a live coordinator baseline', async () => {
  const { api, doc, coordinator } = await setup()
  try {
    doc.getMap('hcdSave').set('receipt', 'forged-latest-head')
    edit(doc, 'Real edit'); coordinator.changed({ userId: 'alice' })
    await coordinator.save()
    assert.equal(api.requests[0].expectedRevision, 1)
    assert.notEqual(doc.getMap('hcdSave').get('receipt'), 'forged-latest-head')
  } finally { await coordinator.close(); doc.destroy() }
})

test('competing room owners cannot replace each other’s durable state or canonically save unseen edits', async () => {
  const a = await setup()
  const peerDocument = new Y.Doc(); Y.applyUpdate(peerDocument, a.api.stored)
  const b = await setup(a.api, peerDocument)
  try {
    edit(a.doc, 'Owner A'); a.coordinator.changed({ userId: 'alice' }); await a.coordinator.persist()
    edit(peerDocument, 'Owner B'); b.coordinator.changed({ userId: 'bob' })
    assert.equal((await b.coordinator.save()).conflict, 'state-changed')
    assert.equal(a.api.requests.length, 0)
    assert.equal(a.api.archives.length, 1)
    assert.equal((await a.coordinator.save()).revision, 2)
    assert.equal(a.api.head.blocks[0].content.inlines[0].text, 'Owner A')
  } finally { await a.coordinator.close(); await b.coordinator.close(); a.doc.destroy(); peerDocument.destroy() }
})

test('manual save client ignores unrelated broadcasts and removes listeners on reply or timeout', async () => {
  const handlers = new Map<string, Set<(data: any) => void>>()
  let sent: any
  const provider = { on(event: string, fn: (data: any) => void) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event)!.add(fn) }, off(event: string, fn: (data: any) => void) { handlers.get(event)?.delete(fn) }, sendStateless(payload: string) { sent = JSON.parse(payload) } }
  const emit = (message: object) => handlers.get('stateless')?.forEach(fn => fn({ payload: JSON.stringify(message) }))
  const saving = requestCoordinatedSave(provider, 'a'.repeat(64), undefined, 1000)
  emit({ type: 'hcd-save-status', status: 'saved', revision: 99 })
  assert.equal(handlers.get('stateless')?.size, 1)
  emit({ type: 'hcd-save-status', status: 'saved', revision: 2, requestId: sent.requestId })
  assert.equal((await saving as { revision: number }).revision, 2)
  assert.equal(handlers.get('stateless')?.size, 0)
  await assert.rejects(requestCoordinatedSave(provider, 'b'.repeat(64), undefined, 1), /coordinatorUnavailable/)
  assert.equal(handlers.get('status')?.size, 0)
})

const picture:PositionedImage={nodeId:`n_${'7'.repeat(32)}`,visualHash:'a'.repeat(64),assetHash:'b'.repeat(64),geometry:{x:1,y:2,width:30,height:40,unit:'pt'}}
function imageApi(){const api=new FakeApi();api.images.set(picture.nodeId,picture);api.imageHistory.set(1,structuredClone(api.images));return api}

test('one manual coordinated save captures body and images, retaining newer image reversions and unrelated drafts',async()=>{
  const {api,doc,coordinator}=await setup(imageApi()),store=new CollaborativeImageDraftStore(doc)
  let release!:()=>void,entered!:()=>void
  const active=new Promise<void>(resolve=>{entered=resolve})
  api.hold=()=>new Promise<void>(resolve=>{release=resolve;entered()})
  try{
    edit(doc,'Body with image');store.edit(picture,1,{...picture.geometry,x:12});coordinator.changed({userId:'alice'})
    const saving=coordinator.save(undefined,await imageDraftDigest(doc));await active
    assert.equal(store.saving,true)
    store.edit(picture,1,picture.geometry)
    const other={...picture,nodeId:`n_${'8'.repeat(32)}`};api.images.set(other.nodeId,other);store.edit(other,1,{...other.geometry,width:50});coordinator.changed({userId:'bob'})
    release();const reply=await saving
    assert.equal(api.requests.length,1);assert.equal(api.requests[0].blocks[0].content.inlines[0].text,'Body with image');assert.equal(api.requests[0].images.length,1)
    assert.equal(reply.pending,true);assert.equal(store.get(picture.nodeId)?.geometry.x,1);assert.equal(store.get(picture.nodeId)?.base.geometry.x,12)
    assert.equal(store.get(other.nodeId)?.geometry.width,50);assert.equal(store.saving,false)
    api.hold=null;await coordinator.save();assert.equal(store.size,0);assert.equal(api.images.get(picture.nodeId)?.geometry.x,1)
  }finally{api.hold=null;await coordinator.close();doc.destroy()}
})

test('image-only saves and auto saves use the same serial coordinator; invalid numbers commit neither body nor images',async()=>{
  const {api,doc,coordinator}=await setup(imageApi()),store=new CollaborativeImageDraftStore(doc)
  try{
    store.edit(picture,1,{...picture.geometry,width:NaN});edit(doc,'Pending valid body');coordinator.changed({userId:'alice'})
    const invalid=await coordinator.save();assert.equal(invalid.problem,'image-drafts-not-ready');assert.equal(api.requests.length,0);assert.equal(api.head.revision,1)
    store.edit(picture,1,{...picture.geometry,width:50});coordinator.changed({userId:'alice'});await coordinator.save()
    assert.equal(api.requests.length,1);assert.equal(store.size,0)
    store.edit(api.images.get(picture.nodeId)!,2,{...api.images.get(picture.nodeId)!.geometry,x:20});coordinator.changed({userId:'alice'});await coordinator.save()
    assert.equal(api.requests.length,2);assert.equal(api.head.revision,3);assert.equal(store.size,0)
  }finally{await coordinator.close();doc.destroy()}
})

test('restart settles committed image intents and captured block identities while retaining newer durable fields',async()=>{
  const {api,doc,coordinator}=await setup(imageApi()),store=new CollaborativeImageDraftStore(doc)
  edit(doc,'Committed body');store.edit(picture,1,{...picture.geometry,x:12});coordinator.changed({userId:'alice'});api.loseResponse=true
  await assert.rejects(coordinator.save(),/response lost/)
  store.edit(picture,1,{...store.get(picture.nodeId)!.geometry,y:9});edit(doc,'Newer durable body');coordinator.changed({userId:'bob'});await coordinator.persist()
  const bytes=api.stored.slice();await coordinator.close();doc.destroy()
  const restored=new Y.Doc();Y.applyUpdate(restored,bytes);const next=await setup(api,restored),drafts=new CollaborativeImageDraftStore(restored)
  try{
    assert.equal(next.coordinator.state().conflict,undefined);assert.equal(next.coordinator.state().revision,2)
    assert.equal(drafts.get(picture.nodeId)?.base.geometry.x,12);assert.equal(drafts.get(picture.nodeId)?.geometry.y,9)
    assert.equal(yBlocks(restored)[0].getAttribute('hcdBlockId'),api.head.blocks[0].blockId)
    await next.coordinator.save();assert.equal(api.requests.at(-1).expectedRevision,2);assert.equal(drafts.size,0);assert.equal(api.head.blocks[0].content.inlines[0].text,'Newer durable body')
  }finally{await next.coordinator.close();restored.destroy()}
})

test('missing post-commit image receipts are recoverable using the authenticated immutable saved revision',async()=>{
  const {api,doc,coordinator}=await setup(imageApi()),store=new CollaborativeImageDraftStore(doc)
  store.edit(picture,1,{...picture.geometry,x:12});coordinator.changed({userId:'alice'});api.omitImageReceipt=true
  const state=await coordinator.save();assert.equal(state.conflict,'image-identity');assert.equal(store.size,1)
  const bytes=api.stored.slice();await coordinator.close();doc.destroy()
  const restored=new Y.Doc();Y.applyUpdate(restored,bytes);api.omitImageReceipt=false;const next=await setup(api,restored)
  try{assert.equal(next.coordinator.state().conflict,undefined);assert.equal(new CollaborativeImageDraftStore(restored).size,0);assert.equal(next.coordinator.state().revision,2)}
  finally{await next.coordinator.close();restored.destroy()}
})

test('v2 and v3 signed receipts migrate in place without discarding body or image changes',async()=>{
 for(const version of [2,3]) {
  const api=imageApi(),doc=documentFor(api.head)
  doc.getMap('hcdSchema').set('sourceIdentity',1)
  const base={version,documentId:'doc',epoch:0,lineage:'c'.repeat(32),revision:1,rootHash:root(1),digest:await checkpointDigest(jsonToSnapshot(projectionToJson(api.head)))}
  const raw=JSON.stringify(base);doc.getMap('hcdSave').set('receipt',`${Buffer.from(raw).toString('base64url')}.${createHmac('sha256',secret).update(raw).digest('base64url')}`)
  if(version===3){doc.getMap('hcdSchema').set('images',1);new CollaborativeImageDraftStore(doc).edit(picture,1,{...picture.geometry,width:50})}
  edit(doc,'Pending v2 body');const {coordinator}=await setup(api,doc)
  try{assert.equal(coordinator.state().conflict,undefined);assert.equal(coordinator.state().revision,1);assert.equal(coordinator.state().pending,true);assert.equal(doc.getMap('hcdSchema').get('images'),2);await coordinator.save();assert.equal(api.head.blocks[0].content.inlines[0].text,'Pending v2 body');if(version===3)assert.equal(api.images.get(picture.nodeId)?.geometry.width,50)}
  finally{await coordinator.close();doc.destroy()}
 }
})

test('idle autosave persists and atomically commits an image-only draft without a manual request',async()=>{
  const api=imageApi(),doc=documentFor(api.head);let finished!:(state:any)=>void
  const saved=new Promise<any>(resolve=>{finished=resolve})
  const coordinator=new SemanticSaveCoordinator({documentId:'doc',epoch:0,document:doc,secret,request:(route,init)=>api.request(route,init),idleMs:5,maxMs:10,broadcast:state=>{if(state.status==='saved' && state.revision===2)finished(state)}})
  await coordinator.initialize(api.head)
  try{
    new CollaborativeImageDraftStore(doc).edit(picture,1,{...picture.geometry,x:12});coordinator.changed({userId:'alice'})
    let timer!:ReturnType<typeof setTimeout>
    const state=await Promise.race([saved,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('autosave timed out')),1000)})]).finally(()=>clearTimeout(timer)) as any
    assert.equal(state.pending,false);assert.equal(api.requests.length,1);assert.equal(api.requests[0].images.length,1)
    const durable=new Y.Doc();Y.applyUpdate(durable,api.stored);assert.equal(durable.getMap(imageDraftMap).size,0);durable.destroy()
  }finally{await coordinator.close();doc.destroy()}
})

test('same-property collaboration conflicts block the whole body/image batch until explicitly resolved',async()=>{
  const {api,doc,coordinator}=await setup(imageApi()),other=new Y.Doc();Y.applyUpdate(other,Y.encodeStateAsUpdate(doc))
  const a=new CollaborativeImageDraftStore(doc),b=new CollaborativeImageDraftStore(other)
  try{
    a.edit(picture,1,{...picture.geometry,x:12});b.edit(picture,1,{...picture.geometry,x:22});Y.applyUpdate(doc,Y.encodeStateAsUpdate(other));edit(doc,'Body must wait for image conflict');coordinator.changed({userId:'alice'})
    const blocked=await coordinator.save();assert.equal(blocked.problem,'image-drafts-conflict');assert.equal(api.requests.length,0);assert.equal(api.head.revision,1);assert.equal(doc.getMap(imageDraftMap).size,2)
    a.resolve(picture.nodeId,true);coordinator.changed({userId:'alice'});await coordinator.save()
    assert.equal(api.head.blocks[0].content.inlines[0].text,'Body must wait for image conflict');assert.equal(api.images.get(picture.nodeId)?.geometry.x,12);assert.equal(a.size,0)
  }finally{await coordinator.close();doc.destroy();other.destroy()}
})


test('an offline overlapping image intent arriving after a commit remains an explicit choice against immutable canonical geometry',async()=>{
  const {api,doc,coordinator}=await setup(imageApi()),offline=new Y.Doc();Y.applyUpdate(offline,Y.encodeStateAsUpdate(doc))
  const store=new CollaborativeImageDraftStore(doc),later=new CollaborativeImageDraftStore(offline)
  try{
    later.edit(picture,1,{...picture.geometry,x:22})
    store.edit(picture,1,{...picture.geometry,x:12});coordinator.changed({userId:'alice'});await coordinator.save()
    Y.applyUpdate(doc,Y.encodeStateAsUpdate(offline));coordinator.changed({userId:'bob'});await coordinator.inspect()
    assert.equal(api.head.revision,2);assert.equal(store.get(picture.nodeId)?.base.visualHash,api.images.get(picture.nodeId)?.visualHash)
    const options=store.get(picture.nodeId)!.alternatives!;assert.deepEqual(options.map(value=>value.geometry.x).sort((a,b)=>a-b),[12,22])
    assert.throws(()=>captureImages(doc),/conflict/)
    assert.equal((await coordinator.save()).problem,'image-drafts-conflict');assert.equal(api.head.revision,2)
    store.resolveVariant(picture.nodeId,options.find(value=>value.geometry.x===22)!.intentId);coordinator.changed({userId:'bob'});await coordinator.save()
    assert.equal(api.head.revision,3);assert.equal(api.images.get(picture.nodeId)?.geometry.x,22);assert.equal(store.size,0)
  }finally{await coordinator.close();doc.destroy();offline.destroy()}
})

test('an offline disjoint image field rebases using immutable original and current images without overwriting the committed field',async()=>{
  const {api,doc,coordinator}=await setup(imageApi()),offline=new Y.Doc();Y.applyUpdate(offline,Y.encodeStateAsUpdate(doc))
  const store=new CollaborativeImageDraftStore(doc),later=new CollaborativeImageDraftStore(offline)
  try{
    later.edit(picture,1,{...picture.geometry,width:50})
    store.edit(picture,1,{...picture.geometry,x:12});coordinator.changed({userId:'alice'});await coordinator.save()
    Y.applyUpdate(doc,Y.encodeStateAsUpdate(offline));coordinator.changed({userId:'bob'});await coordinator.inspect()
    assert.equal(store.get(picture.nodeId)?.remote,undefined);assert.equal(captureImages(doc)[0].change.geometry.x,12);assert.equal(captureImages(doc)[0].change.geometry.width,50)
    await coordinator.save();assert.equal(api.images.get(picture.nodeId)?.geometry.x,12);assert.equal(api.images.get(picture.nodeId)?.geometry.width,50)
  }finally{await coordinator.close();doc.destroy();offline.destroy()}
})

test('body plus replacement recovers exact image identity after a committed response is lost',async()=>{
  const api=imageApi(),doc=documentFor(api.head),{coordinator}=await setup(api,doc),store=new CollaborativeImageDraftStore(doc)
  const asset='d'.repeat(64)
  edit(doc,'Body with replacement 中😀');store.replace(picture,1,asset);store.edit(picture,1,{...picture.geometry,width:77},undefined,'width');coordinator.changed({userId:'alice'});api.loseResponse=true
  await assert.rejects(coordinator.save(),/response lost/);assert.equal(store.size,1);assert.equal(api.head.revision,2)
  const bytes=api.stored.slice();await coordinator.close();doc.destroy()
  const restored=new Y.Doc();Y.applyUpdate(restored,bytes);const next=await setup(api,restored)
  try{assert.equal(next.coordinator.state().conflict,undefined);assert.equal(next.coordinator.state().pending,false);assert.equal(new CollaborativeImageDraftStore(restored).size,0);assert.equal(api.images.get(picture.nodeId)!.assetHash,asset);assert.equal(api.images.get(picture.nodeId)!.geometry.width,77);assert.equal(api.head.blocks[0].content.inlines[0].text,'Body with replacement 中😀');assert.equal(api.requests.length,1)}
  finally{await next.coordinator.close();restored.destroy()}
})

test('restored disk metadata cannot replace the coordinator receipt, schema or active attempt',async()=>{
 const {api,doc,coordinator}=await setup(imageApi()),store=new CollaborativeImageDraftStore(doc)
 let release:(()=>void)|undefined
 try{
  const receipt=doc.getMap('hcdSave').get('receipt')
  doc.getMap('hcdSave').set('receipt','stale disk receipt');doc.getMap('hcdSave').set('imageAttempt','stale disk attempt');doc.getMap('hcdSchema').set('images',1)
  coordinator.changed({userId:'alice'},'disk-restore')
  assert.equal(doc.getMap('hcdSave').get('receipt'),receipt);assert.equal(doc.getMap('hcdSave').has('imageAttempt'),false);assert.equal(doc.getMap('hcdSchema').get('images'),2)
  assert.equal(coordinator.state().pending,false)
  let entered!:()=>void
  const active=new Promise<void>(resolve=>{entered=resolve});api.hold=()=>new Promise<void>(resolve=>{release=resolve;entered()})
  store.replace(picture,1,'e'.repeat(64));coordinator.changed({userId:'alice'})
  const saving=coordinator.save();await active
  const attempt=doc.getMap('hcdSave').get('imageAttempt');assert.equal(typeof attempt,'string')
  doc.getMap('hcdSave').delete('imageAttempt');coordinator.changed({userId:'alice'},'stale-disk-metadata')
  assert.equal(doc.getMap('hcdSave').get('imageAttempt'),attempt)
  release!();api.hold=null;await saving
  doc.getMap('hcdSave').set('imageAttempt',attempt);coordinator.changed({userId:'alice'},'late-disk-metadata')
  assert.equal(doc.getMap('hcdSave').has('imageAttempt'),false);assert.equal(coordinator.state().pending,false);assert.equal(api.requests.length,1)
 }finally{release?.();api.hold=null;await coordinator.close();doc.destroy()}
})
