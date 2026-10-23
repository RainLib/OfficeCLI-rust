import {DraftActions} from './draftActions.ts'
import type { ImageGeometry, ImageNode } from './ImagePanel.tsx'

export type PositionedImage = ImageNode & { geometry: ImageGeometry }
export type ImageField = 'x'|'y'|'width'|'height'|'assetHash'
export type ImageDraft = { touched?:ImageField[]; conflictingFields?:ImageField[]; base: PositionedImage; revision: number; geometry: ImageGeometry; assetHash?: string; restoreSource?:boolean; page?: number; remote?: { image: PositionedImage; revision: number }; deleted?: boolean; observedRevision?: number; collaborationConflict?: boolean; alternatives?: Array<{intentId:string;geometry:ImageGeometry;assetHash?:string}> }
export const sameGeometry = (a: ImageGeometry, b: ImageGeometry) => a.unit === b.unit && (['x', 'y', 'width', 'height'] as const).every(key => Object.is(a[key], b[key]))
export const validGeometry = (geometry: ImageGeometry) => [geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite) && geometry.width > 0 && geometry.height > 0
const copy = (image: PositionedImage): PositionedImage => ({nodeId:image.nodeId,visualHash:image.visualHash,assetHash:image.assetHash,...(image.label!==undefined?{label:image.label}:{}),geometry:{...image.geometry}})
export const desiredAsset = (draft: ImageDraft) => draft.restoreSource?null:draft.assetHash ?? draft.base.assetHash
export const matchesImageDraft = (image: ImageNode, draft: ImageDraft) => !!image.geometry && sameGeometry(image.geometry, draft.geometry) && (image.assetHash ?? null) === (desiredAsset(draft) ?? null)

const fields:ImageField[]=['x','y','width','height','assetHash']
const fieldValue=(image:PositionedImage,field:ImageField)=>field==='assetHash'?image.assetHash??null:image.geometry[field]
const wanted=(draft:ImageDraft):PositionedImage=>({...draft.base,geometry:{...draft.geometry},assetHash:desiredAsset(draft)})
const different=(before:PositionedImage,after:PositionedImage)=>fields.filter(field=>!Object.is(fieldValue(before,field),fieldValue(after,field)))
const touched=(draft:ImageDraft)=>draft.touched??different(draft.base,wanted(draft))
const assign=(target:PositionedImage,source:PositionedImage,field:ImageField)=>{if(field==='assetHash')target.assetHash=source.assetHash;else target.geometry[field]=source.geometry[field]}
function staged(base:PositionedImage,revision:number,desired:PositionedImage,authored:ImageField[],page?:number,conflicts:ImageField[]=[]):ImageDraft{
 const assetChanged=(base.assetHash??null)!==(desired.assetHash??null)
 return {base:copy(base),revision,geometry:{...desired.geometry},touched:[...new Set(authored)],...(assetChanged?(desired.assetHash!=null?{assetHash:desired.assetHash}:{restoreSource:true}):{}),...(page!==undefined?{page}:{}),observedRevision:revision,...(conflicts.length?{conflictingFields:[...new Set(conflicts)],remote:{image:copy(base),revision}}:{})}
}

/** Owned by the workspace, not the selected object or its mounted inspector.
 * Confirmations cover the sent values only; the owner may journal full snapshots. */
