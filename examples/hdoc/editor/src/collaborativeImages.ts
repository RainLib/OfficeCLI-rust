import * as Y from 'yjs'
import { ImageDraftStore, sameGeometry, validGeometry, type DraftCollection, type ImageDraft, type PositionedImage } from './imageDrafts.ts'
import type { ImageGeometry, ImageNode } from './ImagePanel.tsx'

export const imageDraftMap = 'hcdImageDrafts'
export const imageReceiptMap = 'hcdImageReceipts'
const geometryFields = ['x','y','width','height'] as const
const fields = [...geometryFields,'assetHash'] as const
type Field = typeof fields[number]
type DesiredImage = { geometry: ImageGeometry; assetHash?: string | null; base?: PositionedImage }
const fieldValue = (value: DesiredImage, field: Field) => field==='assetHash' ? value.assetHash??value.base?.assetHash??null : value.geometry[field]
const sameImage = (a:DesiredImage,b:DesiredImage) => sameGeometry(a.geometry,b.geometry) && fieldValue(a,'assetHash')===fieldValue(b,'assetHash')
export type SharedImageDraft = ImageDraft & { intentId: string; clientId: number; touched: Field[]; ancestors: string[] }
export type SnapshotImage = { nodeId: string; geometry: ImageGeometry; assetHash?: string; precondition: { visualHash: string } }
export type CapturedImage = { intentId: string; intentIds: string[]; base?: PositionedImage; clientId?: number; change: SnapshotImage }
export type ImageReplacementCapture={base:PositionedImage;revision:number;clientId:number;seen:SharedImageDraft[];page?:number}
const nodeId = /^n_[a-f0-9]{32}$/
const hash = /^[a-f0-9]{64}$/
const intent = /^[a-f0-9-]{36}$/
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
function geometry(value: unknown): value is ImageGeometry {
  return record(value) && ['pt','emu'].includes(value.unit) && geometryFields.every(key => typeof value[key] === 'number')
}
function image(value: unknown): value is PositionedImage {
  return record(value) && nodeId.test(value.nodeId) && hash.test(value.visualHash) && geometry(value.geometry) && validGeometry(value.geometry)
    && (value.assetHash == null || hash.test(value.assetHash))
}
/** Previews and asset bytes never enter the shared intent log. */
const cleanImage = (value: PositionedImage): PositionedImage => ({ nodeId:value.nodeId, visualHash:value.visualHash, ...(value.assetHash ? {assetHash:value.assetHash} : {}), geometry:{...value.geometry} })
const visibleImage = (draft: ImageDraft): PositionedImage => cleanImage({ nodeId:draft.base.nodeId, visualHash:draft.base.visualHash, geometry:{...draft.geometry}, ...(draft.assetHash ? {assetHash:draft.assetHash} : draft.base.assetHash ? {assetHash:draft.base.assetHash} : {}) })
function sharedDraft(key: string, value: unknown): SharedImageDraft | null {
  if (!intent.test(key) || !record(value) || value.intentId!==key || !image(value.base) || !revision(value.clientId) || value.clientId>0xffffffff
    || !revision(value.revision) || !geometry(value.geometry) || value.geometry.unit!==value.base.geometry.unit
    || !Array.isArray(value.touched) || value.touched.length>5 || new Set(value.touched).size!==value.touched.length || value.touched.some((field:unknown)=>!fields.includes(field as Field))
    || (value.assetHash!==undefined && (typeof value.assetHash!=='string' || !hash.test(value.assetHash)))
    || (value.touched.includes('assetHash') && !hash.test(value.assetHash??''))
    || (value.ancestors!==undefined && (!Array.isArray(value.ancestors) || value.ancestors.length>64 || value.ancestors.some((id:unknown)=>typeof id!=='string' || !intent.test(id))))
    || (value.page!==undefined && !revision(value.page))) return null
  return {intentId:key,clientId:value.clientId,ancestors:[...(value.ancestors??[])],touched:[...value.touched].sort(),base:cleanImage(value.base),geometry:{...value.geometry},...(value.assetHash!==undefined?{assetHash:value.assetHash}:{}),revision:value.revision,...(value.page!==undefined?{page:value.page}:{})}
}
export function imageIntents(document: Y.Doc): SharedImageDraft[] {
  const map=document.getMap(imageDraftMap)
  if(map.size>4000) throw new Error('Image draft limit exceeded')
  return [...map].sort(([a],[b])=>a.localeCompare(b)).map(([id,value])=> {
    const draft=sharedDraft(id,value)
    if(!draft) throw new Error('Invalid shared image draft')
    return draft
  })
}
function groupImages(document: Y.Doc, preferredClient?: number): Array<{id:string;draft:SharedImageDraft;intents:SharedImageDraft[]}> {
  const groups=new Map<string,SharedImageDraft[]>()
  for(const entry of imageIntents(document)) { const group=groups.get(entry.base.nodeId);if(group)group.push(entry);else groups.set(entry.base.nodeId,[entry]) }
  if(groups.size>1000) throw new Error('Image draft limit exceeded')
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([id,entries])=> {
    const ordered=[...entries].sort((a,b)=>Number(b.clientId===preferredClient)-Number(a.clientId===preferredClient)||a.intentId.localeCompare(b.intentId))
    const first=ordered[0], baseline=[...entries].sort((a,b)=>b.revision-a.revision||a.intentId.localeCompare(b.intentId))[0].base
    const merged:DesiredImage={geometry:{...baseline.geometry},assetHash:baseline.assetHash}, alternative:DesiredImage={geometry:{...baseline.geometry},assetHash:baseline.assetHash}
    const assign=(target:DesiredImage,field:Field,value:number|string|null)=>{if(field==='assetHash')target.assetHash=value as string|null;else target.geometry[field]=value as number}
    const conflictingFields:Field[]=[]
    let conflict=entries.some(entry=>entry.base.visualHash!==first.base.visualHash)
    const touched=fields.filter(field=>entries.some(entry=>entry.touched.includes(field)))
    for(const field of fields) {
      const values=ordered.filter(entry=>entry.touched.includes(field)).map(entry=>fieldValue(entry,field))
      if(values.length) { assign(merged,field,values[0]);assign(alternative,field,values.find(value=>!Object.is(value,values[0]))??values[0]) }
      if(values.some(value=>!Object.is(value,values[0]))) {conflict=true;conflictingFields.push(field)}
    }
    const desired=(value:DesiredImage)=>({geometry:value.geometry,...(value.assetHash?{assetHash:value.assetHash}:{})})
    return {id,intents:entries,draft:{...first,base:baseline,revision:Math.max(...entries.map(entry=>entry.revision)),touched,...desired(merged),...(conflict?{collaborationConflict:true,remote:{image:{...first.base,...desired(alternative)},revision:first.revision},alternatives:ordered.map(entry=>{const choice:DesiredImage={...merged,geometry:{...merged.geometry}};conflictingFields.forEach(field=>{if(entry.touched.includes(field))assign(choice,field,fieldValue(entry,field))});return{intentId:entry.intentId,...desired(choice)}})}:{})}}
  })
}
/** Stable across key order and peers; invalid numeric input remains distinct. */
export function imageDraftContents(document: Y.Doc): string {
  return JSON.stringify(imageIntents(document),(_key,value)=>typeof value==='number' && !Number.isFinite(value)?{invalidNumber:String(value)}:record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value)
}
export async function imageDraftDigest(document: Y.Doc): Promise<string> {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(imageDraftContents(document)))
  return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('')
}
export function captureImages(document: Y.Doc): CapturedImage[] {
  return groupImages(document).map(({id,draft,intents})=> {
    if(draft.remote) throw new Error('image-drafts-conflict')
    if(!validGeometry(draft.geometry)) throw new Error('image-drafts-not-ready')
    return {intentId:draft.intentId,intentIds:intents.map(entry=>entry.intentId),base:cleanImage(draft.base),clientId:draft.clientId,change:{nodeId:id,geometry:{...draft.geometry},...(draft.touched.includes('assetHash')?{assetHash:draft.assetHash}:{}),precondition:{visualHash:draft.base.visualHash}}}
  })
}
/** Private recovery records must preserve exactly which intents a receipt may
 * remove. Validate without consulting the current (possibly newer) draft. */
