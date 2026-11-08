import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, createHmac } from 'node:crypto'
import * as Y from 'yjs'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { SemanticSaveCoordinator } from './semanticSaveCoordinator.ts'
import { checkpointDigest, legacyCheckpointContents } from './checkpointSnapshot.ts'
import { legacySnapshot } from './sourceIdentityMigration.ts'
import { CollaborativeImageDraftStore, imageDraftDigest, imageDraftContents, imageDraftMap, captureImages } from './collaborativeImages.ts'
import type { PositionedImage } from './imageDrafts.ts'
import { requestCoordinatedSave } from './semanticSaveClient.ts'
import { jsonToSnapshot, projectionToJson, schemaExtensions, type Projection } from './schema.ts'
import { yBlocks } from './typographyMigration.ts'
import {getSchema} from '@tiptap/core'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {deletionReviews,resolveDeletionReview} from './deletionReview.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {EditorState} from '@tiptap/pm/state'
import {blockTarget,rootBlocks,transformBlocks} from './commands/blocks.ts'
import {Fragment} from '@tiptap/pm/model'
import {structureSourceTargets} from './semanticStructureSources.ts'

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
  epoch = 0
  head = initial()
  projections = new Map<number, Projection>([[1,initial()]])
  records = new Map<number, object>([[1, { revision: 1, rootHash: root(1) }]])
  stored:Uint8Array = new Uint8Array()
  archives: Uint8Array[] = []
  requests: any[] = []
  hold: (() => Promise<void>) | null = null
  images = new Map<string,PositionedImage>()
  imageHistory = new Map<number,Map<string,PositionedImage>>()
  omitImageReceipt = false
  failStore = false
  fieldProtected = false
  sourceMissing = false
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
      if (this.sourceMissing) return new Response('{}',{status:422,headers:{'x-hcd-error-code':'DOCX_SOURCE_REQUIRED'}})
      if (this.fieldProtected) return new Response('{"error":"DOCX_SOURCE_TEXT_READ_ONLY"}',{status:422,headers:{'x-hcd-error-code':'DOCX_SOURCE_TEXT_READ_ONLY','x-hcd-protected-block':'n_'+'a'.repeat(32)}})
      if (request.expectedRevision !== this.head.revision) return new Response('', { status: 409 })
      for(const image of request.images??[]) if(this.images.get(image.nodeId)?.visualHash!==image.precondition.visualHash) return new Response('',{status:409})
      const savedImages=(request.images??[]).map((value:any)=> ({...this.images.get(value.nodeId),nodeId:value.nodeId,geometry:value.geometry,...(value.assetHash?{assetHash:value.assetHash}:{}),visualHash:createHash('sha256').update(JSON.stringify({geometry:value.geometry,assetHash:value.assetHash??this.images.get(value.nodeId)?.assetHash})).digest('hex')}))
      savedImages.forEach((value:PositionedImage)=>this.images.set(value.nodeId,value))
      const revision = this.head.revision + 1
      this.head = { ...this.head, revision, blocks: request.blocks.map((block: any, index: number) => ({ blockId: `canonical-${revision}-${index}`, blockHash: 'hash', region: 'body', readOnly: false, content: block.content })) }
      this.projections.set(revision,structuredClone(this.head))
      this.imageHistory.set(revision,structuredClone(this.images))
      const bodyHash = createHash('sha256').update(JSON.stringify(request.referenceAuthors?.length?{blocks:request.blocks,images:request.images??[],referenceAuthors:request.referenceAuthors}:request.images?.length?{blocks:request.blocks,images:request.images}:request.blocks)).digest('hex')
      const unsigned = `hcdsave${request.coordinatorVersion}:${request.coordinatorId}:${request.checkpointId}:${request.coordinatorDigest}:${bodyHash}`
      const mac = createHmac('sha256', secret).update(`doc:${this.epoch}:${request.expectedRevision}:${unsigned}`).digest('base64url')
      this.records.set(revision, { revision, rootHash: root(revision), patchBaseRevision: request.expectedRevision, patchId: `${unsigned}:${mac}` })
      if (this.loseResponse) { this.loseResponse = false; throw new Error('response lost after commit') }
      return Response.json({ revision, rootHash: root(revision), projection: this.head, images:this.omitImageReceipt?[]:savedImages, saveMode: 'source-text' })
    } finally { this.writes-- }
  }
}
async function setup(api = new FakeApi(), doc = documentFor(initial()),structure?:SemanticBlockStore) {
  const states: object[] = []
  const coordinator = new SemanticSaveCoordinator({ documentId: 'doc', epoch: 0, document: doc, structure,secret, stateHash: api.stored.length ? createHash('sha256').update(api.stored).digest('hex') : 'none', request: (route, init) => api.request(route, init), broadcast: state => states.push(state) })
  await coordinator.initialize(api.head)
  return { api, doc, coordinator, states }
}