export type DraftCollection = { readonly size: number; get(key:string): ImageDraft|undefined; set(key:string,value:ImageDraft): unknown; delete(key:string): boolean; entries(): IterableIterator<[string,ImageDraft]> }
export class ImageDraftStore {
  readonly actions=new DraftActions<PositionedImage>()
  protected drafts: DraftCollection
  constructor(drafts?: DraftCollection) { this.drafts = drafts ?? new Map<string, ImageDraft>() }
  private inFlight = new Map<string, ImageDraft>()
  private uploadNodes = new Set<string>()
  private removed = new Map<string,number>()
  private confirmed = new Map<string, { image: PositionedImage; revision: number }>()
  private listeners = new Set<() => void>()
  private generation = 0
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.generation
  protected changed() { this.generation++; this.listeners.forEach(listener => listener()) }
  protected isSaving(nodeId: string) { return this.inFlight.has(nodeId) || this.uploadNodes.has(nodeId) }
  get(nodeId: string) { return this.drafts.get(nodeId) }
  get size() { return this.drafts.size }
  get trackingIds(){return [...new Set([...this.drafts.entries()].map(([id])=>id).concat([...this.uploadNodes]))].sort()}
  get uploading() { return this.uploadNodes.size > 0 }
  get saving() { return this.inFlight.size > 0 || this.uploading }
  entries() { return [...this.drafts.entries()] }
  restore(entries:Array<[string,ImageDraft]>) {
    if(this.drafts.size||this.inFlight.size||this.uploading)throw new Error('Restore requires a fresh image store')
    for(const[id,draft]of entries)this.drafts.set(id,structuredClone(draft))
    this.changed()
  }
  currentImage(image: PositionedImage, revision: number) {
    const saved = this.confirmed.get(image.nodeId)
    return saved && saved.revision >= revision ? saved.image : image
  }
  private trim(){
    for(const map of [this.confirmed,this.removed]){
      if(map.size<=4096)continue
      for(const id of map.keys()){if(map.size<=4096)break;if(!this.drafts.get(id)&&!this.inFlight.has(id)&&!this.uploadNodes.has(id))map.delete(id)}
    }
  }
  private observe(image:PositionedImage,revision:number){
    const known=this.confirmed.get(image.nodeId),deleted=this.removed.get(image.nodeId)??-1
    if(revision< (known?.revision??-1)||revision<=deleted||known?.revision===revision&&known.image.visualHash!==image.visualHash)return false
    this.confirmed.set(image.nodeId,{image:copy(image),revision});this.removed.delete(image.nodeId);this.trim();return true
  }
  private settle(id:string){
    const draft=this.drafts.get(id)
    if(draft&&!this.isSaving(id)&&!draft.remote&&!draft.deleted&&matchesImageDraft(draft.base,draft))this.drafts.delete(id)
  }
  private merge(draft:ImageDraft,current:PositionedImage,revision:number):ImageDraft{
    const authored=touched(draft),local=wanted(draft),sent=this.inFlight.get(current.nodeId),next=copy(current)
    const conflicts=new Set(draft.conflictingFields??[])
    // Legacy conflicts did not store fields. Recover their actual overlap.
    if(draft.remote&&!draft.conflictingFields)for(const field of authored)if(!Object.is(fieldValue(draft.base,field),fieldValue(draft.remote.image,field))&&!Object.is(fieldValue(local,field),fieldValue(draft.remote.image,field)))conflicts.add(field)
    for(const field of authored){
      assign(next,local,field)
      if(Object.is(fieldValue(local,field),fieldValue(current,field))){conflicts.delete(field);continue}
      const changed=!Object.is(fieldValue(current,field),fieldValue(draft.base,field))
      const ownPending=sent&&revision>sent.revision&&Object.is(fieldValue(current,field),fieldValue(wanted(sent),field))
      if(draft.deleted||changed&&!ownPending)conflicts.add(field)
    }
    if(local.geometry.unit!==current.geometry.unit){next.geometry={...local.geometry};fields.filter(field=>field!=='assetHash').forEach(field=>conflicts.add(field))}
    const pending=this.inFlight.has(current.nodeId)
    return staged(current,revision,next,authored.filter(field=>pending||!Object.is(fieldValue(next,field),fieldValue(current,field))),draft.page,[...conflicts])
  }
  edit(image: PositionedImage, revision: number, geometry: ImageGeometry, page?: number, changedField?: 'x'|'y'|'width'|'height') {
    const saved=this.confirmed.get(image.nodeId)
    image=this.currentImage(image,revision);revision=Math.max(revision,saved?.revision??0)
    let previous=this.drafts.get(image.nodeId)
    if(previous?.remote&&!previous.conflictingFields)previous=this.merge(previous,previous.remote.image,previous.remote.revision)
    revision=Math.max(revision,previous?.revision??0)
    const before=previous?wanted(previous):copy(image)
    const next={...before,geometry:changedField?{...before.geometry,[changedField]:geometry[changedField]}:{...geometry}}
    const authored=new Set(previous?touched(previous):[])
    different(before,next).forEach(field=>authored.add(field))
    const base=previous?.base??image,conflicts=(previous?.conflictingFields??[]).filter(field=>!Object.is(fieldValue(next,field),fieldValue(base,field)))
    const keep=[...authored].filter(field=>this.inFlight.has(image.nodeId)||!Object.is(fieldValue(next,field),fieldValue(base,field)))
    const draft=staged(base,previous?.revision??revision,next,keep,page??previous?.page,conflicts)
    if(previous?.deleted||(this.removed.get(image.nodeId)??-1)>=revision){draft.deleted=true;draft.observedRevision=Math.max(previous?.observedRevision??0,this.removed.get(image.nodeId)??0)}
    this.drafts.set(image.nodeId,draft);this.settle(image.nodeId);this.changed()
    if(!sameGeometry(before.geometry,next.geometry))this.actions.emit({before,after:next,revision,page,kind:'edit'})
  }
  applyHistory(image:PositionedImage,revision:number,desired:PositionedImage,page?:number){
    if(this.isSaving(image.nodeId))throw new Error('historyBusy')
    this.confirmed.set(image.nodeId,{image:copy(image),revision})
    if(sameGeometry(image.geometry,desired.geometry)&&(image.assetHash??null)===(desired.assetHash??null))this.drafts.delete(image.nodeId)
    else {
      const assetChanged=(image.assetHash??null)!==(desired.assetHash??null)
      this.drafts.set(image.nodeId,{base:copy(image),geometry:{...desired.geometry},touched:different(image,desired),...(assetChanged?(desired.assetHash!=null?{assetHash:desired.assetHash}:{restoreSource:true}):{}),revision,page})
    }
    this.changed()
  }
  prepareReplacement(image:PositionedImage, revision:number, page?:number) {
    if(this.uploadNodes.has(image.nodeId))throw new Error('Image upload already in progress')
    let prior=this.drafts.get(image.nodeId)
    if(prior?.remote&&!prior.conflictingFields){prior=this.merge(prior,prior.remote.image,prior.remote.revision);this.drafts.set(image.nodeId,prior)}
    const baseline=copy(prior?.base??this.currentImage(image,revision))
    const initial=prior?wanted(prior):baseline
    this.uploadNodes.add(image.nodeId);this.changed()
    let ended=false,committed=false
    return {
      commit:(assetHash:string)=>{
        if(ended||committed||!/^[0-9a-f]{64}$/.test(assetHash))throw new Error('Invalid replacement upload')
        const current=this.currentImage(baseline,revision),previous=this.drafts.get(image.nodeId)
        const at=Math.max(revision,this.confirmed.get(image.nodeId)?.revision??0,previous?.revision??0)
        const before=previous?wanted(previous):copy(current),next={...before,assetHash}
        const conflicts=new Set(previous?.conflictingFields??[])
        if((current.assetHash??null)!==(baseline.assetHash??null)&&current.assetHash!==assetHash&&(current.assetHash??null)!==(initial.assetHash??null))conflicts.add('assetHash')
        if((next.assetHash??null)===((previous?.base??current).assetHash??null))conflicts.delete('assetHash')
        const draft=staged(previous?.base??current,at,next,[...new Set([...(previous?touched(previous):[]),'assetHash' as const])],page??previous?.page,[...conflicts])
        if(previous?.deleted||(this.removed.get(image.nodeId)??-1)>=at){draft.deleted=true;draft.observedRevision=Math.max(previous?.observedRevision??0,this.removed.get(image.nodeId)??0)}
        this.drafts.set(image.nodeId,draft);committed=true;this.changed()
        if(before.assetHash!==assetHash)this.actions.emit({before,after:next,revision:at,page,kind:'replace'})
      },
      finish:()=>{if(!ended){ended=true;this.uploadNodes.delete(image.nodeId);this.settle(image.nodeId);this.changed()}},
    }
  }
  reconcile(images: ImageNode[], revision: number) {
    let changed=false
    for(const image of images){
      const draft=this.drafts.get(image.nodeId)
      if(!image.geometry||draft&&revision<Math.max(draft.revision,draft.observedRevision??0)||!this.observe(image as PositionedImage,revision))continue
      if(!draft)continue
      const next=this.merge(draft,image as PositionedImage,revision)
      if(JSON.stringify(next)!==JSON.stringify(draft)){this.drafts.set(image.nodeId,next);changed=true}
      const had=this.drafts.get(image.nodeId);this.settle(image.nodeId);if(had&&!this.drafts.get(image.nodeId))changed=true
    }
    if(changed)this.changed()
  }
  markDeleted(nodeId: string, revision: number) {
    if(revision<Math.max(this.confirmed.get(nodeId)?.revision??0,this.removed.get(nodeId)??0))return
    this.removed.set(nodeId,revision);this.trim()
    const draft=this.drafts.get(nodeId)
    if(draft&&revision>=Math.max(draft.revision,draft.observedRevision??0)&&(!draft.deleted||revision>(draft.observedRevision??0))){this.drafts.set(nodeId,{...draft,deleted:true,observedRevision:revision});this.changed()}
  }
  resolve(nodeId:string,keepLocal:boolean){
    const draft=this.drafts.get(nodeId)
    if(!draft?.remote||this.isSaving(nodeId))return
    const current=this.currentImage(draft.remote.image,draft.remote.revision),revision=Math.max(draft.remote.revision,this.confirmed.get(nodeId)?.revision??0)
    const merged=this.merge(draft,current,revision),next=wanted(merged)
    if(!keepLocal)for(const field of merged.conflictingFields??[])assign(next,current,field)
    if(next.geometry.unit!==current.geometry.unit){if(keepLocal)return;next.geometry.unit=current.geometry.unit}
    this.actions.emit({before:current,after:current,revision,kind:'reset'})
    this.observe(current,revision)
    this.drafts.set(nodeId,staged(current,revision,next,different(current,next),draft.page));this.settle(nodeId);this.changed()
  }
  resolveVariant(_nodeId: string, _intentId: string) { /* Shared stores provide explicit concurrent-intent choices. */ }
  discard(nodeId: string) { const draft=this.drafts.get(nodeId);if (!this.isSaving(nodeId) && draft && this.drafts.delete(nodeId)){this.changed();this.actions.emit({before:draft.base,after:draft.base,revision:draft.revision,kind:'reset'})} }
  beginSave(sent: Array<[string, ImageDraft]>) {
    if(this.uploading)throw new Error('imageUploadPending')
    if (sent.some(([id]) => this.inFlight.has(id))) throw new Error('Image save already in progress')
    for (const [id, draft] of sent) {
      this.inFlight.set(id,draft)
      const current=this.drafts.get(id)
      if(current&&!current.touched)this.drafts.set(id,{...current,touched:[...new Set([...touched(current),...different(wanted(draft),wanted(current))])]})
    }
    this.changed()
  }
  endSave(sent: Array<[string, ImageDraft]>) {
    for (const [id, draft] of sent) if (this.inFlight.get(id) === draft){this.inFlight.delete(id);this.settle(id)}
    this.changed()
  }
  acknowledge(sent:Array<[string,ImageDraft]>,revision:number,images:ImageNode[]){
    for(const[id,saved]of sent){
      const image=images.find(image=>image.nodeId===id)
      if(!image?.geometry||!matchesImageDraft(image,saved))continue
      this.observe(image as PositionedImage,revision)
      const draft=this.drafts.get(id),latest=this.confirmed.get(id)
      if(!draft||!latest||draft.deleted||(this.removed.get(id)??-1)>revision)continue
      const next=wanted(draft),canonical=latest.image,conflicts=new Set(draft.conflictingFields??[])
      if(latest.revision>revision)for(const field of touched(saved)){
        if(!Object.is(fieldValue(canonical,field),fieldValue(wanted(saved),field))&&!Object.is(fieldValue(next,field),fieldValue(canonical,field)))conflicts.add(field)
      }
      for(const field of [...conflicts])if(Object.is(fieldValue(next,field),fieldValue(canonical,field)))conflicts.delete(field)
      // Untouched fields follow the latest canonical value; only authored
      // fields and input newer than the captured request survive its receipt.
      const authored=new Set([...touched(draft),...different(wanted(saved),next)])
      const desired=copy(canonical)
      for(const field of authored)assign(desired,next,field)
      if(next.geometry.unit!==canonical.geometry.unit)desired.geometry={...next.geometry}
      this.drafts.set(id,staged(canonical,latest.revision,desired,different(canonical,desired),draft.page,[...conflicts]))
      this.settle(id)
    }
    this.changed()
  }
}