export function validateCapturedImages(value:unknown):asserts value is CapturedImage[]{
  if(!Array.isArray(value)||value.length>1000)throw new Error('Invalid captured images')
  const nodes=new Set<string>(),ids=new Set<string>()
  for(const entry of value){
    if(!record(entry)||!intent.test(entry.intentId)||!Array.isArray(entry.intentIds)||!entry.intentIds.length||entry.intentIds.length>4000||!entry.intentIds.includes(entry.intentId)||!image(entry.base)||!revision(entry.clientId)||entry.clientId>0xffffffff||!record(entry.change)||!nodeId.test(entry.change.nodeId)||nodes.has(entry.change.nodeId)||entry.base.nodeId!==entry.change.nodeId||!hash.test(entry.change.precondition?.visualHash)||entry.change.precondition.visualHash!==entry.base.visualHash||!geometry(entry.change.geometry)||!validGeometry(entry.change.geometry)||entry.change.geometry.unit!==entry.base.geometry.unit||entry.change.assetHash!==undefined&&!hash.test(entry.change.assetHash))throw new Error('Invalid captured images')
    nodes.add(entry.change.nodeId)
    for(const id of entry.intentIds){if(typeof id!=='string'||!intent.test(id)||ids.has(id)||ids.size>=4000)throw new Error('Invalid captured images');ids.add(id)}
  }
}
export function validateImageReplacementCapture(value:unknown):asserts value is ImageReplacementCapture{
  if(!record(value)||!image(value.base)||!revision(value.revision)||!revision(value.clientId)||value.clientId>0xffffffff||!Array.isArray(value.seen)||value.seen.length>4000||value.page!==undefined&&!revision(value.page))throw new Error('Invalid image replacement capture')
  const ids=new Set<string>()
  for(const entry of value.seen){const draft=sharedDraft(entry?.intentId,entry);if(!draft||draft.base.nodeId!==value.base.nodeId||ids.has(draft.intentId))throw new Error('Invalid image replacement capture');ids.add(draft.intentId)}
}
/** Only intents observed when choosing the file may be superseded. A resumed
 * server upload uses the same capture; it must not re-select today's intents. */