test('a protected Word field reports the cause, retains the draft and saves after correction',async()=>{
 const {api,doc,coordinator,states}=await setup()
 let reopened:Awaited<ReturnType<typeof setup>>|undefined,closed=false
 try{
  edit(doc,'Edited field');coordinator.changed({userId:'alice'});api.fieldProtected=true
  const result=await coordinator.save();assert.equal(result.status,'failed');assert.equal(result.problem,'word-field-read-only');assert.equal(result.protectedBlockId,'n_'+'a'.repeat(32));assert.equal(result.pending,true)
  assert.equal(api.head.revision,1);assert.equal((yBlocks(doc)[0].get(0) as Y.XmlText).toString(),'Edited field')
  await coordinator.close();closed=true
  const recovered=new Y.Doc();Y.applyUpdate(recovered,api.stored);assert.equal((yBlocks(recovered)[0].get(0) as Y.XmlText).toString(),'Edited field')
  reopened=await setup(api,recovered);assert.equal(reopened.coordinator.state().pending,true)
  assert.ok(states.some((value:any)=>value.problem==='word-field-read-only'))
  api.fieldProtected=false;edit(recovered,'Corrected');reopened.coordinator.changed({userId:'alice'})
  const saved=await reopened.coordinator.save();assert.equal(saved.status,'saved');assert.equal(saved.pending,false);assert.equal(api.head.blocks[0].content.inlines[0].text,'Corrected')
 }finally{if(reopened){await reopened.coordinator.close();reopened.doc.destroy()}if(!closed)await coordinator.close();doc.destroy()}
})
test('missing Word source preserves the draft and allows an explicit retry after restoration',async()=>{
 const {api,doc,coordinator}=await setup()
 try{edit(doc,'Preserved draft');coordinator.changed({userId:'alice'});api.sourceMissing=true
  const blocked=await coordinator.save();assert.equal(blocked.problem,'word-source-required');assert.equal(blocked.pending,true);assert.equal(api.head.revision,1)
  api.sourceMissing=false;const saved=await coordinator.save();assert.equal(saved.status,'saved');assert.equal(saved.pending,false);assert.equal(api.head.blocks[0].content.inlines[0].text,'Preserved draft')
 }finally{await coordinator.close();doc.destroy()}
})
const structureSchema=getSchema([...schemaExtensions,SemanticStructureIdentity])
async function setupStructure(api=new FakeApi(),doc=new Y.Doc()){
 const structure=new SemanticBlockStore(doc,structureSchema)
 if(!structure.initialized){structure.initialize(structureSchema.nodeFromJSON(projectionToJson(api.head)));doc.getMap('hcdSchema').set('typography',2);doc.getMap('hcdSchema').set('sourceIdentity',1)}
 return{...await setup(api,doc,structure),structure}
}
function editStructure(store:SemanticBlockStore,key:string,text:string){const before=store.content(key);store.update(key,before,before.type.createChecked(before.attrs,text?store.schema.text(text):null))}

