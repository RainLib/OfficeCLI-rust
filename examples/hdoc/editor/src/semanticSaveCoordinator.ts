import {inlineContainerEditIndex} from './inlineContainerEdits.ts'
import {nodeEditWireVersion} from './collaborationProtocol.ts'
import {referenceEditIndex,referenceEditField} from './referenceEdits.ts'
import {extensionEditIndex,nodeEditFields} from './extensionEdits.ts'
import {businessDraftProblem} from './businessDrafts.ts'
import {resolveInlineDeletionReview} from './inlineDeletionReview.ts'
import type {DeletionReview} from './deletionReview.ts'
import {hasInlineReferences} from './inlineReference.ts'
import {ReferenceAuthorLedger,validActorId,validContributor,actorName,type ReferenceAuthor,type ReferenceAuthorEntry} from './referenceAuthors.ts'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import * as Y from 'yjs'
import type {Schema} from '@tiptap/pm/model'
import {validateSemanticNodeJson} from './semanticInlineContent.ts'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { checkpointContents, legacyCheckpointContents, type SnapshotBlock } from './checkpointSnapshot.ts'
import { editorSurface, jsonToSnapshot, projectionToJson, type Projection } from './schema.ts'
import { captureImages, acknowledgeImages, imageDraftContents, imageDraftMap, imageReceiptMap, imageIntents, reconcileImageBaseline, type CapturedImage } from './collaborativeImages.ts'
import type { ImageNode } from './ImagePanel.tsx'
import { validGeometry, type PositionedImage } from './imageDrafts.ts'
import { yBlocks } from './typographyMigration.ts'
import { legacySnapshot, reconcileSourceIdentities, upgradeSourceIdentity } from './sourceIdentityMigration.ts'
import {SemanticBlockStore,semanticBlockFields} from './semanticBlockStore.ts'
import {textFlowFields} from './semanticTextFlow.ts'
import {structureSourceTargets,reconcileStructureSources,type SemanticSourceTarget,type StructureRootTarget} from './semanticStructureSources.ts'
import {validateSourceLeaf} from './semanticSourceBindings.ts'