export function applyImageReplacement(document:Y.Doc,capture:ImageReplacementCapture,assetHash:string,origin:unknown='hcd-image-edit',intentId:string=crypto.randomUUID()):string{
  validateImageReplacementCapture(capture)
  if(!hash.test(assetHash)||!intent.test(intentId))throw new Error('Invalid replacement upload')
  const map=document.getMap(imageDraftMap)
  if(map.has(intentId))throw new Error('Image replacement already applied')
  document.transact(()=>{
    for(const prior of capture.seen.filter(entry=>entry.touched.includes('assetHash'))){
      const actual=sharedDraft(prior.intentId,map.get(prior.intentId))
      if(!actual||JSON.stringify(actual)!==JSON.stringify(prior))continue
      map.delete(prior.intentId);const touched=prior.touched.filter(field=>field!=='assetHash')
      if(touched.length){const nextId=crypto.randomUUID();map.set(nextId,{...prior,intentId:nextId,touched,assetHash:undefined,ancestors:[prior.intentId,...prior.ancestors].slice(0,64)})}
    }
    map.set(intentId,{intentId,clientId:capture.clientId,ancestors:[...new Set(capture.seen.flatMap(entry=>[entry.intentId,...entry.ancestors]))].slice(0,64),base:cleanImage(capture.base),revision:capture.revision,geometry:{...capture.base.geometry},assetHash,touched:['assetHash'],...(capture.page!==undefined?{page:capture.page}:{})})
  },origin)
  return intentId
}
/** Acknowledgement deletes only captured intent IDs. Unseen concurrent changes
 * are rebased field by field, preserving explicit reversions to the old value. */