test('structural saves read the logical document and retain permanent text through canonical receipts',async()=>{
 const api=new FakeApi();api.head.blocks.push({...structuredClone(api.head.blocks[0]),blockId:'second',content:{kind:'paragraph',inlines:[{text:'Second'}]}})
 const {doc,structure,coordinator}=await setupStructure(api)
 try{
  const [first,second]=structure.keys(),text=structure.contents.get(first)!.get(0)
  structure.move([second],first);editStructure(structure,first,'Original Peer!');coordinator.changed({userId:'alice'})
  const saved=await coordinator.save();assert.equal(saved.status,'saved');assert.equal(saved.pending,false)
  assert.deepEqual(api.requests[0].blocks.map((block:any)=>block.content.inlines[0].text),['Second','Original Peer!'])
  assert.equal(structure.content(first).attrs.hcdBlockId,'canonical-2-1');assert.equal(structure.contents.get(first)!.get(0),text)
  assert.equal(doc.getXmlFragment('default').length,0)
 }finally{await coordinator.close();doc.destroy()}
})
test('a structural save receipt cannot discard typing after the captured request',async()=>{
 const {api,doc,structure,coordinator}=await setupStructure();let release!:()=>void,started!:()=>void
 const waiting=new Promise<void>(done=>{started=done});api.hold=()=>{started();return new Promise<void>(done=>{release=done})}
 try{
  const [key]=structure.keys();editStructure(structure,key,'Captured');coordinator.changed({userId:'alice'});const save=coordinator.save();await waiting
  editStructure(structure,key,'Captured Later');coordinator.changed({userId:'alice'});release();const saved=await save
  assert.equal(saved.pending,true);assert.equal(structure.content(key).textContent,'Captured Later');assert.equal(api.head.blocks[0].content.inlines[0].text,'Captured')
  api.hold=null;assert.equal((await coordinator.save()).pending,false);assert.equal(api.head.blocks[0].content.inlines[0].text,'Captured Later')
 }finally{api.hold=null;await coordinator.close();doc.destroy()}
})
test('structural lost-response recovery restores canonical root IDs and retains newer durable input',async()=>{
 const {api,doc,structure,coordinator}=await setupStructure(),[key]=structure.keys()
 editStructure(structure,key,'Committed');coordinator.changed({userId:'alice'});api.loseResponse=true;await assert.rejects(coordinator.save(),/response lost/)
 editStructure(structure,key,'Committed Newer');coordinator.changed({userId:'alice'});await coordinator.persist();const bytes=api.stored.slice();await coordinator.close();doc.destroy()
 const recovered=new Y.Doc();Y.applyUpdate(recovered,bytes);const next=await setupStructure(api,recovered)
 try{
  assert.equal(next.coordinator.state().revision,2);assert.equal(next.coordinator.state().pending,true);assert.equal(next.structure.content(key).attrs.hcdBlockId,'canonical-2-0');assert.equal(next.structure.content(key).textContent,'Committed Newer')
  assert.equal((await next.coordinator.save()).revision,3);assert.equal(api.head.blocks[0].content.inlines[0].text,'Committed Newer')
 }finally{await next.coordinator.close();recovered.destroy()}
})
test('a source receipt maps hidden permanent blocks so undo retains their canonical identity',async()=>{
 const api=new FakeApi();api.head.blocks.push({...structuredClone(api.head.blocks[0]),blockId:'second',content:{kind:'paragraph',inlines:[{text:'Second'}]}})
 const {doc,structure,coordinator}=await setupStructure(api),history=structure.undoManager();let release!:()=>void,started!:()=>void
 const waiting=new Promise<void>(done=>{started=done});api.hold=()=>{started();return new Promise<void>(done=>{release=done})}
 try{
  const [key]=structure.keys();editStructure(structure,key,'Captured');coordinator.changed({userId:'alice'});const save=coordinator.save();await waiting
  history.stopCapturing();structure.remove([key]);release();assert.equal((await save).pending,true);assert.equal(structure.content(key).attrs.hcdBlockId,'canonical-2-0')
  history.undo();assert.equal(structure.content(key).attrs.hcdBlockId,'canonical-2-0');assert.ok(structure.keys().includes(key))
 }finally{api.hold=null;history.destroy();await coordinator.close();doc.destroy()}
})
test('legacy coordination refuses structural data without explicit protocol selection',()=>{
 const doc=new Y.Doc(),structure=new SemanticBlockStore(doc,structureSchema);structure.initialize(structureSchema.nodeFromJSON(projectionToJson(initial())))
 try{assert.throws(()=>new SemanticSaveCoordinator({documentId:'doc',epoch:0,document:doc,secret,request:async()=>{throw new Error('must not request')},broadcast:()=>{}}),/negotiated protocol/)}finally{doc.destroy()}
})
for(const field of ['hcd-semantic-blocks/1/meta','hcd-semantic-blocks/2/meta','hcd-text-flow/1/meta'])test(`legacy coordination refuses unnegotiated recovery data in ${field}`,()=>{
 const doc=new Y.Doc();doc.getMap(field).set('version',1)
 try{assert.throws(()=>new SemanticSaveCoordinator({documentId:'doc',epoch:0,document:doc,secret,request:async()=>{throw new Error('must not request')},broadcast:()=>{}}),/negotiated protocol/)}finally{doc.destroy()}
})
test('an owner retired by a late quote receipt becomes provisional when lifted back out',async()=>{
 const api=new FakeApi();api.head.blocks.push({...structuredClone(api.head.blocks[0]),blockId:'second',content:{kind:'paragraph',inlines:[{text:'Second'}]}})
 const {doc,structure,coordinator}=await setupStructure(api)
 const convert=(type:string)=>{const before=structure.blocks(),state=EditorState.create({schema:structureSchema,doc:structure.project()}),tr=state.tr;assert.ok(transformBlocks(tr,type,undefined,blockTarget(state,rootBlocks(state.doc))!));const next:Array<{key?:string;node:typeof state.doc}>=[];tr.doc.forEach(node=>{const key=node.attrs.hcdStructureKey;next.push({...(before.some(block=>block.key===key)?{key}:{}),node})});structure.reconcile(before,next)}
 let started!:()=>void,release!:()=>void;const waiting=new Promise<void>(done=>{started=done});api.hold=()=>{started();return new Promise<void>(done=>{release=done})}
 try{
  convert('block.quote');coordinator.changed({userId:'alice'});const saving=coordinator.save();await waiting;convert('block.paragraph');release();assert.equal((await saving).pending,true)
  assert.match(structure.blocks()[1].node.attrs.hcdBlockId,/^tmp_/);api.hold=null;assert.equal((await coordinator.save()).pending,false)
  assert.match(api.requests[1].blocks[1].blockId,/^tmp_/);assert.deepEqual(structure.blocks().map(block=>block.node.textContent),['Original','Second'])
 }finally{api.hold=null;await coordinator.close();doc.destroy()}
})

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

test('an imported mixed list reaches a clean structural room without an artificial source conflict',async()=>{
 const api=new FakeApi(),sourceId=(value:string)=>`n_${value.repeat(32)}`
 api.head={...initial(),blocks:[{...initial().blocks[0],content:{kind:'list_item',level:1,listStart:4,inlines:[],children:[
  {kind:'paragraph',inlines:[{nodeId:sourceId('1'),text:'Parent'}]},
  {kind:'ordered_list',listStart:7,inlines:[],children:[{kind:'list_item',level:1,inlines:[],children:[
   {kind:'paragraph',inlines:[{nodeId:sourceId('2'),text:'Child'}]},
   {kind:'bullet_list',inlines:[],children:[{kind:'list_item',level:0,inlines:[{nodeId:sourceId('3'),text:'Leaf'}]}]},
  ]}]},
 ]}}]}
 api.projections.set(1,api.head)
 const source=await setup(api,documentFor(api.head));let candidate:Awaited<ReturnType<SemanticSaveCoordinator['prepareMigration']>>|undefined,target:SemanticSaveCoordinator|undefined
 try{
  assert.equal(source.coordinator.state().conflict,undefined)
  candidate=await source.coordinator.prepareMigration(structureSchema,1)
  assert.equal(candidate.structure.project().textContent,'ParentChildLeaf')
  api.epoch=1;api.stored=Y.encodeStateAsUpdate(candidate.document)
  target=new SemanticSaveCoordinator({documentId:'doc',epoch:1,document:candidate.document,structure:candidate.structure,secret,stateHash:createHash('sha256').update(api.stored).digest('hex'),autoSave:false,request:(route,init)=>api.request(route,init),broadcast:()=>{}})
  await target.initialize(api.head)
  assert.equal(target.state().conflict,undefined);assert.equal(target.state().pending,false)
  assert.equal(api.requests.length,0)
 }finally{await target?.close();candidate?.document.destroy();source.coordinator.dispose();source.doc.destroy()}
})