type Receipt = { version: 1 | 2 | 3 | 4; inlineContainers?:1; documentId: string; epoch: number; lineage: string; revision: number; rootHash: string; digest: string }
export type SaveState = { inlineContainers?:1;nodeEditVersion?:typeof nodeEditWireVersion; type: 'hcd-save-status'; status: 'editing' | 'saving' | 'saved' | 'failed' | 'conflict' | 'sync-required'; revision?: number; digest?: string; pending?: boolean; saveMode?: string; conflict?: string; recoveryId?: string; imageDigest?: string; problem?: string; protectedBlockId?:string }
type Revision = { revision: number; rootHash: string; patchId?: string; patchBaseRevision?: number }
type Attempt = { referenceAuthors:ReferenceAuthor[]; id: string; digest: string; blocks: SnapshotBlock[]; nodes: SemanticSourceTarget[]; images: CapturedImage[]; contributors: Array<{ userId: string; displayName: string; generation: number }> }
type Options = { documentId: string; epoch: number; document: Y.Doc; structure?:SemanticBlockStore; inlineContainers?:1; secret: string; stateHash?: string; request: (route: string, init?: RequestInit) => Promise<Response>; broadcast: (state: SaveState) => void; idleMs?: number; maxMs?: number; autoSave?:boolean }
const hex = (value: unknown, length: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
const nonce = () => randomUUID().replaceAll('-', '')
const hash = (blocks: SnapshotBlock[]) => createHash('sha256').update(checkpointContents(blocks)).digest('hex')
const legacyHash = (blocks: SnapshotBlock[]) => createHash('sha256').update(legacyCheckpointContents(blocks)).digest('hex')
type Contributor={userId:string;displayName:string;generation:number}
type ContributorReceipt={version:1;documentId:string;epoch:number;lineage:string;baseRevision:number;observation:string;people:Contributor[]}
export type SemanticMigrationCandidate={document:Y.Doc;structure:SemanticBlockStore;sourceHash:string;sourceBytes:Uint8Array;baseRevision:number;targetEpoch:number}
type ImageAttempt = { inlineContainers?:1; referenceAuthors?:ReferenceAuthor[]; documentId: string; epoch: number; checkpointId: string; baseRevision: number; digest: string; nodes: string[]; images: CapturedImage[]; contributors?:Contributor[] }
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
  private ownerContributors:string|undefined
  private contributorsBound=false
  private writes: Promise<unknown> = Promise.resolve()
  private stores: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private firstDirty = 0
  private imageLookups = new Map<string,Promise<PositionedImage>>()
  private stateHash: string
  private referenceModel=false
  private referenceLedger:ReferenceAuthorLedger|null=null
  private ownerReferenceAuthors:string|undefined
  constructor(private options: Options) {
    if(options.inlineContainers)this.options={...options}
    if(options.structure&&options.structure.document!==options.document)throw new Error('Structural document differs')
    if(options.structure&&!options.structure.initialized)throw new Error('Structural room is not initialized')
    if(options.inlineContainers!==undefined&&options.inlineContainers!==1||!!options.structure?.flow.containers!==(options.inlineContainers===1))throw new Error('inline-save-model-not-negotiated')
    const model=options.document.getMap('hcdSchema').get('inlineContainers')
    if(model!==undefined&&model!==options.inlineContainers)throw new Error('inline-save-model-mismatch')
    if(!options.structure&&[semanticBlockFields.metadata,'hcd-semantic-blocks/1/meta','hcd-semantic-blocks/2/meta',textFlowFields.metadata].some(field=>options.document.getMap(field).get('version')!==undefined))throw new Error('Structural document requires negotiated protocol')
    this.stateHash = options.stateHash ?? 'none'
    if(options.inlineContainers&&options.document.getMap('hcdSave').has('receipt')&&!this.readReceipt())throw new Error('inline-save-receipt-invalid')
  }
  private get models(){return this.options.inlineContainers?{inlineContainers:true}:{} }
  private modelHeaders():Record<string,string>{return this.options.inlineContainers?{'X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3','X-HCD-Custom-Marks-Version':'1'}:{} }
  private json(){return this.options.structure?.project().toJSON()??TiptapTransformer.fromYdoc(this.options.document,'default')}
  private snapshot() { const blocks=jsonToSnapshot(this.json(),this.models);if(hasInlineReferences(blocks))this.referenceModel=true;return blocks }
  private reconcileSources(nodes:SemanticSourceTarget[],canonical:Projection['blocks']){
    if(this.options.structure)reconcileStructureSources(this.options.structure,nodes,canonical,origin)
    else{if(nodes.some(node=>!(node instanceof Y.XmlElement)))throw new Error('Structural receipt requires negotiated protocol');reconcileSourceIdentities(this.options.document,nodes as Y.XmlElement[],canonical,origin)}
  }
  private upgradeSources(projection:Projection){
    if(this.options.structure){if(this.options.document.getMap('hcdSchema').get('sourceIdentity')!==1)throw new Error('Structural source schema missing')}
    else upgradeSourceIdentity(this.options.document,projection,true)
  }
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
      return [1, 2, 3, 4].includes(base.version) && base.inlineContainers===this.options.inlineContainers && (!base.inlineContainers||base.version===4) && base.documentId === this.options.documentId && base.epoch === this.options.epoch && hex(base.lineage, 32) && hex(base.rootHash, 64) && hex(base.digest, 64) && Number.isSafeInteger(base.revision) && base.revision >= 0 ? base : null
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
  private nodeProblem(){return this.options.structure?businessDraftProblem(this.options.document,this.options.structure.project(),this.options.structure):undefined}
  private observation() { const nodes=[...extensionEditIndex(this.options.document),...(this.options.inlineContainers?[...inlineContainerEditIndex(this.options.document)]:[])],references=[...referenceEditIndex(this.options.document)];return `${hash(this.snapshot())}:${this.imageDigest()}${nodes.length?':'+JSON.stringify(nodes.map(([id,g])=>[id,g.ids,g.ready,Object.keys(g.conflicts)])):''}${references.length?':references:'+createHash('sha256').update(JSON.stringify(references.map(([id,g])=>[id,g.intents]))).digest('hex'):''}` }
  private validContributors(value:unknown):value is Contributor[]{
    return Array.isArray(value)&&value.length<=1000&&new Set(value.map(person=>person?.userId)).size===value.length&&value.every(validContributor)
  }
  private readContributors(){
    this.people.clear();this.contributorsBound=false;this.ownerContributors=undefined
    if(!this.base)return
    const pending=hash(this.snapshot())!==this.base.digest||this.options.document.getMap(imageDraftMap).size>0
    if(!pending)this.contributorsBound=true
    const token=this.options.document.getMap('hcdSave').get('contributors')
    try{
      if(typeof token!=='string'||token.length>256*1024)return
      const [body,signature,extra]=token.split('.'),raw=Buffer.from(body,'base64url').toString('utf8')
      const expected=createHmac('sha256',this.options.secret).update(raw).digest(),actual=Buffer.from(signature??'','base64url')
      if(extra!==undefined||expected.length!==actual.length||!timingSafeEqual(expected,actual))return
      const saved=JSON.parse(raw) as ContributorReceipt
      if(saved.version!==1||saved.documentId!==this.options.documentId||saved.epoch!==this.options.epoch||saved.lineage!==this.base.lineage||saved.baseRevision!==this.base.revision||saved.observation!==this.observation()||!this.validContributors(saved.people)||(pending&&!saved.people.length))return
      if(pending)saved.people.forEach(person=>this.people.set(person.userId,{displayName:person.displayName,generation:person.generation}))
      this.generation=Math.max(this.generation,...saved.people.map(person=>person.generation));this.contributorsBound=true;this.ownerContributors=token
    }catch{/* Replicated contributor claims do not establish server authority. */}
  }
  private writeContributors(){
    if(!this.base)return
    const pending=hash(this.snapshot())!==this.base.digest||this.options.document.getMap(imageDraftMap).size>0
    if(!pending){this.people.clear();this.contributorsBound=true}
    const people=[...this.people].map(([userId,value])=>({userId,...value})).sort((a,b)=>a.userId.localeCompare(b.userId))
    this.ownerContributors=this.contributorsBound&&(!pending||people.length)&&this.validContributors(people)?this.sign({version:1,documentId:this.options.documentId,epoch:this.options.epoch,lineage:this.base.lineage,baseRevision:this.base.revision,observation:this.observation(),people} satisfies ContributorReceipt):undefined
    const map=this.options.document.getMap('hcdSave')
    this.options.document.transact(()=>{if(this.ownerContributors===undefined)map.delete('contributors');else if(map.get('contributors')!==this.ownerContributors)map.set('contributors',this.ownerContributors)},origin)
  }
  private readReferenceAuthors(){
    this.ownerReferenceAuthors=undefined
    if(!this.base||!this.referenceLedger)return
    try{
      const token=this.options.document.getMap('hcdSave').get('referenceAuthors')
      if(typeof token!=='string'||token.length>8*1024*1024)return
      const [body,signature,extra]=token.split('.'),raw=Buffer.from(body,'base64url').toString('utf8'),actual=Buffer.from(signature??'','base64url'),expected=createHmac('sha256',this.options.secret).update(raw).digest()
      if(extra!==undefined||actual.length!==expected.length||!timingSafeEqual(actual,expected))return
      const saved=JSON.parse(raw) as {version:number;documentId:string;epoch:number;lineage:string;baseRevision:number;observation:string;entries:ReferenceAuthorEntry[]}
      if(saved.version!==1||saved.documentId!==this.options.documentId||saved.epoch!==this.options.epoch||saved.lineage!==this.base.lineage||saved.baseRevision!==this.base.revision||saved.observation!==this.observation())return
      this.referenceLedger.restore(saved.entries);this.ownerReferenceAuthors=token
    }catch{/* Unknown or replicated claims cannot authorize a new relationship. */}
  }
  private writeReferenceAuthors(){
    if(!this.base||!this.referenceLedger)return
    const entries=this.referenceLedger.proof()
    this.ownerReferenceAuthors=entries.length?this.sign({version:1,documentId:this.options.documentId,epoch:this.options.epoch,lineage:this.base.lineage,baseRevision:this.base.revision,observation:this.observation(),entries}):undefined
    const map=this.options.document.getMap('hcdSave')
    this.options.document.transact(()=>{if(this.ownerReferenceAuthors===undefined)map.delete('referenceAuthors');else if(map.get('referenceAuthors')!==this.ownerReferenceAuthors)map.set('referenceAuthors',this.ownerReferenceAuthors)},origin)
  }
  private acknowledgeContributors(people:Contributor[]=[]){for(const person of people)if((this.people.get(person.userId)?.generation??Infinity)<=person.generation)this.people.delete(person.userId)}
  private imageAttempt(token:unknown=this.options.document.getMap('hcdSave').get('imageAttempt')): ImageAttempt | null {
    if (token === undefined) return null
    if (typeof token !== 'string' || token.length > 4*1024*1024) throw new Error('Invalid image attempt receipt')
    const [body,signature,extra] = token.split('.'), raw = Buffer.from(body,'base64url').toString('utf8')
    const expected = createHmac('sha256',this.options.secret).update(raw).digest(), actual = Buffer.from(signature??'','base64url')
    if (extra!==undefined || expected.length!==actual.length || !timingSafeEqual(expected,actual)) throw new Error('Invalid image attempt signature')
    const saved = JSON.parse(raw) as ImageAttempt
    if(saved.inlineContainers!==this.options.inlineContainers)throw new Error('Invalid captured inline save model')
    if(saved.documentId!==this.options.documentId || saved.epoch!==this.options.epoch || !hex(saved.checkpointId,32) || !Number.isSafeInteger(saved.baseRevision) || saved.baseRevision<0 || !Array.isArray(saved.images) || saved.images.length>1000 || !hex(saved.digest,64) || !Array.isArray(saved.nodes) || saved.nodes.length>100000 || saved.nodes.some(node=>typeof node!=='string' || node.length>65536)) throw new Error('Invalid image attempt scope')
    if(saved.contributors!==undefined&&!this.validContributors(saved.contributors))throw new Error('Invalid captured contributors')
    // captureImages validates the signed values with the same schema as CRDT
    // intents, without trusting arbitrary replicated attempt metadata.
    for(const entry of saved.images) if(!entry || typeof entry.intentId!=='string' || !/^[a-f0-9-]{36}$/.test(entry.intentId) || !Array.isArray(entry.intentIds) || entry.intentIds.length>4000 || entry.intentIds.some(id=>typeof id!=='string' || !/^[a-f0-9-]{36}$/.test(id)) || !entry.change || !/^n_[a-f0-9]{32}$/.test(entry.change.nodeId) || !hex(entry.change.precondition?.visualHash,64) || (entry.change.assetHash!==undefined && !hex(entry.change.assetHash,64))) throw new Error('Invalid captured image')
    return saved
  }
  private setImageAttempt(sent: Attempt | null) {
    const candidate=sent?this.sign({...(this.options.inlineContainers?{inlineContainers:1 as const}:{}),documentId:this.options.documentId,epoch:this.options.epoch,checkpointId:sent.id,baseRevision:this.base!.revision,digest:sent.digest,nodes:sent.nodes.map(node=>node instanceof Y.XmlElement?Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(node,0))).toString('base64url'):`structure-root:${Buffer.from(JSON.stringify(node)).toString('base64url')}`),images:sent.images,contributors:sent.contributors,referenceAuthors:sent.referenceAuthors} satisfies ImageAttempt):undefined
    // A submitted attempt must fit the same recovery schema we can read after
    // a restart. Refuse oversized captures before publishing or committing it.
    try{if(candidate!==undefined)this.imageAttempt(candidate)}catch(error){this.attempt=null;throw error}
    this.ownerAttempt=candidate
    this.restoreOwnerMetadata()
  }
  private restoreOwnerMetadata() {
    if(!this.base)return
    this.writeReceipt()
    this.options.document.transact(()=>{
      const map=this.options.document.getMap('hcdSave'),schema=this.options.document.getMap('hcdSchema')
      if(this.ownerAttempt===undefined)map.delete('imageAttempt')
      else if(map.get('imageAttempt')!==this.ownerAttempt)map.set('imageAttempt',this.ownerAttempt)
      if(this.ownerContributors===undefined)map.delete('contributors');else if(map.get('contributors')!==this.ownerContributors)map.set('contributors',this.ownerContributors)
      if(this.ownerReferenceAuthors===undefined)map.delete('referenceAuthors');else if(map.get('referenceAuthors')!==this.ownerReferenceAuthors)map.set('referenceAuthors',this.ownerReferenceAuthors)
      if(this.ready)for(const[key,value]of Object.entries({typography:2,sourceIdentity:1,images:2,...(this.options.inlineContainers?{inlineContainers:1}:{})}))if(schema.get(key)!==value)schema.set(key,value)
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
    const response=await this.options.request(`/editor?revision=${record.revision}`,this.options.inlineContainers?{headers:this.modelHeaders()}:undefined)
    if(!response.ok) throw new Error('Immutable block recovery unavailable')
    const projection=await response.json() as Projection, canonical=editorSurface(projection.blocks)
    if(projection.revision!==record.revision || canonical.length!==pending.nodes.length) throw new Error('Captured block recovery differs')
    const nodes: SemanticSourceTarget[]=[], blocks: Projection['blocks']=[]
    pending.nodes.forEach((anchor,index)=> {
      if(anchor.startsWith('structure-root:')){
        if(!this.options.structure)throw new Error('Structural receipt requires negotiated protocol')
        const target=JSON.parse(Buffer.from(anchor.slice('structure-root:'.length),'base64url').toString('utf8')) as StructureRootTarget
        const ids=(value:unknown)=>Array.isArray(value)&&value.length<=10000&&value.every(id=>typeof id==='string'&&id.length>0&&id.length<=128)
        if(target.kind!=='structure-root'||typeof target.key!=='string'||target.key.length>128||typeof target.owner!=='string'||target.owner.length>128||target.blockId!==null&&(typeof target.blockId!=='string'||target.blockId.length>256)||!ids(target.texts)||!ids(target.sourceIds))throw new Error('Invalid structural source capture')
        if(target.bindings!==undefined){if(!Array.isArray(target.bindings)||target.bindings.length!==target.texts.length)throw new Error('Invalid structural source capture');target.bindings.forEach((binding,index)=>{validateSourceLeaf(binding,!!this.options.structure?.flow.containers);if(binding.key!==target.texts[index])throw new Error('Invalid structural source capture')})}
        if(this.options.structure.contents.has(target.key)){nodes.push(target);blocks.push(canonical[index])}return
      }
      const position=Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Buffer.from(anchor,'base64url')),this.options.document)
      if(position?.type instanceof Y.XmlElement) { nodes.push(position.type);blocks.push(canonical[index]) }
    })
    this.reconcileSources(nodes,blocks)
    acknowledgeImages(this.options.document,pending.images,images,record.revision,origin)
    this.acknowledgeContributors(pending.contributors)
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
    const json = projectionToJson(projection,this.models)
    const canonical = hash(jsonToSnapshot(json,this.models))
    const legacyCanonical = this.options.inlineContainers?undefined:legacyHash(legacySnapshot(json))
    let digest = hash(this.snapshot())
    this.referenceModel ||= hasInlineReferences(jsonToSnapshot(json,this.models))
    this.referenceLedger=new ReferenceAuthorLedger(this.snapshot(),jsonToSnapshot(json,this.models))
    this.base = this.readReceipt()
    this.readContributors()
    this.readReferenceAuthors()
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
          this.upgradeSources(projection)
          this.base = { ...this.base, version: 4, digest: canonical }
        } else if (!this.base) {
          const legacy = this.options.inlineContainers?undefined:legacyHash(legacySnapshot(this.json()))
          if(this.options.inlineContainers&&digest!==canonical)throw new Error('Unbound inline draft differs from canonical content')
          if (digest !== canonical && (this.options.document.getMap('hcdSchema').get('sourceIdentity') === 1 || legacy !== legacyCanonical)) throw new Error('Unbound draft differs from canonical content')
          this.upgradeSources(projection)
          digest = hash(this.snapshot())
          if (digest !== canonical) throw new Error('Unbound draft format differs after source migration')
          const record = await this.revision(projection.revision)
          this.base = { version: 4, ...(this.options.inlineContainers?{inlineContainers:1 as const}:{}), documentId: this.options.documentId, epoch: this.options.epoch, lineage: nonce(), revision: projection.revision, rootHash: record.rootHash, digest }
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
        if(this.options.inlineContainers&&metadata.get('inlineContainers')!==1)this.options.document.transact(()=>metadata.set('inlineContainers',1),origin)
      } catch { this.conflict = this.base ? 'legacy-source-identity' : 'unbound-draft' }
    }
    if (legacyProblem) this.conflict = 'legacy-typography'
    if(!this.conflict) await this.reconcilePendingImages()
    digest = hash(this.snapshot())
    this.writeReceipt()
    this.lastObserved = this.observation()
    if(hash(this.snapshot())===this.base?.digest&&!this.options.document.getMap(imageDraftMap).size)this.contributorsBound=true
    this.ready = true
    await this.persist()
    if (this.conflict) await this.archive()
    else if (this.state().pending) this.schedule()
  }
  state(status?: SaveState['status'], saveMode?: string): SaveState {
    const pending = !this.base || hash(this.snapshot()) !== this.base.digest || this.options.document.getMap(imageDraftMap).size>0 || !!this.nodeProblem()
    return { ...(this.options.inlineContainers?{inlineContainers:1 as const}:{}),nodeEditVersion:nodeEditWireVersion,type: 'hcd-save-status', status: this.conflict ? 'conflict' : status ?? (pending ? 'editing' : 'saved'), revision: this.base?.revision, digest: this.base?.digest, pending, imageDigest:this.imageDigest(),...(this.nodeProblem()?{problem:this.nodeProblem()}:{}), saveMode, conflict: this.conflict, recoveryId: this.recoveryId }
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
    const actor=validActorId(user?.userId)?{userId:user.userId,displayName:actorName(user.displayName||user.userId),generation:this.generation}:undefined
    if(actor)this.people.set(actor.userId,{displayName:actor.displayName,generation:actor.generation});else this.contributorsBound=false
    this.referenceLedger?.observe(this.snapshot(),actor)
    this.options.broadcast(this.state('editing'))
    if (!this.conflict) this.schedule()
  }
  private schedule(delay?: number) {
    if (this.closed || this.conflict || this.options.autoSave===false) return
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
      this.writeContributors()
      this.writeReferenceAuthors()
      this.writeReceipt()
      const bytes = Buffer.from(Y.encodeStateAsUpdate(this.options.document))
      const response = await this.options.request('/collaboration/state', { method: 'PUT', headers: { ...this.modelHeaders(), 'Content-Type': 'application/octet-stream', 'X-HCD-Coordinator-Version': '4', 'X-HCD-State-Hash': this.stateHash }, body: bytes })
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
  /** Serialize occurrence restoration with saves. Browser replicas must not
   * independently insert the same deleted atom on concurrent Restore clicks. */
  restoreInline(expected:Pick<DeletionReview,'key'|'receipt'|'snapshot'>,actor:{userId:string;displayName?:string}):Promise<SaveState>{
    const work=this.writes.catch(()=>{}).then(async()=>{
      if(!this.ready||this.closed||!this.options.structure||!validActorId(actor.userId)||!expected?.key?.startsWith('inline:'))throw new Error('deletion-review-changed')
      await this.validateHead();if(this.conflict||this.attempt)throw new Error('deletion-review-changed')
      await this.persist();if(this.conflict)throw new Error('deletion-review-changed')
      const store=new SemanticBlockStore(this.options.document,this.options.structure.schema,origin,this.options.structure.options)
      if(resolveInlineDeletionReview(store,expected,'restore'))this.changed(actor)
      await this.persist();if(this.conflict)throw new Error('deletion-review-changed')
      const state=this.state();this.options.broadcast(state);return state
    });this.writes=work;return work
  }
  private async performSave(requestedDigest?: string, requestedImages?: string): Promise<SaveState> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      if (this.conflict || !this.base) { await this.archive(); return this.state() }
      if ((requestedDigest && requestedDigest !== hash(this.snapshot())) || (requestedImages && requestedImages!==this.imageDigest())) return this.state('sync-required')
      await this.validateHead()
      if (this.conflict) return this.state()
      const nodeProblem=this.nodeProblem();if(nodeProblem){await this.persist();const state={...this.state('failed'),problem:nodeProblem};this.options.broadcast(state);return state}
      if (!this.attempt && !this.options.document.getMap(imageDraftMap).size && hash(this.snapshot()) === this.base.digest) {
        this.referenceLedger!.commit(this.snapshot())
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
        let references:ReturnType<ReferenceAuthorLedger['capture']>
        try{references=this.referenceLedger!.capture(blocks)}catch(error){await this.persist();await this.archive();this.options.broadcast({...this.state('failed'),problem:'reference-authors-unbound'});throw error}
        const contributors=new Map([...this.people].map(([userId,value])=>[userId,{userId,...value}]))
        for(const person of references.contributors){const old=contributors.get(person.userId);if(!old||old.generation<person.generation)contributors.set(person.userId,person)}
        this.attempt = { referenceAuthors:references.referenceAuthors,id: nonce(), blocks, images, digest: hash(blocks), nodes: this.options.structure?structureSourceTargets(this.options.structure):yBlocks(this.options.document), contributors: [...contributors.values()] }
      }
      const sent = this.attempt
      this.setImageAttempt(sent)
      this.options.broadcast(this.state('saving'))
      await this.persist()
      if (this.conflict) return this.state()
      const response = await this.options.request('/checkpoints', { method: 'POST', headers: { ...this.modelHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ typographyVersion: 2,extensionVersion:1,...(this.referenceModel?{referenceVersion:1}:{}),...(sent.referenceAuthors.length?{referenceAuthors:sent.referenceAuthors}:{}), coordinatorVersion: 4, coordinatorId: this.base.lineage, checkpointId: sent.id, coordinatorDigest: sent.digest, expectedRevision: this.base.revision, blocks: sent.blocks, images:sent.images.map(entry=>entry.change), contributors: sent.contributors.map(({ userId, displayName }) => ({ userId, displayName })) }) })
      if (response.status === 409) {
        this.conflict = 'canonical-changed'
        await this.archive()
        const state = this.state(); this.options.broadcast(state); return state
      }
      if (!response.ok) {
        if(response.status>=400 && response.status<500) { this.attempt=null;this.setImageAttempt(null);await this.persist() }
        if(response.status===422 && response.headers.get('x-hcd-error-code')==='DOCX_SOURCE_REQUIRED') {
          const state={...this.state('failed'),problem:'word-source-required'}
          this.options.broadcast(state)
          return state
        }
        if(response.status===422 && response.headers.get('x-hcd-error-code')==='DOCX_SOURCE_TEXT_READ_ONLY') {
          const blockId=response.headers.get('x-hcd-protected-block')
          const state={...this.state('failed'),problem:'word-field-read-only',...(/^n_[a-f0-9]{32}$/.test(blockId??'')?{protectedBlockId:blockId!}:{})}
          this.options.broadcast(state)
          // Do not retry an unchanged protected field indefinitely. An edit
          // made during the request may already have fixed the draft.
          if(hash(this.snapshot())!==sent.digest)this.schedule()
          return state
        }
        throw new Error(`Canonical save failed: ${response.status}`)
      }
      const saved = await response.json() as { revision: number; rootHash: string; projection: Projection; images?: ImageNode[]; saveMode?: string }
      if (!Number.isSafeInteger(saved.revision) || saved.revision < this.base.revision || !hex(saved.rootHash, 64) || saved.projection.revision !== saved.revision) throw new Error('Invalid canonical save receipt')
      this.base = { ...this.base, revision: saved.revision, rootHash: saved.rootHash, digest: sent.digest }
      try { acknowledgeImages(this.options.document,sent.images,saved.images??[],saved.revision,origin);this.setImageAttempt(null) }
      catch { this.conflict='image-identity' }
      const canonical = editorSurface(saved.projection.blocks)
      if (sent.nodes.length !== canonical.length) this.conflict = 'block-identity'
      else {
        try { this.reconcileSources(sent.nodes, canonical) }
        catch { this.conflict = 'source-identity' }
      }
      this.referenceLedger!.commit(sent.blocks)
      this.acknowledgeContributors(sent.contributors)
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
  /** Stop timers and drain canonical and binary writes. The room gate must
   * separately prevent new packets/direct changes before calling this. */
  async pause(){this.dispose();await this.writes.catch(()=>{});await this.stores.catch(()=>{});await this.persist()}
  async prepareRestore(expectedRevision:number){
    await this.pause()
    const state=await this.inspect()
    if(state.conflict||state.pending||state.revision!==expectedRevision){await this.archive();throw new Error('restore-comparison-changed')}
    await this.archive();await this.persist()
    return this.stateHash
  }
  resume(){this.closed=false;if(this.ready&&!this.conflict&&this.state().pending)this.schedule()}
  async prepareMigration(schema:Schema,targetEpoch:number):Promise<SemanticMigrationCandidate>{
    if(this.options.structure||!this.base||targetEpoch!==this.options.epoch+1)throw new Error('migration-source-protocol')
    await this.pause()
    // Reuse the exact durable attempt if an earlier response was lost. A new
    // checkpoint ID here could duplicate a previously committed operation.
    if(this.attempt||hasInlineReferences(this.snapshot()))await this.save()
    const state=await this.inspect()
    if(state.conflict||this.attempt){await this.archive();throw new Error('migration-source-conflict')}
    if(state.pending&&(!this.contributorsBound||!this.people.size)){await this.archive();throw new Error('migration-contributors-unbound')}
    if(this.options.document.getMap(referenceEditField).size||Object.values(nodeEditFields).some(name=>this.options.document.getMap(name).size)){await this.archive();throw new Error('migration-unknown-shared-data')}
    const allowed=new Set([referenceEditField,...Object.values(nodeEditFields),'default','hcdSchema','hcdSave',imageDraftMap,imageReceiptMap,semanticBlockFields.metadata,'hcd-semantic-blocks/1/meta','hcd-semantic-blocks/2/meta',textFlowFields.metadata])
    if([...this.options.document.share.keys()].some(key=>!allowed.has(key))||[...this.options.document.getMap('hcdSave').keys()].some(key=>!['receipt','imageAttempt','contributors','referenceAuthors'].includes(key))){await this.archive();throw new Error('migration-unknown-shared-data')}
    const json=this.json();try{validateSemanticNodeJson(json,schema)}catch(error){await this.archive();throw error}
    const document=new Y.Doc(),structure=new SemanticBlockStore(document,schema)
    try{
      structure.initialize(schema.nodeFromJSON(json))
      for(const name of ['hcdSchema',imageDraftMap,imageReceiptMap])for(const [key,value]of this.options.document.getMap(name)){
        if(value instanceof Y.AbstractType)throw new Error('migration-unknown-shared-data')
        document.getMap(name).set(key,structuredClone(value))
      }
      if(hash(jsonToSnapshot(structure.project().toJSON()))!==hash(this.snapshot())||imageDraftContents(document)!==imageDraftContents(this.options.document))throw new Error('migration-projection-differs')
      const base={...this.base!,version:4 as const,epoch:targetEpoch,lineage:nonce()}
      const people=[...this.people].map(([userId,value])=>({userId,...value}))
      document.getMap('hcdSave').set('receipt',this.sign(base))
      document.getMap('hcdSave').set('contributors',this.sign({version:1,documentId:this.options.documentId,epoch:targetEpoch,lineage:base.lineage,baseRevision:base.revision,observation:`${hash(jsonToSnapshot(structure.project().toJSON()))}:${createHash('sha256').update(imageDraftContents(document)).digest('hex')}`,people} satisfies ContributorReceipt))
      await this.persist()
      if(this.conflict){await this.archive();throw new Error('migration-source-conflict')}
      return{document,structure,sourceHash:this.stateHash,sourceBytes:Y.encodeStateAsUpdate(this.options.document),baseRevision:this.base!.revision,targetEpoch}
    }catch(error){document.destroy();await this.archive();throw error}
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