function candidate(actions:Array<()=>void>, entries:SharedImageDraft[], document:Y.Doc, saved:PositionedImage, atRevision:number, touched:Field[], clientId=0) {
  if(!touched.length || entries.some(entry=>entry.base.nodeId===saved.nodeId && entry.base.visualHash===saved.visualHash && sameImage(entry,saved))) return
  const intentId=crypto.randomUUID()
  actions.push(()=>document.getMap(imageDraftMap).set(intentId,{intentId,clientId,ancestors:[],touched,base:cleanImage(saved),geometry:{...saved.geometry},...(touched.includes('assetHash')?{assetHash:saved.assetHash}:{}),revision:atRevision}))
}
function rebase(actions:Array<()=>void>, document:Y.Doc, draft:SharedImageDraft, saved:PositionedImage, atRevision:number) {
  const touched=draft.touched.filter(field=>!Object.is(fieldValue(draft,field),fieldValue(saved,field))), next={...saved.geometry}
  touched.forEach(field=>{if(field!=='assetHash')next[field]=draft.geometry[field]})
  if(!touched.length) actions.push(()=>document.getMap(imageDraftMap).delete(draft.intentId))
  else actions.push(()=>document.getMap(imageDraftMap).set(draft.intentId,{...draft,base:cleanImage(saved),geometry:next,...(touched.includes('assetHash')?{assetHash:draft.assetHash}:{assetHash:undefined}),touched,revision:atRevision}))
}
export function acknowledgeImages(document:Y.Doc,sent:CapturedImage[],images:ImageNode[],atRevision:number,origin:unknown) {
  if(!revision(atRevision) || images.length!==sent.length) throw new Error('Incomplete image receipt')
  const entries=imageIntents(document), actions:Array<()=>void>=[], map=document.getMap(imageDraftMap)
  for(const captured of sent) {
    const id=captured.change.nodeId, saved=images.find(value=>value.nodeId===id)
    if(!image(saved) || !sameGeometry(saved.geometry,captured.change.geometry)) throw new Error('Image receipt differs from captured geometry')
    const before=captured.base??entries.find(entry=>entry.base.visualHash===captured.change.precondition.visualHash)?.base
    if((saved.assetHash??null)!==(captured.change.assetHash??before?.assetHash??null)) throw new Error('Image receipt differs from captured asset')
    const disputed=new Set<Field>()
    for(const draft of entries.filter(entry=>entry.base.nodeId===id)) {
      if(draft.base.visualHash!==captured.change.precondition.visualHash) throw new Error('Image base changed while its receipt was pending')
      if(captured.intentIds.includes(draft.intentId)) actions.push(()=>map.delete(draft.intentId))
      else {
        const causal=draft.ancestors.some(id=>captured.intentIds.includes(id))
        const overlap=before?draft.touched.filter(field=>!Object.is(fieldValue(before,field),fieldValue(saved,field)) && !Object.is(fieldValue(draft,field),fieldValue(saved,field))):draft.touched
        if(!causal && overlap.length) overlap.forEach(field=>disputed.add(field))
        else rebase(actions,document,draft,saved,atRevision)
      }
    }
    candidate(actions,entries,document,saved,atRevision,[...disputed],captured.clientId)
    actions.push(()=>document.getMap(imageReceiptMap).set(id,{image:cleanImage(saved),revision:atRevision}))
  }
  document.transact(()=> {
    actions.forEach(action=>action())
    const receipts=document.getMap(imageReceiptMap)
    for(const [id] of [...receipts].sort(([a,av],[b,bv])=>Number((av as any).revision)-Number((bv as any).revision)||a.localeCompare(b)).slice(0,Math.max(0,receipts.size-1000))) receipts.delete(id)
  },origin)
}