test('protocol migration preserves a bound unsaved body and its authenticated contributors across restart',async()=>{
 const source=await setup();let target:SemanticSaveCoordinator|undefined,candidate:Awaited<ReturnType<SemanticSaveCoordinator['prepareMigration']>>|undefined
 let restarted:Awaited<ReturnType<typeof setup>>|undefined
 try{
  edit(source.doc,'Unsaved body 中😀');source.coordinator.changed({userId:'alice',displayName:'Alice'});await source.coordinator.persist();source.coordinator.dispose()
  const copy=new Y.Doc();Y.applyUpdate(copy,source.api.stored);restarted=await setup(source.api,copy)
  candidate=await restarted.coordinator.prepareMigration(structureSchema,1)
  assert.equal(candidate.structure.project().textContent,'Unsaved body 中😀');assert.equal(source.api.requests.length,0);assert.equal(candidate.sourceHash,createHash('sha256').update(candidate.sourceBytes).digest('hex'))
  source.api.epoch=1;source.api.stored=Y.encodeStateAsUpdate(candidate.document)
  target=new SemanticSaveCoordinator({documentId:'doc',epoch:1,document:candidate.document,structure:candidate.structure,secret,stateHash:createHash('sha256').update(source.api.stored).digest('hex'),autoSave:false,request:(route,init)=>source.api.request(route,init),broadcast:()=>{}})
  await target.initialize(source.api.head);assert.equal(target.state().pending,true);assert.equal(target.state().conflict,undefined)
  await target.save();assert.deepEqual(source.api.requests[0].contributors,[{userId:'alice',displayName:'Alice'}]);assert.equal(source.api.head.blocks[0].content.inlines[0].text,'Unsaved body 中😀')
 }finally{await target?.close();candidate?.document.destroy();restarted?.coordinator.dispose();restarted?.doc.destroy();source.coordinator.dispose();source.doc.destroy()}
})
test('migration retains image replacement intents and competing geometry candidates without committing them',async()=>{
 const source=await setup(imageApi());let candidate:Awaited<ReturnType<SemanticSaveCoordinator['prepareMigration']>>|undefined
 const peer=new Y.Doc();Y.applyUpdate(peer,Y.encodeStateAsUpdate(source.doc))
 try{
  const a=new CollaborativeImageDraftStore(source.doc),b=new CollaborativeImageDraftStore(peer)
  a.replace(picture,1,'e'.repeat(64));a.edit(picture,1,{...picture.geometry,x:11});b.edit(picture,1,{...picture.geometry,x:22});Y.applyUpdate(source.doc,Y.encodeStateAsUpdate(peer))
  source.coordinator.changed({userId:'alice'});const before=imageDraftContents(source.doc)
  candidate=await source.coordinator.prepareMigration(structureSchema,1)
  assert.equal(imageDraftContents(candidate.document),before);assert.equal(source.api.requests.length,0)
  assert.equal(new CollaborativeImageDraftStore(candidate.document).get(picture.nodeId)?.collaborationConflict,true)
  assert.equal(source.api.head.revision,1)
 }finally{candidate?.document.destroy();peer.destroy();source.coordinator.dispose();source.doc.destroy()}
})
for(const corruption of ['missing','tampered','replayed-after-edit'])test(`migration refuses ${corruption} contributor authority while retaining the old draft`,async()=>{
 const source=await setup();let copy:Y.Doc|undefined,restarted:Awaited<ReturnType<typeof setup>>|undefined
 try{
  edit(source.doc,'Private pending body');source.coordinator.changed({userId:'alice'});await source.coordinator.persist();source.coordinator.dispose()
  copy=new Y.Doc();Y.applyUpdate(copy,source.api.stored)
  if(corruption==='missing')copy.getMap('hcdSave').delete('contributors')
  else if(corruption==='tampered')copy.getMap('hcdSave').set('contributors','forged.person')
  else edit(copy,'Different unverified pending body')
  source.api.stored=Y.encodeStateAsUpdate(copy);restarted=await setup(source.api,copy)
  await assert.rejects(restarted.coordinator.prepareMigration(structureSchema,1),/contributors-unbound/)
  assert.equal(source.api.requests.length,0);assert.ok(source.api.archives.length>0);assert.ok(yBlocks(copy)[0].toString().includes('pending body'),'the source body must remain recoverable')
 }finally{restarted?.coordinator.dispose();source.coordinator.dispose();copy?.destroy();source.doc.destroy()}
})
test('migration refuses unknown shared extension data without silently omitting it',async()=>{
 const source=await setup()
 try{source.doc.getMap('future-extension').set('payload',{text:'Must survive'});await assert.rejects(source.coordinator.prepareMigration(structureSchema,1),/unknown-shared-data/);assert.deepEqual(source.doc.getMap('future-extension').get('payload'),{text:'Must survive'});assert.equal(source.api.requests.length,0)}
 finally{source.coordinator.dispose();source.doc.destroy()}
})

