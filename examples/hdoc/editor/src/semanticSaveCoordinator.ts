import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import * as Y from 'yjs'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { checkpointContents, legacyCheckpointContents, type SnapshotBlock } from './checkpointSnapshot.ts'
import { editorSurface, jsonToSnapshot, projectionToJson, type Projection } from './schema.ts'
import { captureImages, acknowledgeImages, imageDraftContents, imageDraftMap, imageIntents, reconcileImageBaseline, type CapturedImage } from './collaborativeImages.ts'
import type { ImageNode } from './ImagePanel.tsx'
import { validGeometry, type PositionedImage } from './imageDrafts.ts'
import { yBlocks } from './typographyMigration.ts'
import { legacySnapshot, reconcileSourceIdentities, upgradeSourceIdentity } from './sourceIdentityMigration.ts'

type Receipt = { version: 1 | 2 | 3 | 4; documentId: string; epoch: number; lineage: string; revision: number; rootHash: string; digest: string }
export type SaveState = { type: 'hcd-save-status'; status: 'editing' | 'saving' | 'saved' | 'failed' | 'conflict' | 'sync-required'; revision?: number; digest?: string; pending?: boolean; saveMode?: string; conflict?: string; recoveryId?: string; imageDigest?: string; problem?: string }
type Revision = { revision: number; rootHash: string; patchId?: string; patchBaseRevision?: number }
type Attempt = { id: string; digest: string; blocks: SnapshotBlock[]; nodes: Y.XmlElement[]; images: CapturedImage[]; contributors: Array<{ userId: string; displayName: string; generation: number }> }
type Options = { documentId: string; epoch: number; document: Y.Doc; secret: string; stateHash?: string; request: (route: string, init?: RequestInit) => Promise<Response>; broadcast: (state: SaveState) => void; idleMs?: number; maxMs?: number }
const hex = (value: unknown, length: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
const nonce = () => randomUUID().replaceAll('-', '')
const hash = (blocks: SnapshotBlock[]) => createHash('sha256').update(checkpointContents(blocks)).digest('hex')
const legacyHash = (blocks: SnapshotBlock[]) => createHash('sha256').update(legacyCheckpointContents(blocks)).digest('hex')
type ImageAttempt = { documentId: string; epoch: number; checkpointId: string; baseRevision: number; digest: string; nodes: string[]; images: CapturedImage[] }
const origin = 'hcd-save-coordinator'

/** One owner for manual saves, debounce saves, canonical IDs and durable
 * baselines. All network writes are serialized; canonical bases never poll
 * forward unless immutable signed revision history proves our own attempt. */
export class SemanticSaveCoordinator {
  private base: Receipt | null = null
  private conflict: string | undefined
  private recoveryId: string | undefined
  private archivedDigest = ''
  private lastObserved = ''
  private ready = false
  private closed = false
  private generation = 0
  private people = new Map<string, { displayName: string; generation: number }>()
  private attempt: Attempt | null = null
  private ownerAttempt: string | undefined
  private writes: Promise<unknown> = Promise.resolve()
  private stores: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private firstDirty = 0
  private imageLookups = new Map<string,Promise<PositionedImage>>()
  private stateHash: string
  constructor(private options: Options) { this.stateHash = options.stateHash ?? 'none' }
  private snapshot() { return jsonToSnapshot(TiptapTransformer.fromYdoc(this.options.document, 'default')) }
  private sign(base: unknown) {
    const value = JSON.stringify(base)
    return `${Buffer.from(value).toString('base64url')}.${createHmac('sha256', this.options.secret).update(value).digest('base64url')}`
  }
  private readReceipt(): Receipt | null {
    const value = this.options.document.getMap('hcdSave').get('receipt')
    if (typeof value !== 'string' || value.length > 4096) return null
    try {
      const [body, signature, extra] = value.split('.')
      if (extra !== undefined) return null
      const json = Buffer.from(body, 'base64url').toString('utf8'), actual = Buffer.from(signature, 'base64url')
      const expected = createHmac('sha256', this.options.secret).update(json).digest()
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
      const base = JSON.parse(json) as Receipt
      return [1, 2, 3, 4].includes(base.version) && base.documentId === this.options.documentId && base.epoch === this.options.epoch && hex(base.lineage, 32) && hex(base.rootHash, 64) && hex(base.digest, 64) && Number.isSafeInteger(base.revision) && base.revision >= 0 ? base : null
    } catch { return null }
  }
  private writeReceipt() {
    if (!this.base) return
    const value = this.sign(this.base)
    if (this.options.document.getMap('hcdSave').get('receipt') !== value) this.options.document.transact(() => this.options.document.getMap('hcdSave').set('receipt', value), origin)
  }
  private imageDigest() {
    try { return createHash('sha256').update(imageDraftContents(this.options.document)).digest('hex') }
    catch { return createHash('sha256').update('invalid-image-drafts').digest('hex') }
  }
  private observation() { return `${hash(this.snapshot())}:${this.imageDigest()}` }
  private imageAttempt(): ImageAttempt | null {
    const token = this.options.document.getMap('hcdSave').get('imageAttempt')
    if (token === undefined) return null
    if (typeof token !== 'string' || token.length > 4*1024*1024) throw new Error('Invalid image attempt receipt')
    const [body,signature,extra] = token.split('.'), raw = Buffer.from(body,'base64url').toString('utf8')
    const expected = createHmac('sha256',this.options.secret).update(raw).digest(), actual = Buffer.from(signature??'','base64url')
    if (extra!==undefined || expected.length!==actual.length || !timingSafeEqual(expected,actual)) throw new Error('Invalid image attempt signature')
    const saved = JSON.parse(raw) as ImageAttempt
    if(saved.documentId!==this.options.documentId || saved.epoch!==this.options.epoch || !hex(saved.checkpointId,32) || !Number.isSafeInteger(saved.baseRevision) || saved.baseRevision<0 || !Array.isArray(saved.images) || saved.images.length>1000 || !hex(saved.digest,64) || !Array.isArray(saved.nodes) || saved.nodes.length>100000 || saved.nodes.some(node=>typeof node!=='string' || node.length>256)) throw new Error('Invalid image attempt scope')
    // captureImages validates the signed values with the same schema as CRDT
    // intents, without trusting arbitrary replicated attempt metadata.
    for(const entry of saved.images) if(!entry || typeof entry.intentId!=='string' || !/^[a-f0-9-]{36}$/.test(entry.intentId) || !Array.isArray(entry.intentIds) || entry.intentIds.length>4000 || entry.intentIds.some(id=>typeof id!=='string' || !/^[a-f0-9-]{36}$/.test(id)) || !entry.change || !/^n_[a-f0-9]{32}$/.test(entry.change.nodeId) || !hex(entry.change.precondition?.visualHash,64) || (entry.change.assetHash!==undefined && !hex(entry.change.assetHash,64))) throw new Error('Invalid captured image')
    return saved
  }
  private setImageAttempt(sent: Attempt | null) {
    this.ownerAttempt=sent?this.sign({documentId:this.options.documentId,epoch:this.options.epoch,checkpointId:sent.id,baseRevision:this.base!.revision,digest:sent.digest,nodes:sent.nodes.map(node=>Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(node,0))).toString('base64url')),images:sent.images} satisfies ImageAttempt):undefined
    this.restoreOwnerMetadata()
  }
  private restoreOwnerMetadata() {
    if(!this.base)return
    this.writeReceipt()
    this.options.document.transact(()=>{
      const map=this.options.document.getMap('hcdSave'),schema=this.options.document.getMap('hcdSchema')
      if(this.ownerAttempt===undefined)map.delete('imageAttempt')
      else if(map.get('imageAttempt')!==this.ownerAttempt)map.set('imageAttempt',this.ownerAttempt)
      if(this.ready)for(const[key,value]of Object.entries({typography:2,sourceIdentity:1,images:2}))if(schema.get(key)!==value)schema.set(key,value)
    },origin)
  }
  private async recoverImages(record: Revision) {
    const pending=this.imageAttempt()
    if(!pending || pending.baseRevision+1!==record.revision) return
    if(record.patchId?.split(':')[2]!==pending.checkpointId || record.patchId?.split(':')[3]!==pending.digest) throw new Error('Image attempt differs from committed revision')
    const images: ImageNode[]=[]
    for(const entry of pending.images) {
      const response=await this.options.request(`/images/${encodeURIComponent(entry.change.nodeId)}?revision=${record.revision}`)
      if(!response.ok) throw new Error('Immutable image recovery unavailable')
      const value=await response.json() as {revision:number;image:ImageNode|null}
      if(value.revision!==record.revision || !value.image) throw new Error('Immutable image recovery differs')
      images.push(value.image)
    }
    const response=await this.options.request(`/editor?revision=${record.revision}`)
    if(!response.ok) throw new Error('Immutable block recovery unavailable')
    const projection=await response.json() as Projection, canonical=editorSurface(projection.blocks)
    if(projection.revision!==record.revision || canonical.length!==pending.nodes.length) throw new Error('Captured block recovery differs')
    const nodes: Y.XmlElement[]=[], blocks: Projection['blocks']=[]
    pending.nodes.forEach((anchor,index)=> {
      const position=Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Buffer.from(anchor,'base64url')),this.options.document)
      if(position?.type instanceof Y.XmlElement) { nodes.push(position.type);blocks.push(canonical[index]) }
    })
    reconcileSourceIdentities(this.options.document,nodes,blocks,origin)
    acknowledgeImages(this.options.document,pending.images,images,record.revision,origin)
    this.setImageAttempt(null)
  }
  private imageAt(nodeId:string,atRevision:number):Promise<PositionedImage> {
    const key=`${atRevision}:${nodeId}`,existing=this.imageLookups.get(key)
    if(existing) return existing
    const request=(async()=> {
      const response=await this.options.request(`/images/${encodeURIComponent(nodeId)}?revision=${atRevision}`)
      if(!response.ok) throw new Error(`${response.status>=400 && response.status<500?'image-baseline:':'Image lookup failed:'}${response.status}`)
      const value=await response.json() as {revision:number;image:ImageNode|null}
      if(value.revision!==atRevision || value.image?.nodeId!==nodeId || !value.image.geometry || !validGeometry(value.image.geometry)) throw new Error('image-baseline: unavailable immutable image')
      return value.image as PositionedImage
    })().catch(error=>{this.imageLookups.delete(key);throw error})
    this.imageLookups.set(key,request)
    if(this.imageLookups.size>2048) this.imageLookups.delete(this.imageLookups.keys().next().value!)
    return request
  }
  private async reconcilePendingImages():Promise<boolean> {
    if(!this.base || this.conflict) return false
    try {
      const before=imageDraftContents(this.options.document),entries=imageIntents(this.options.document)
      const verified=new Map<string,PositionedImage>(),current=new Map<string,PositionedImage>()
      // Immutable requests share cached promises and use bounded parallelism.
      for(let index=0;index<entries.length;index+=4) await Promise.all(entries.slice(index,index+4).map(async draft=> {
        const saved=await this.imageAt(draft.base.nodeId,this.base!.revision)
        current.set(saved.nodeId,saved)
        if(draft.base.visualHash!==saved.visualHash) {
          if(draft.revision>this.base!.revision) throw new Error('image-baseline: draft revision is ahead of its coordinator')
          verified.set(draft.intentId,await this.imageAt(draft.base.nodeId,draft.revision))
        }
      }))
      if(imageDraftContents(this.options.document)!==before) return false
      for(const saved of current.values()) reconcileImageBaseline(this.options.document,saved,this.base.revision,verified,origin)
      return true
    } catch(error) {
      if(error instanceof Error && (error.message.startsWith('image-baseline:') || /baseline|Image asset changed|shared image draft|draft limit/i.test(error.message))) {
        this.conflict='image-baseline';await this.archive();this.options.broadcast(this.state());return false
      }
      throw error
    }
  }
  private async revision(number: number) {
    const response = await this.options.request(`/revisions/${number}`)
    if (!response.ok) throw new Error(`Revision receipt unavailable: ${response.status}`)
    return await response.json() as Revision
  }
  private ownRevision(record: Revision) {
    const parts = record.patchId?.split(':')
    if (!parts || parts.length !== 6 || parts[0] !== `hcdsave${this.base?.version}` || parts[1] !== this.base?.lineage || !hex(parts[2], 32) || !hex(parts[3], 64) || !hex(parts[4], 64) || !Number.isSafeInteger(record.patchBaseRevision)) return null
    const unsigned = parts.slice(0, 5).join(':')
    const mac = createHmac('sha256', this.options.secret).update(`${this.options.documentId}:${this.options.epoch}:${record.patchBaseRevision}:${unsigned}`).digest('base64url')
    if (parts[5].length !== mac.length || !timingSafeEqual(Buffer.from(parts[5]), Buffer.from(mac))) return null
    return parts[3]
  }
  async initialize(projection: Projection, legacyProblem = false) {
    const json = projectionToJson(projection)
    const canonical = hash(jsonToSnapshot(json))
    const legacyCanonical = legacyHash(legacySnapshot(json))
    let digest = hash(this.snapshot())
    this.base = this.readReceipt()
    if(!this.base && this.options.document.getMap(imageDraftMap).size) this.conflict='unbound-image-draft'
    if (this.base) {
      const saved = await this.revision(this.base.revision)
      if (saved.revision !== this.base.revision || saved.rootHash !== this.base.rootHash || this.base.revision > projection.revision) { this.base = null; this.conflict = 'invalid-base' }
      else if (projection.revision > this.base.revision) {
        // Every commit after the persisted base must be a signed attempt from
        // this lineage. Pre-commit persistence guarantees its CRDT was stored.
        if (projection.revision - this.base.revision > 256) this.conflict = 'canonical-changed'
        else for (let number = this.base.revision + 1; number <= projection.revision; number++) {
          const record = await this.revision(number), savedDigest = this.ownRevision(record)
          if (!savedDigest || record.revision !== number || record.patchBaseRevision !== number - 1 || !hex(record.rootHash, 64)) { this.conflict = 'canonical-changed'; break }
          try { await this.recoverImages(record) } catch { this.conflict='image-recovery'; break }
          this.base = { ...this.base, revision: number, rootHash: record.rootHash, digest: savedDigest }
        }
      }
    }
    if(!this.conflict && this.base) {
      try {
        const pending=this.imageAttempt()
        if(pending && pending.baseRevision+1===this.base.revision) {
          const record=await this.revision(this.base.revision)
          if(this.ownRevision(record)!==this.base.digest) throw new Error('Unverified pending image commit')
          await this.recoverImages(record)
        }
      } catch { this.conflict='image-recovery' }
    }
    if (!this.conflict && !legacyProblem) {
      try {
        if (this.base?.version === 1) {
          if (this.base.digest !== legacyCanonical) throw new Error('Legacy receipt does not match its immutable canonical body')
          upgradeSourceIdentity(this.options.document, projection, true)
          this.base = { ...this.base, version: 4, digest: canonical }
        } else if (!this.base) {
          const legacy = legacyHash(legacySnapshot(TiptapTransformer.fromYdoc(this.options.document, 'default')))
          if (digest !== canonical && (this.options.document.getMap('hcdSchema').get('sourceIdentity') === 1 || legacy !== legacyCanonical)) throw new Error('Unbound draft differs from canonical content')
          upgradeSourceIdentity(this.options.document, projection, true)
          digest = hash(this.snapshot())
          if (digest !== canonical) throw new Error('Unbound draft format differs after source migration')
          const record = await this.revision(projection.revision)
          this.base = { version: 4, documentId: this.options.documentId, epoch: this.options.epoch, lineage: nonce(), revision: projection.revision, rootHash: record.rootHash, digest }
        } else if (this.options.document.getMap('hcdSchema').get('sourceIdentity') !== 1) throw new Error('Source identity schema missing')
        if (this.base && this.base.version<4) this.base={...this.base,version:4}
        const metadata=this.options.document.getMap('hcdSchema')
        if(metadata.get('images')!==undefined && metadata.get('images')!==1 && metadata.get('images')!==2) throw new Error('Unsupported image draft protocol')
        // Validate even an empty text snapshot before granting the room a base.
        imageDraftContents(this.options.document)
        const pending=this.imageAttempt()
        if(pending && pending.baseRevision!==this.base!.revision) throw new Error('Unsettled image receipt')
        this.setImageAttempt(null)
        if(metadata.get('images')!==2) this.options.document.transact(()=>metadata.set('images',2),origin)
      } catch { this.conflict = this.base ? 'legacy-source-identity' : 'unbound-draft' }
    }
    if (legacyProblem) this.conflict = 'legacy-typography'
    if(!this.conflict) await this.reconcilePendingImages()
    digest = hash(this.snapshot())
    this.writeReceipt()
    this.lastObserved = this.observation()
    this.ready = true
    await this.persist()
    if (this.conflict) await this.archive()
    else if (this.state().pending) this.schedule()
  }
  state(status?: SaveState['status'], saveMode?: string): SaveState {
    const pending = !this.base || hash(this.snapshot()) !== this.base.digest || this.options.document.getMap(imageDraftMap).size>0
    return { type: 'hcd-save-status', status: this.conflict ? 'conflict' : status ?? (pending ? 'editing' : 'saved'), revision: this.base?.revision, digest: this.base?.digest, pending, imageDigest:this.imageDigest(), saveMode, conflict: this.conflict, recoveryId: this.recoveryId }
  }
  currentDigest() { return hash(this.snapshot()) }
  async invalidate(code: string) { this.conflict = code; await this.archive(); this.options.broadcast(this.state()) }
  private async validateHead() {
    if (!this.base || this.conflict || this.attempt) return
    const response = await this.options.request('/revisions?limit=1')
    if (!response.ok) throw new Error(`Canonical head unavailable: ${response.status}`)
    const head = await response.json() as { headRevision: number }
    if (head.headRevision !== this.base.revision) await this.invalidate('canonical-changed')
  }
  inspect():Promise<SaveState> {
    const work=this.writes.catch(()=>{}).then(async()=> {
      await this.validateHead()
      if(!this.conflict)this.restoreOwnerMetadata()
      if(!this.conflict && !this.attempt) await this.reconcilePendingImages()
      return this.state()
    })
    this.writes=work;return work
  }
  changed(user?: { userId?: string; displayName?: string }, transactionOrigin?: unknown) {
    if (!this.ready || transactionOrigin === origin) return
    if(!this.conflict)this.restoreOwnerMetadata()
    const digest = this.observation()
    if (digest === this.lastObserved) return
    this.lastObserved = digest
    this.generation++
    if (user?.userId && /^[A-Za-z0-9_-]{1,128}$/.test(user.userId)) this.people.set(user.userId, { displayName: [...(user.displayName?.trim() || user.userId)].slice(0, 64).join(''), generation: this.generation })
    this.options.broadcast(this.state('editing'))
    if (!this.conflict) this.schedule()
  }
  private schedule(delay?: number) {
    if (this.closed || this.conflict) return
    const now = Date.now()
    if (!this.firstDirty) this.firstDirty = now
    if (this.timer) clearTimeout(this.timer)
    const due = delay ?? Math.max(0, Math.min(now + (this.options.idleMs ?? 30_000), this.firstDirty + (this.options.maxMs ?? 60_000)) - now)
    this.timer = setTimeout(() => { this.timer = null; void this.save().catch(() => {}) }, due)
  }
  /** Encode when the serialized write actually starts, so a delayed store can
   * never overwrite a newer binary with an older captured update. */
  persist(): Promise<void> {
    const work = this.stores.catch(() => {}).then(async () => {
      this.writeReceipt()
      const bytes = Buffer.from(Y.encodeStateAsUpdate(this.options.document))
      const response = await this.options.request('/collaboration/state', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-HCD-Coordinator-Version': '4', 'X-HCD-State-Hash': this.stateHash }, body: bytes })
      if (response.status === 409 || response.status === 412) { this.conflict = response.status === 409 ? 'epoch-changed' : 'state-changed'; await this.archive(); this.options.broadcast(this.state()); return }
      if (!response.ok) throw new Error(`Draft persistence failed: ${response.status}`)
      const saved = await response.json() as { stateHash: string }
      if (!hex(saved.stateHash, 64)) throw new Error('Invalid draft persistence receipt')
      this.stateHash = saved.stateHash
    })
    this.stores = work
    return work
  }
  async archive(): Promise<string> {
    const digest = createHash('sha256').update(Y.encodeStateAsUpdate(this.options.document)).digest('hex')
    if (this.recoveryId && this.archivedDigest === digest) return this.recoveryId
    const response = await this.options.request('/collaboration/recovery', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(Y.encodeStateAsUpdate(this.options.document)) })
    if (!response.ok) throw new Error(`Draft recovery persistence failed: ${response.status}`)
    const saved = await response.json() as { recoveryId: string }
    this.archivedDigest = digest; this.recoveryId = saved.recoveryId
    return saved.recoveryId
  }
  save(requestedDigest?: string, requestedImages?: string): Promise<SaveState> {
    const work = this.writes.catch(() => {}).then(() => this.performSave(requestedDigest, requestedImages))
    this.writes = work
    return work
  }
  private async performSave(requestedDigest?: string, requestedImages?: string): Promise<SaveState> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      if (this.conflict || !this.base) { await this.archive(); return this.state() }
      if ((requestedDigest && requestedDigest !== hash(this.snapshot())) || (requestedImages && requestedImages!==this.imageDigest())) return this.state('sync-required')
      await this.validateHead()
      if (this.conflict) return this.state()
      if (!this.attempt && !this.options.document.getMap(imageDraftMap).size && hash(this.snapshot()) === this.base.digest) {
        await this.persist(); this.firstDirty = 0
        const state = this.state()
        if (state.pending) this.schedule()
        this.options.broadcast(state)
        return state
      }
      if (!this.attempt) {
        if(this.options.document.getMap(imageDraftMap).size) {
          await this.persist()
          if(this.conflict) return this.state()
          if(!await this.reconcilePendingImages()) {if(!this.conflict)this.schedule(500);return this.state('sync-required')}
        }
        const blocks = this.snapshot()
        let images: CapturedImage[]
        try { images=captureImages(this.options.document) }
        catch(error) {
          await this.persist()
          const problem=error instanceof Error && ['image-drafts-not-ready','image-drafts-conflict'].includes(error.message)?error.message:'image-draft-schema'
          if(problem==='image-draft-schema'){this.conflict=problem;await this.archive()}
          const state={...this.state('failed'),problem}
          this.options.broadcast(state);return state
        }
        this.attempt = { id: nonce(), blocks, images, digest: hash(blocks), nodes: yBlocks(this.options.document), contributors: [...this.people].map(([userId, value]) => ({ userId, ...value })) }
      }
      const sent = this.attempt
      this.setImageAttempt(sent)
      this.options.broadcast(this.state('saving'))
      await this.persist()
      if (this.conflict) return this.state()
      const response = await this.options.request('/checkpoints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ typographyVersion: 2, coordinatorVersion: 4, coordinatorId: this.base.lineage, checkpointId: sent.id, coordinatorDigest: sent.digest, expectedRevision: this.base.revision, blocks: sent.blocks, images:sent.images.map(entry=>entry.change), contributors: sent.contributors.map(({ userId, displayName }) => ({ userId, displayName })) }) })
      if (response.status === 409) {
        this.conflict = 'canonical-changed'
        await this.archive()
        const state = this.state(); this.options.broadcast(state); return state
      }
      if (!response.ok) { if(response.status>=400 && response.status<500) { this.attempt=null;this.setImageAttempt(null);await this.persist() } throw new Error(`Canonical save failed: ${response.status}`) }
      const saved = await response.json() as { revision: number; rootHash: string; projection: Projection; images?: ImageNode[]; saveMode?: string }
      if (!Number.isSafeInteger(saved.revision) || saved.revision < this.base.revision || !hex(saved.rootHash, 64) || saved.projection.revision !== saved.revision) throw new Error('Invalid canonical save receipt')
      this.base = { ...this.base, revision: saved.revision, rootHash: saved.rootHash, digest: sent.digest }
      try { acknowledgeImages(this.options.document,sent.images,saved.images??[],saved.revision,origin);this.setImageAttempt(null) }
      catch { this.conflict='image-identity' }
      const canonical = editorSurface(saved.projection.blocks)
      if (sent.nodes.length !== canonical.length) this.conflict = 'block-identity'
      else {
        try { reconcileSourceIdentities(this.options.document, sent.nodes, canonical, origin) }
        catch { this.conflict = 'source-identity' }
      }
      for (const user of sent.contributors) if ((this.people.get(user.userId)?.generation ?? Infinity) <= user.generation) this.people.delete(user.userId)
      this.attempt = null
      this.writeReceipt()
      await this.persist()
      await this.validateHead()
      this.lastObserved = this.observation()
      this.firstDirty = 0
      const state = this.state(undefined, saved.saveMode)
      if (this.conflict) await this.archive()
      else if (state.pending) this.schedule()
      this.options.broadcast(state)
      return state
    } catch (error) {
      this.options.broadcast(this.state('failed'))
      this.schedule(5000)
      throw error
    }
  }
  async close() {
    this.dispose()
    await this.writes.catch(() => {})
    await this.persist()
  }
  async prepareUnload() {
    if (!this.ready) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.writes.catch(() => {})
    await this.persist()
    // Hocuspocus can cancel an unload if a connection arrives while awaiting
    // this hook. Keep the coordinator alive until afterUnloadDocument fires.
    if (this.state().pending) this.schedule()
  }
  dispose() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