/** Immutable API baselines, never unsigned CRDT preview receipts, authorize a
 * stale intent's rebase. An overlapping committed value becomes an explicit
 * choice; disjoint fields can follow the newer canonical geometry. */
export function reconcileImageBaseline(document:Y.Doc,current:PositionedImage,atRevision:number,originals:Map<string,PositionedImage>,origin:unknown) {
  const entries=imageIntents(document), actions:Array<()=>void>=[], disputed=new Set<Field>()
  if(!image(current)) throw new Error('Invalid canonical image baseline')
  for(const draft of entries.filter(entry=>entry.base.nodeId===current.nodeId)) {
    if(draft.base.visualHash===current.visualHash) {
      if(!sameGeometry(draft.base.geometry,current.geometry) || (draft.base.assetHash??null)!==(current.assetHash??null)) throw new Error('Image geometry baseline differs')
      continue
    }
    const original=originals.get(draft.intentId)
    if(!image(original) || original.visualHash!==draft.base.visualHash || !sameImage(original,draft.base)) throw new Error('Unverified original image baseline')
    const overlap=draft.touched.filter(field=>!Object.is(fieldValue(original,field),fieldValue(current,field)) && !Object.is(fieldValue(draft,field),fieldValue(current,field)))
    if(overlap.length) overlap.forEach(field=>disputed.add(field))
    else rebase(actions,document,draft,current,atRevision)
  }
  candidate(actions,entries,document,current,atRevision,[...disputed])
  document.transact(()=>actions.forEach(action=>action()),origin)
}

/** Each edit has its own Y.Map key. Concurrent edits cannot erase each other's
 * values; disjoint fields merge, overlapping values need an explicit choice. */