const referenceFixture=(id='1',person='target')=>({type:'hcd.mention' as const,version:1 as const,mentionId:`m_${id.repeat(32)}`,target:{kind:'person',id:person},snapshot:{label:'同名'}})
function setReferences(store:SemanticBlockStore,refs:ReturnType<typeof referenceFixture>[],extra=''){const key=store.keys()[0],before=store.content(key);store.update(key,before,before.type.createChecked(before.attrs,[...refs.map(reference=>store.schema.nodes.hcdMention.createChecked({reference})),...(extra?[store.schema.text(extra)]:[])]))}

test('reference retarget candidates block checkpoints, survive restart and bind the chosen target to the authenticated resolver',async()=>{
 const {referenceEditIndex,resolveReferenceEdit}=await import('./referenceEdits.ts'),f=await setupStructure(),peerDoc=new Y.Doc();let restarted:Awaited<ReturnType<typeof setupStructure>>|undefined
 try{
  setReferences(f.structure,[referenceFixture()]);f.coordinator.changed({userId:'alice'});await f.coordinator.save();assert.equal(f.api.requests.length,1)
  Y.applyUpdate(peerDoc,Y.encodeStateAsUpdate(f.doc));const peer=new SemanticBlockStore(peerDoc,structureSchema)
  setReferences(f.structure,[referenceFixture('1','alice-target')]);f.coordinator.changed({userId:'alice'})
  setReferences(peer,[referenceFixture('1','bob-target')]);Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(peerDoc));f.coordinator.changed({userId:'bob'})
  const rejected=await f.coordinator.save();assert.equal(rejected.problem,'reference-drafts-conflict');assert.equal(f.api.requests.length,1);assert.equal(f.api.head.revision,2);assert.ok(f.api.stored.length>0)
  await f.coordinator.close();const copy=new Y.Doc();Y.applyUpdate(copy,f.api.stored);restarted=await setupStructure(f.api,copy)
  assert.equal(restarted.coordinator.state().problem,'reference-drafts-conflict');const group=referenceEditIndex(copy).get(referenceFixture().mentionId)!;assert.equal(group.candidates.length,2)
  resolveReferenceEdit(copy,group.root.mentionId,group.ids,group.candidates.find(edit=>edit.after.target.id==='bob-target')!.id,restarted.structure.origin);restarted.coordinator.changed({userId:'resolver',displayName:'Resolver'})
  const saved=await restarted.coordinator.save();assert.equal(saved.status,'saved');assert.equal(f.api.requests.length,2);assert.deepEqual(f.api.requests[1].referenceAuthors,[{mentionId:referenceFixture().mentionId,userId:'resolver'}]);assert.equal(f.api.requests[1].blocks[0].content.inlines[0].reference.target.id,'bob-target')
 }finally{f.coordinator.dispose();f.doc.destroy();peerDoc.destroy();await restarted?.coordinator.close();restarted?.doc.destroy()}
})
test('new references carry their actual authors through captured requests and later concurrent typing',async()=>{
 const {api,doc,structure,coordinator}=await setupStructure();let started!:()=>void,release!:()=>void;const wait=new Promise<void>(done=>{started=done});api.hold=()=>{started();return new Promise<void>(done=>{release=done})}
 try{
  setReferences(structure,[referenceFixture()]);coordinator.changed({userId:'alice',displayName:'Alice'});const saving=coordinator.save();await wait
  setReferences(structure,[referenceFixture(),referenceFixture('2')]);coordinator.changed({userId:'bob',displayName:'Bob'});release();assert.equal((await saving).pending,true);assert.deepEqual(api.requests[0].referenceAuthors,[{mentionId:referenceFixture().mentionId,userId:'alice'}])
  api.hold=null;await coordinator.save();assert.deepEqual(api.requests[1].referenceAuthors,[{mentionId:referenceFixture('2').mentionId,userId:'bob'}]);assert.deepEqual(api.requests[1].contributors.map((p:any)=>p.userId),['bob'])
 }finally{api.hold=null;await coordinator.close();doc.destroy()}
})
test('signed reference author proof survives restart, but forged or missing proof cannot borrow a later writer',async()=>{
 for(const tamper of [false,true]){
  const {api,doc,structure,coordinator}=await setupStructure();setReferences(structure,[referenceFixture()]);coordinator.changed({userId:'org:甲',displayName:'中'.repeat(64)});await coordinator.persist();await coordinator.close()
  const recovered=new Y.Doc();Y.applyUpdate(recovered,api.stored);if(tamper)recovered.getMap('hcdSave').set('referenceAuthors','forged');doc.destroy()
  const next=await setupStructure(api,recovered)
  try{setReferences(next.structure,[referenceFixture()],'another person typed');next.coordinator.changed({userId:'bob'})
   if(tamper){await assert.rejects(next.coordinator.save(),/reference-authors-unbound/);assert.equal(api.requests.length,0)}else{assert.equal((await next.coordinator.save()).pending,false);assert.equal(api.requests[0].referenceAuthors[0].userId,'org:甲');assert.equal(Buffer.byteLength(api.requests[0].contributors.find((p:any)=>p.userId==='org:甲').displayName),63)}
  }finally{await next.coordinator.close();recovered.destroy()}
 }
})
test('lost reference commit recovers IDs and permits author-attributed resurrection after committed deletion',async()=>{
 const {api,doc,structure,coordinator}=await setupStructure();setReferences(structure,[referenceFixture()]);coordinator.changed({userId:'alice'});api.loseResponse=true;await assert.rejects(coordinator.save(),/response lost/);await coordinator.persist();await coordinator.close()
 const recovered=new Y.Doc();Y.applyUpdate(recovered,api.stored);doc.destroy();const next=await setupStructure(api,recovered)
 try{assert.equal(next.coordinator.state().revision,2);setReferences(next.structure,[]);next.coordinator.changed({userId:'bob'});await next.coordinator.save();assert.equal(api.requests[1].referenceVersion,1)
  setReferences(next.structure,[referenceFixture()]);next.coordinator.changed({userId:'alice'});await next.coordinator.save();assert.deepEqual(api.requests[2].referenceAuthors,[{mentionId:referenceFixture().mentionId,userId:'alice'}])
 }finally{await next.coordinator.close();recovered.destroy()}
})

test('deleting the final committed reference survives restart with a signed deletion author',async()=>{
 const {api,doc,structure,coordinator}=await setupStructure();setReferences(structure,[referenceFixture()]);coordinator.changed({userId:'alice'});await coordinator.save();setReferences(structure,[]);coordinator.changed({userId:'bob'});await coordinator.persist();await coordinator.close()
 const recovered=new Y.Doc();Y.applyUpdate(recovered,api.stored);doc.destroy();const next=await setupStructure(api,recovered)
 try{assert.equal((await next.coordinator.save()).pending,false);assert.equal(api.requests[1].referenceVersion,1);assert.deepEqual(api.requests[1].referenceAuthors,[{mentionId:referenceFixture().mentionId,userId:'bob'}])}finally{await next.coordinator.close();recovered.destroy()}
})

test('node conflicts and missing merged fallback persist all candidates without submitting a canonical checkpoint',async()=>{
 const {NodeExtensionRegistry}=await import('./extensionRegistry.ts'),{extensionNodes}=await import('./extensionNode.ts'),{extensionEditIndex,materializeExtensionEdits,resolveExtensionEdits}=await import('./extensionEdits.ts'),{semanticBlockOrigin}=await import('./semanticBlockStore.ts')
 for(const overlap of [false,true]){
  const registry=new NodeExtensionRegistry([{type:'example.task',version:1,display:'inline',label:'Task',defaultData:{title:'Initial',done:false},validate:d=>typeof d.title==='string'&&typeof d.done==='boolean',fallback:d=>`${d.done?'☑':'☐'} ${d.title}`}]),value=registry.create('example.task'),api=new FakeApi();api.head={...initial(),blocks:[{...initial().blocks[0],content:{kind:'paragraph',inlines:[{text:value.fallback.text,extension:value}]}}]};api.projections.set(1,structuredClone(api.head));const f=await setupStructure(api),peerDoc=new Y.Doc();Y.applyUpdate(peerDoc,Y.encodeStateAsUpdate(f.doc));const peer=new SemanticBlockStore(peerDoc,structureSchema)
  const update=(store:SemanticBlockStore,data:Record<string,unknown>)=>{const blocks=store.blocks(),doc=store.project(),entry=extensionNodes(doc).get(value.instanceId)!,tr=EditorState.create({schema:structureSchema,doc}).tr.setNodeMarkup(entry.position,undefined,{extension:registry.update(entry.value,data)});store.reconcile(blocks,tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}
  update(f.structure,{title:'Alice',done:false});update(peer,overlap?{title:'Bob',done:false}:{title:'Initial',done:true});Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(peerDoc));f.coordinator.changed({userId:'alice',displayName:'Alice'});const rejected=await f.coordinator.save();assert.equal(rejected.problem,overlap?'node-drafts-conflict':'node-drafts-not-ready');assert.equal(api.requests.length,0);assert.equal(api.head.revision,1);assert.ok(api.stored.length>0)
  const recovered=new Y.Doc();Y.applyUpdate(recovered,api.stored);assert.equal(extensionEditIndex(recovered).get(value.instanceId)!.ids.length,2);recovered.destroy()
  if(overlap){const group=extensionEditIndex(f.doc).get(value.instanceId)!,bob=group.conflicts.title.find(v=>v.value==='Bob')!.intentId;resolveExtensionEdits(f.doc,registry,value.instanceId,group.ids,{title:bob},semanticBlockOrigin)}else materializeExtensionEdits(f.doc,registry)
  f.coordinator.changed({userId:'alice',displayName:'Alice'});const saved=await f.coordinator.save();assert.equal(saved.status,'saved');assert.equal(saved.pending,false);assert.equal(api.requests.length,1);assert.equal(api.head.blocks[0].content.inlines[0].extension!.data.title,overlap?'Bob':'Alice');if(!overlap)assert.equal(api.head.blocks[0].content.inlines[0].extension!.data.done,true);f.coordinator.dispose();f.doc.destroy();peerDoc.destroy()
 }
})