export class CollaborativeImageDraftStore extends ImageDraftStore {
  private document: Y.Doc
  ownsDocument(document:Y.Doc){return this.document===document}
  private uploads=0
  private serverAuthored=new Map<string,{nodeId:string;assetHash:string;clientId:number}>()
  /** Window-local history ownership after an authenticated server upload reply.
   * This never changes shared authors, receipts or client IDs. */
  acceptServerReplacement(intentId:string,nodeId:string,assetHash:string,clientId:number){if(!intent.test(intentId)||!hash.test(assetHash)||!revision(clientId)||clientId>0xffffffff)throw new Error('historyInvalid');this.serverAuthored.set(intentId,{nodeId,assetHash,clientId})}
  get uploading() { return this.uploads>0 }
  private notify=()=>this.changed()
  constructor(document: Y.Doc) {
    const map=document.getMap(imageDraftMap)
    const adapter:DraftCollection={
      get size() { try{return groupImages(document).length}catch{return map.size} },
      get:id=>groupImages(document,document.clientID).find(group=>group.id===id)?.draft,
      set(id,value) {
        const draft=sharedDraft((value as SharedImageDraft).intentId,value)
        if(!draft || draft.base.nodeId!==id) throw new Error('Invalid image intent')
        const replaced=imageIntents(document).filter(entry=>entry.base.nodeId===id)
        document.transact(()=>{replaced.forEach(entry=>map.delete(entry.intentId));map.set(draft.intentId,{...draft,ancestors:[...new Set([...replaced.map(entry=>entry.intentId),...replaced.flatMap(entry=>entry.ancestors),...draft.ancestors])].slice(0,64)})},'hcd-image-edit')
      },
      delete(id) {
        const replaced=imageIntents(document).filter(entry=>entry.base.nodeId===id)
        document.transact(()=>replaced.forEach(entry=>map.delete(entry.intentId)),'hcd-image-edit')
        return !!replaced.length
      },
      *entries() { for(const group of groupImages(document,document.clientID)) yield [group.id,group.draft] as [string,ImageDraft] },
    }
    super(adapter);this.document=document
  }
  connect() {
    const maps=[this.document.getMap(imageDraftMap),this.document.getMap(imageReceiptMap),this.document.getMap('hcdSave')]
    maps.forEach(map=>map.observe(this.notify))
    return ()=>maps.forEach(map=>map.unobserve(this.notify))
  }
  override get saving() { return this.uploading || super.saving || !!this.document.getMap('hcdSave').get('imageAttempt') }
  protected override isSaving(id:string) { return this.saving || super.isSaving(id) }
  override edit(value:PositionedImage, atRevision:number, next:ImageGeometry, page?:number, changedField?:typeof geometryFields[number]) {
    const current=this.currentImage(value,atRevision), previous=this.drafts.get(value.nodeId)
    if(previous?.collaborationConflict) throw new Error('Resolve the collaborative image conflict first')
    const before=previous?.geometry??current.geometry
    const desired=changedField?{...before,[changedField]:next[changedField]}:next
    const touched=fields.filter(field=>(previous as SharedImageDraft|undefined)?.touched.includes(field)||(field!=='assetHash' && !Object.is(before[field],desired[field])))
    if(!touched.length && !previous) return
    const beforeImage=previous?visibleImage(previous):cleanImage(current)
    this.drafts.set(value.nodeId,{base:previous?.base??cleanImage(current),revision:previous?.revision??Math.max(atRevision,Number((this.document.getMap(imageReceiptMap).get(value.nodeId) as any)?.revision)||0),geometry:{...desired},...(previous?.assetHash?{assetHash:previous.assetHash}:{}),intentId:crypto.randomUUID(),clientId:this.document.clientID,touched,...(page!==undefined?{page}:previous?.page!==undefined?{page:previous.page}:{})} as SharedImageDraft)
    this.changed()
    this.note(beforeImage,{...beforeImage,geometry:{...desired}},atRevision,page,'edit')
  }
  /** Commit an already revalidated recovery as a new, locally owned intent.
   * Never remove or reuse the old packet's intent or another member's draft. */
  applyRecovery(value:PositionedImage,atRevision:number,next:ImageGeometry,assetHash?:string,page?:number):boolean {
    if(this.saving||!image(value)||!revision(atRevision)||!geometry(next)||!validGeometry(next)||next.unit!==value.geometry.unit||assetHash!==undefined&&!hash.test(assetHash))throw new Error('recovery-image-plan-invalid')
    if(imageIntents(this.document).some(entry=>entry.base.nodeId===value.nodeId))throw new Error('recovery-image-room-draft')
    const before=cleanImage(value),after=cleanImage({...before,geometry:{...next},...(assetHash!==undefined?{assetHash}:{})})
    const touched=fields.filter(field=>!Object.is(fieldValue(before,field),fieldValue(after,field)))
    if(!touched.length)return false
    this.drafts.set(value.nodeId,{intentId:crypto.randomUUID(),clientId:this.document.clientID,ancestors:[],base:before,revision:atRevision,geometry:{...after.geometry},touched,...(touched.includes('assetHash')?{assetHash:after.assetHash}:{}),...(page!==undefined?{page}:{})} as SharedImageDraft)
    this.changed();this.note(before,after,atRevision,page,'choose');return true
  }
  /** Bind the user's choice before asynchronous upload. Only resource intents
   * seen at that moment may be superseded; later edits remain separate. */
  captureReplacement(value:PositionedImage,atRevision:number,page?:number):ImageReplacementCapture {
    const current=this.currentImage(value,atRevision),previous=this.drafts.get(value.nodeId)
    if(previous?.collaborationConflict) throw new Error('Resolve the collaborative image conflict first')
    const base=cleanImage(previous?.base??current)
    const revision=previous?.revision??Math.max(atRevision,Number((this.document.getMap(imageReceiptMap).get(value.nodeId) as any)?.revision)||0)
    const seen=imageIntents(this.document).filter(entry=>entry.base.nodeId===value.nodeId)
    return {base,revision,clientId:this.document.clientID,seen,...(page!==undefined?{page}:{})}
  }
  applyCapturedReplacement(capture:ImageReplacementCapture,assetHash:string,intentId:string) {
    const previous=this.drafts.get(capture.base.nodeId)
    applyImageReplacement(this.document,capture,assetHash,'hcd-image-edit',intentId)
    this.changed()
    if(capture.clientId===this.document.clientID)this.note({...capture.base,assetHash:previous?.assetHash??capture.base.assetHash},{...capture.base,assetHash},capture.revision,capture.page,'replace')
  }
  prepareReplacement(value:PositionedImage,atRevision:number,page?:number) {
    const previous=this.drafts.get(value.nodeId),capture=this.captureReplacement(value,atRevision,page),baseline=capture.base,at=capture.revision
    this.uploads++;this.changed()
    let ended=false,committed=false
    return {
      commit:(assetHash:string)=> {
        if(ended || committed || !hash.test(assetHash)) throw new Error('Invalid replacement upload')
        applyImageReplacement(this.document,capture,assetHash)
        committed=true;this.changed()
        this.note({...baseline,assetHash:previous?.assetHash??baseline.assetHash},{...baseline,assetHash},at,page,'replace')
      },
      finish:()=>{if(!ended){ended=true;this.uploads--;this.changed()}},
    }
  }
  replace(value:PositionedImage,atRevision:number,assetHash:string,page?:number) {
    if(!hash.test(assetHash)) throw new Error('Invalid replacement asset')
    const current=this.currentImage(value,atRevision),previous=this.drafts.get(value.nodeId)
    if(previous?.collaborationConflict) throw new Error('Resolve the collaborative image conflict first')
    const beforeImage=previous?visibleImage(previous):cleanImage(current)
    this.drafts.set(value.nodeId,{base:previous?.base??cleanImage(current),revision:previous?.revision??Math.max(atRevision,Number((this.document.getMap(imageReceiptMap).get(value.nodeId) as any)?.revision)||0),geometry:{...(previous?.geometry??current.geometry)},assetHash,intentId:crypto.randomUUID(),clientId:this.document.clientID,touched:[...new Set([...(previous as SharedImageDraft|undefined)?.touched??[],'assetHash'])],...(page!==undefined?{page}:previous?.page!==undefined?{page:previous.page}:{})} as SharedImageDraft)
    this.changed()
    this.note(beforeImage,{...beforeImage,assetHash},atRevision,page,'replace')
  }
  override resolve(id:string,keepLocal:boolean) {
    const previous=this.drafts.get(id)
    if(this.saving || !previous?.remote) return
    const choice=keepLocal?previous:previous.remote.image
    const geometry=choice.geometry
    const beforeImage=visibleImage(previous)
    this.drafts.set(id,{base:previous.base,revision:previous.revision,geometry:{...geometry},...(choice.assetHash?{assetHash:choice.assetHash}:{}),intentId:crypto.randomUUID(),clientId:this.document.clientID,touched:(previous as SharedImageDraft).touched,...(previous.page!==undefined?{page:previous.page}:{})} as SharedImageDraft)
    this.changed()
    this.note(beforeImage,{...beforeImage,geometry:{...geometry},...(choice.assetHash?{assetHash:choice.assetHash}:{})},previous.revision,previous.page,'choose')
  }
  override resolveVariant(id:string,intentId:string) {
    const previous=this.drafts.get(id), choice=previous?.alternatives?.find(value=>value.intentId===intentId)
    if(this.saving || !previous || !choice) return
    const beforeImage=visibleImage(previous)
    this.drafts.set(id,{base:previous.base,revision:previous.revision,geometry:{...choice.geometry},...(choice.assetHash?{assetHash:choice.assetHash}:{}),intentId:crypto.randomUUID(),clientId:this.document.clientID,touched:(previous as SharedImageDraft).touched,...(previous.page!==undefined?{page:previous.page}:{})} as SharedImageDraft)
    this.changed()
    this.note(beforeImage,{...beforeImage,geometry:{...choice.geometry},...(choice.assetHash?{assetHash:choice.assetHash}:{})},previous.revision,previous.page,'choose')
  }
  /** Inverse of one local action. Peer intents stay; this does not roll the shared map back. */
  override applyHistory(baseline:PositionedImage,atRevision:number,desired:PositionedImage,page?:number,inverseFields:readonly Field[]=fields) {
    if(this.saving||this.uploading) throw new Error('historyBusy')
    if(!image(baseline)||!image(desired)||baseline.nodeId!==desired.nodeId||baseline.geometry.unit!==desired.geometry.unit) throw new Error('historyInvalid')
    const entries=imageIntents(this.document).filter(entry=>entry.base.nodeId===baseline.nodeId)
    const own=(entry:SharedImageDraft)=>{const receipt=this.serverAuthored.get(entry.intentId);return entry.clientId===this.document.clientID||!!receipt&&receipt.nodeId===entry.base.nodeId&&receipt.clientId===entry.clientId&&receipt.assetHash===entry.assetHash&&entry.touched.length===1&&entry.touched[0]==='assetHash'}
    const local=entries.filter(own)
    const peers=entries.filter(entry=>!own(entry))
    // Keep earlier local fields, but do not claim unrelated unsaved peer fields.
    const next=cleanImage(baseline)
    const assign=(field:Field,value:DesiredImage)=>{if(field==='assetHash')next.assetHash=fieldValue(value,field) as string;else next.geometry[field]=value.geometry[field]}
    for(const entry of local)for(const field of entry.touched){
      if(!inverseFields.includes(field)&&!Object.is(fieldValue(baseline,field),fieldValue(entry.base,field))&&!Object.is(fieldValue(baseline,field),fieldValue(entry,field)))throw new Error('historyConflict')
      assign(field,entry)
    }
    inverseFields.forEach(field=>assign(field,desired))
    const changed=fields.filter(field=>!Object.is(fieldValue(next,field),fieldValue(baseline,field)))
    if(peers.some(peer=>inverseFields.some(field=>peer.touched.includes(field)&&!Object.is(fieldValue(peer,field),fieldValue(next,field))))) throw new Error('historyConflict')
    const map=this.document.getMap(imageDraftMap),id=crypto.randomUUID()
    this.document.transact(()=> {
      local.forEach(entry=>map.delete(entry.intentId))
      if(!changed.length) return
      const geometry={...baseline.geometry}
      changed.forEach(field=>{if(field!=='assetHash')geometry[field]=next.geometry[field]})
      map.set(id,{intentId:id,clientId:this.document.clientID,ancestors:[...new Set(local.flatMap(entry=>[entry.intentId,...entry.ancestors]))].slice(0,64),base:cleanImage(baseline),geometry,...(changed.includes('assetHash')?{assetHash:next.assetHash}:{}),touched:changed,revision:atRevision,...(page!==undefined?{page}:{})})
    },'hcd-history')
    this.changed()
  }
  private note(before:PositionedImage,after:PositionedImage,atRevision:number,page:number|undefined,kind:'edit'|'replace'|'choose') {
    if(fields.every(field=>Object.is(fieldValue(before,field),fieldValue(after,field)))) return
    this.actions.emit({before:cleanImage(before),after:cleanImage(after),revision:atRevision,page,kind})
  }
  override reconcile(_images:ImageNode[],_revision:number) { /* Only immutable coordinator receipts mutate intents. */ }
  override markDeleted(_id:string,_revision:number) { /* Canonical changes are handled by the room owner. */ }
  override currentImage(value:PositionedImage,atRevision:number) {
    const receipt=this.document.getMap(imageReceiptMap).get(value.nodeId) as any
    if(record(receipt) && revision(receipt.revision) && receipt.revision>=atRevision && image(receipt.image)) return receipt.image
    return super.currentImage(value,atRevision)
  }
}