test('a late edit after committed block deletion is persisted and blocks a new canonical save until reviewed',async()=>{
 const f=await setupStructure(),peerDoc=new Y.Doc();Y.applyUpdate(peerDoc,Y.encodeStateAsUpdate(f.doc));const peer=new SemanticBlockStore(peerDoc,structureSchema),key=f.structure.keys()[0]
 try{
  f.structure.remove([key]);f.coordinator.changed({userId:'alice'});assert.equal((await f.coordinator.save()).revision,2);const count=f.api.requests.length
  const before=peer.content(key);peer.update(key,before,before.copy(structureSchema.nodes.paragraph.createChecked(null,structureSchema.text('Original Bob offline')).content))
  Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(peerDoc));f.coordinator.changed({userId:'bob'});assert.equal(f.coordinator.state().pending,true)
  const refused=await f.coordinator.save();assert.equal(refused.status,'failed');assert.equal(refused.problem,'deletion-drafts-conflict');assert.equal(f.api.requests.length,count);assert.equal(f.api.head.revision,2)
  const recovered=new Y.Doc();Y.applyUpdate(recovered,f.api.stored);assert.equal(deletionReviews(new SemanticBlockStore(recovered,structureSchema))[0].node.textContent,'Original Bob offline');recovered.destroy()
  resolveDeletionReview(f.structure,deletionReviews(f.structure)[0],'restore');f.coordinator.changed({userId:'alice'});assert.equal((await f.coordinator.save()).pending,false);assert.match(JSON.stringify(f.api.head),/Original Bob offline/)
 }finally{await f.coordinator.close();f.doc.destroy();peerDoc.destroy()}
})

test('inline late retarget blocks checkpoint; concurrent coordinator restores insert once and attribute the restoring actor',async()=>{
 const f=await setupStructure(),peerDoc=new Y.Doc();let peer:SemanticBlockStore|undefined
 try{
  setReferences(f.structure,[referenceFixture()]);f.coordinator.changed({userId:'alice'});await f.coordinator.save();Y.applyUpdate(peerDoc,Y.encodeStateAsUpdate(f.doc));peer=new SemanticBlockStore(peerDoc,structureSchema)
  setReferences(f.structure,[]);f.coordinator.changed({userId:'alice'});await f.coordinator.save()
  setReferences(peer,[referenceFixture('1','bob')]);Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(peerDoc));f.coordinator.changed({userId:'bob'})
  const blocked=await f.coordinator.save();assert.equal(blocked.problem,'deletion-drafts-conflict');assert.equal(f.api.requests.length,2)
  const fresh=new Y.Doc();Y.applyUpdate(fresh,f.api.stored);assert.equal(deletionReviews(new SemanticBlockStore(fresh,structureSchema)).length,1);fresh.destroy()
  const group=deletionReviews(f.structure)[0];assert.equal(group.inline,true)
  await Promise.all([f.coordinator.restoreInline(group,{userId:'restorer',displayName:'Restorer'}),f.coordinator.restoreInline(group,{userId:'second'})])
  assert.equal(f.structure.project().firstChild!.childCount,1);assert.equal(deletionReviews(f.structure).length,0)
  assert.equal((await f.coordinator.save()).pending,false);assert.equal(f.api.requests.length,3);assert.deepEqual(f.api.requests[2].referenceAuthors,[{mentionId:referenceFixture().mentionId,userId:'restorer'}]);assert.equal(f.api.head.blocks[0].content.inlines[0].reference!.target.id,'bob')
 }finally{await f.coordinator.close();f.doc.destroy();peerDoc.destroy()}
})

test('failed draft ownership persistence rejects inline restoration before changing the body',async()=>{
 const f=await setupStructure(),peerDoc=new Y.Doc()
 try{setReferences(f.structure,[referenceFixture()]);f.coordinator.changed({userId:'alice'});await f.coordinator.save();Y.applyUpdate(peerDoc,Y.encodeStateAsUpdate(f.doc));const peer=new SemanticBlockStore(peerDoc,structureSchema);setReferences(f.structure,[]);f.coordinator.changed({userId:'alice'});await f.coordinator.save();setReferences(peer,[referenceFixture('1','bob')]);Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(peerDoc));f.coordinator.changed({userId:'bob'});const before=f.structure.project().toJSON();f.api.failStore=true;await assert.rejects(f.coordinator.restoreInline(deletionReviews(f.structure)[0],{userId:'alice'}),/persistence/);assert.deepEqual(f.structure.project().toJSON(),before);assert.equal(deletionReviews(f.structure).length,1);assert.equal(f.api.requests.length,2)}finally{f.api.failStore=false;await f.coordinator.close();f.doc.destroy();peerDoc.destroy()}
})


test('post-creation-undo offline edits remain reviewable through a coordinator restart and restore into the canonical save path',async()=>{
 const f=await setupStructure(),undo=f.structure.undoManager(),peerDoc=new Y.Doc();let recovered:Y.Doc|undefined,next:Awaited<ReturnType<typeof setupStructure>>|undefined
 try{
  const clone=f.structure.duplicate([f.structure.keys()[0]],null)[0];undo.stopCapturing();f.coordinator.changed({userId:'alice'});assert.equal((await f.coordinator.save()).revision,2);Y.applyUpdate(peerDoc,Y.encodeStateAsUpdate(f.doc));const peer=new SemanticBlockStore(peerDoc,structureSchema)
  undo.undo();f.coordinator.changed({userId:'alice'});assert.equal((await f.coordinator.save()).revision,3)
  const before=peer.content(clone);peer.update(clone,before,before.copy(structureSchema.nodes.paragraph.createChecked(null,structureSchema.text('Original late copy edit')).content));Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(peerDoc));f.coordinator.changed({userId:'bob'});const requests=f.api.requests.length,reply=await f.coordinator.save();assert.equal(reply.problem,'deletion-drafts-conflict');assert.equal(f.api.requests.length,requests)
  await f.coordinator.close();recovered=new Y.Doc();Y.applyUpdate(recovered,f.api.stored);next=await setupStructure(f.api,recovered);assert.equal(next.coordinator.state().problem,'deletion-drafts-conflict');const group=deletionReviews(next.structure)[0];assert.match(group.node.textContent,/late copy edit/);resolveDeletionReview(next.structure,group,'restore');next.coordinator.changed({userId:'bob'});const saved=await next.coordinator.save();assert.equal(saved.pending,false);assert.equal(saved.revision,4);assert.match(JSON.stringify(f.api.head),/Original late copy edit/)
 }finally{undo.destroy();await next?.coordinator.close();await f.coordinator.close();f.doc.destroy();peerDoc.destroy();recovered?.destroy()}
})

for(const kind of ['bulletList','orderedList'])test(`restored ${kind} saves only projected items after coordinator reload and retains late input into its pruned slot`,async()=>{
 const f=await setupStructure(),undo=f.structure.undoManager(),peerDoc=new Y.Doc(),laterDoc=new Y.Doc();let recovered:Y.Doc|undefined,next:Awaited<ReturnType<typeof setupStructure>>|undefined
 try{
  const state=EditorState.create({schema:structureSchema,doc:f.structure.project()}),tr=state.tr;assert.ok(transformBlocks(tr,kind==='bulletList'?'block.bulletList':'block.orderedList',undefined,blockTarget(state,rootBlocks(state.doc))!));f.structure.reconcile(f.structure.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));undo.stopCapturing();f.coordinator.changed({userId:'alice'});assert.equal((await f.coordinator.save()).revision,2)
  const wrapper=f.structure.keys()[0],oldItem=f.structure.childKeys(wrapper)[0];Y.applyUpdate(peerDoc,Y.encodeStateAsUpdate(f.doc));Y.applyUpdate(laterDoc,Y.encodeStateAsUpdate(f.doc));const peer=new SemanticBlockStore(peerDoc,structureSchema),later=new SemanticBlockStore(laterDoc,structureSchema)
  const lateBefore=later.content(oldItem);later.update(oldItem,lateBefore,lateBefore.copy(lateBefore.content.append(Fragment.from(structureSchema.nodes.paragraph.createChecked(null,structureSchema.text('Later old slot'))))))
  undo.undo();f.coordinator.changed({userId:'alice'});assert.equal((await f.coordinator.save()).revision,3)
  const before=peer.content(wrapper),item=structureSchema.nodes.listItem.createChecked(null,[structureSchema.nodes.paragraph.createChecked(null,structureSchema.text('New offline item'))]);peer.update(wrapper,before,before.copy(before.content.append(Fragment.from(item))));Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(peerDoc));f.coordinator.changed({userId:'bob'});assert.equal((await f.coordinator.save()).problem,'deletion-drafts-conflict');assert.equal(f.api.requests.length,2)
  await f.coordinator.close();recovered=new Y.Doc();Y.applyUpdate(recovered,f.api.stored);next=await setupStructure(f.api,recovered);const group=deletionReviews(next.structure)[0];assert.equal(group.node.textContent,'New offline item');resolveDeletionReview(next.structure,group,'restore');const dormantOwner=next.structure.owners.get(oldItem)!;assert.equal(next.structure.canonicalIds.get(dormantOwner),null);next.coordinator.changed({userId:'bob'});const saved=await next.coordinator.save();assert.equal(saved.revision,4);assert.equal(saved.pending,false);assert.equal(f.api.requests[2].blocks.length,2);assert.equal(structureSourceTargets(next.structure).length,2);assert.equal(next.structure.canonicalIds.get(dormantOwner),null)
  Y.applyUpdate(recovered,Y.encodeStateAsUpdate(laterDoc));next.coordinator.changed({userId:'carol'});assert.equal(next.structure.project().textContent.match(/Original/g)?.length,1);assert.equal(next.structure.project().textContent.match(/Later old slot/g)?.length,1);assert.equal(next.structure.project().textContent.match(/New offline item/g)?.length,1);assert.equal(structureSourceTargets(next.structure).length,3);assert.equal((await next.coordinator.save()).revision,5);assert.equal(f.api.requests[3].blocks.length,3);assert.equal(next.coordinator.state().pending,false)
 }finally{undo.destroy();await next?.coordinator.close();await f.coordinator.close();f.doc.destroy();peerDoc.destroy();laterDoc.destroy();recovered?.destroy()}
})
