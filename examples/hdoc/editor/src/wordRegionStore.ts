import type {StructureBindingStore} from './semanticStructureBinding.ts'
import {Node as TiptapNode,getSchema} from '@tiptap/core'
import type {Node as PmNode,Schema} from '@tiptap/pm/model'
import * as Y from 'yjs'
import {readWordLayout,type WordLayout} from './wordRegions.ts'
import {matchesWordLayoutTransition,matchesWordStoryUnlinkTransition,type WordStoryUnlinkIntent} from './wordLayoutTransition.ts'
import type {WordLayoutPending} from './wordCheckpointJournal.ts'
import {matchesWordStoryLinkTransition,type WordLinkTransaction} from './wordLinkPlan.ts'
import {schemaExtensions,projectionToJson,jsonToSnapshot,type Projection,type Block} from './schema.ts'
import {SemanticBlockStore,type StableSemanticBlock,type ProposedSemanticBlock,type SemanticReconcileOptions} from './semanticBlockStore.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {structureSourceTargets,prepareStructureSources,type SemanticSourceTarget} from './semanticStructureSources.ts'
import {checkpointContents,type SnapshotBlock} from './checkpointSnapshot.ts'

export const wordRegionStoreField='hcd-word-regions/1/meta'
export const wordBoundaryName='hcdWordRegionBoundary'
export const wordRegionEditOrigin=Object.freeze({kind:'hcd-word-region-edit/1'})
const receiptOrigin=Object.freeze({kind:'hcd-word-region-receipt/1'})
/** Internal fence, never a document block or clipboard/import node. Views edit
 * a scoped projection without these fences; checkpoints never serialize them. */
export const WordRegionBoundary=TiptapNode.create({
 name:wordBoundaryName,group:'block',atom:true,selectable:false,draggable:false,
 addAttributes(){return Object.fromEntries(['regionId','hcdBlockId','hcdStructureKey','hcdCanonicalKey'].map(name=>[name,{default:null,keepOnSplit:false,parseHTML:()=>null,renderHTML:()=>({})}]))},
 parseHTML(){return[]},
 renderHTML(){return['div',{'data-hcd-word-boundary':'true','aria-hidden':'true',contenteditable:'false',style:'display:none'}]},
})
export const wordRegionSchema=()=>getSchema([...schemaExtensions,SemanticStructureIdentity,WordRegionBoundary])
type Kind='body'|'header'|'footer'
type Catalog={regionId:string;kind:Kind;sourcePart:string}
type Fence=Catalog&{key:string}
export type WordRegionCapture={layoutHash:string;regions:Array<{regionId:string;blocks:SnapshotBlock[]}>;sources:SemanticSourceTarget[]}
export type WordRegionProjection=Projection&{flowLayout:WordLayout;flowLayoutHash:string}
const ordered=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
/** Yjs state vectors exclude deletions, so ancestry must check both clocks and
 * deleted intervals. This only proves causal inclusion, not authorization. */
export function wordContainsBaseline(document:Y.Doc,baseline:Y.Doc){
 const from=Y.snapshot(baseline),current=Y.snapshot(document)
 for(const [client,clock] of from.sv)if((current.sv.get(client)??0)<clock)return false
 for(const [client,ranges] of from.ds.clients){const available=current.ds.clients.get(client)??[];for(const range of ranges){let cursor=range.clock;for(const item of available){if(item.clock>cursor)break;if(item.clock+item.len>cursor)cursor=item.clock+item.len;if(cursor>=range.clock+range.len)break}if(cursor<range.clock+range.len)return false}}
 return true
}
/** Canonical IDs and section-end receipts may change on acknowledgement. They
 * are bound separately by the signed request/layout, never counted as input. */
export function wordCheckpointContents(captured:Pick<WordRegionCapture,'regions'>){return ordered({version:1,regions:captured.regions.map(region=>({regionId:region.regionId,contents:checkpointContents(region.blocks)}))})}
/** Narrow receipt equivalence for older prepared block atoms. Missing boolean
 * fallback flags mean false; signed request bytes/digests remain unchanged. */
export function wordReceiptContents(captured:Pick<WordRegionCapture,'regions'>){
 const normalize=(content:Block['content']):Block['content']=>({...content,...(content.kind==='extension'&&content.extension?.contentModel!=='blocks'?{inlines:content.inlines.map(inline=>({bold:false,italic:false,underline:false,strike:false,code:false,hardBreak:false,...inline}))}:{}),...(content.children?{children:content.children.map(normalize)}:{})})
 return wordCheckpointContents({regions:captured.regions.map(region=>({...region,blocks:region.blocks.map(block=>({...block,content:normalize(block.content)}))}))})
}
const stableLayout=(layout:WordLayout)=>ordered({...layout,sections:layout.sections.map(section=>{const value={...section} as Record<string,unknown>;delete value.canonicalEndBlockId;return value})})
// Only these fields may advance in a layout-only native revision. Preserve
// unknown page properties in the comparison so a future model cannot silently
// alter data that this reader does not understand.
const layoutFieldTopology=(layout:WordLayout)=>ordered({...layout,evenAndOddHeaders:undefined,sections:layout.sections.map(section=>{
 const page={...section.page} as Record<string,unknown>
 for(const key of ['widthTwips','heightTwips','orientation','numberStart','numberFormat'])delete page[key]
 const margins={...(section.page.marginsTwips??{})} as Record<string,unknown>
 for(const key of ['top','right','bottom','left','header','footer','gutter'])delete margins[key]
 if(Object.keys(margins).length)page.marginsTwips=margins;else delete page.marginsTwips
 return {...section,differentFirstPage:undefined,page}
})})
/** Native source receipts may rebind the canonical end block. A session can
 * retain its local text/history only across page fields, never story topology. */
export function sameWordSessionTopology(before:WordLayout,after:WordLayout){
 const topology=(layout:WordLayout)=>({...layout,sections:layout.sections.map(section=>{const value={...section};delete (value as Record<string,unknown>).canonicalEndBlockId;return value})})
 return layoutFieldTopology(topology(before))===layoutFieldTopology(topology(after))
}
function readProjection(projection:Projection):WordRegionProjection{
 const value=projection as WordRegionProjection
 readWordLayout({layout:value.flowLayout,layoutHash:value.flowLayoutHash,revision:value.revision},value.revision,2)
 if(typeof value.documentId!=='string'||!value.documentId||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.blocks))throw new Error('invalidWordProjection')
 return value
}
function catalog(layout:WordLayout):Catalog[]{return[...layout.sections.map(section=>({regionId:section.id,kind:'body' as const,sourcePart:'word/document.xml'})),...layout.stories.map(story=>({regionId:story.id,kind:story.kind,sourcePart:story.sourcePart}))]}
function partition(projection:WordRegionProjection):Map<string,Block[]>{
 const entries=catalog(projection.flowLayout),kinds=new Map(entries.map(region=>[region.regionId,region.kind])),groups=new Map(entries.map(region=>[region.regionId,[] as Block[]])),ids=new Set<string>()
 for(const block of projection.blocks){
  if(!block.flowRegionId){if(block.readOnly&&['footnote','endnote'].includes(block.region))continue;throw new Error('unscopedWordBlock')}
  if(!groups.has(block.flowRegionId)||kinds.get(block.flowRegionId)!==block.region||typeof block.blockId!=='string'||!block.blockId||ids.has(block.blockId))throw new Error('invalidWordBlockScope')
  ids.add(block.blockId);groups.get(block.flowRegionId)!.push(block)
 }
 if([...groups.values()].some(blocks=>!blocks.length))throw new Error('emptyWordRegion')
 return groups
}
/** A native link changes exactly one binding; content, notes and the region
 * catalog must remain byte-equivalent after normalized object-key ordering. */
export function verifyWordLinkReceipt(base:Projection,receipt:Projection,request:WordLinkTransaction):WordRegionProjection{
 const previous=readProjection(base),next=readProjection(receipt);partition(previous);partition(next)
 if(previous.documentId!==request.documentId||next.documentId!==previous.documentId||previous.revision!==request.expectedRevision||next.revision!==previous.revision+1||previous.flowLayoutHash!==request.link.baseLayoutHash||previous.flowLayoutHash===next.flowLayoutHash||!matchesWordStoryLinkTransition(previous.flowLayout,next.flowLayout,request)||ordered(previous.blocks)!==ordered(next.blocks)||ordered(previous.comments??[])!==ordered(next.comments??[])||ordered(previous.trackedChanges??[])!==ordered(next.trackedChanges??[]))throw Error('wordLinkReceiptChanged')
 return next
}
/** Compare a native receipt with the immutable base and separately reviewed
 * new blocks. This verifies data shape only; the caller must authenticate the
 * receipt and fence the live room before using it. */
export function verifyWordStoryReceipt(base:Projection,receipt:Projection,intent:WordStoryUnlinkIntent,expectedNewBlocks:readonly Block[]):WordRegionProjection{
 const previous=readProjection(base),next=readProjection(receipt)
 partition(previous);const groups=partition(next)
 if(previous.documentId!==next.documentId||next.revision!==previous.revision+1||previous.flowLayoutHash===next.flowLayoutHash||!matchesWordStoryUnlinkTransition(previous.flowLayout,next.flowLayout,intent))throw new Error('wordStoryReceiptChanged')
 if(ordered(previous.comments??[])!==ordered(next.comments??[])||ordered(previous.trackedChanges??[])!==ordered(next.trackedChanges??[])||next.blocks.length!==previous.blocks.length+expectedNewBlocks.length||!expectedNewBlocks.length)throw new Error('wordStoryReceiptChanged')
 if(previous.blocks.some((block,index)=>ordered(block)!==ordered(next.blocks[index])))throw new Error('wordStoryReceiptChanged')
 const story=next.flowLayout.stories[next.flowLayout.stories.length-1],added=next.blocks.slice(previous.blocks.length)
 // A native prepared block has deterministic HTML and block hash, but newly
 // allocated text node IDs appear only when that HTML is read back. Accept
 // those IDs solely where the reviewed candidate had none, and never allow a
 // new text node to reuse an existing root or text identity.
 const used=new Set(previous.blocks.map(block=>block.blockId))
 const collect=(value:any)=>{if(!value||typeof value!=='object')return;for(const inline of value.inlines??[]){if(inline.nodeId)used.add(inline.nodeId);collect(inline.content)}for(const child of value.children??[])collect(child)}
 for(const block of previous.blocks)collect(block.content)
 for(const block of added){if(used.has(block.blockId))throw new Error('wordStoryReceiptChanged');used.add(block.blockId)}
 const reviewed=structuredClone(expectedNewBlocks) as Block[]
 const bind=(expected:any,actual:any)=>{
  // The native renderer materializes an empty paragraph as one empty text
  // node. Only accept this exact unstyled placeholder; identity is checked below.
  if(expected?.kind==='paragraph'&&Array.isArray(expected.inlines)&&expected.inlines.length===0&&Array.isArray(actual?.inlines)&&actual.inlines.length===1){
   const item=actual.inlines[0],allowed=new Set(['text','nodeId','bold','italic','underline','strike','code','hardBreak'])
   if(item&&item.text===''&&typeof item.nodeId==='string'&&Object.keys(item).every(key=>allowed.has(key))&&['bold','italic','underline','strike','code','hardBreak'].every(key=>item[key]===undefined||item[key]===false))expected.inlines.push(structuredClone(item))
  }
  if(!expected||!actual||!Array.isArray(expected.inlines)||!Array.isArray(actual.inlines)||expected.inlines.length!==actual.inlines.length||!Array.isArray(expected.children??[])||!Array.isArray(actual.children??[])||(expected.children??[]).length!==(actual.children??[]).length)throw new Error('wordStoryReceiptChanged')
  expected.inlines.forEach((inline:any,index:number)=>{const live=actual.inlines[index];if(!live||typeof live!=='object')throw new Error('wordStoryReceiptChanged');if(live.nodeId!==undefined){if(typeof live.nodeId!=='string'||!/^n_[a-f0-9]{32}$/.test(live.nodeId)||used.has(live.nodeId))throw new Error('wordStoryReceiptChanged');used.add(live.nodeId);if(inline.nodeId===undefined)inline.nodeId=live.nodeId}if(inline.content||live.content)bind(inline.content,live.content)})
  ;(expected.children??[]).forEach((child:any,index:number)=>bind(child,actual.children[index]))
 }
 reviewed.forEach((block,index)=>{if(!added[index])throw new Error('wordStoryReceiptChanged');bind(block.content,added[index].content)})
 if(added.some(block=>block.flowRegionId!==story.id||block.region!==story.kind)||ordered(added)!==ordered(reviewed)||groups.get(story.id)?.length!==added.length)throw new Error('wordStoryReceiptChanged')
 const ids=new Set<string>();for(const block of next.blocks){if(ids.has(block.blockId))throw new Error('wordStoryReceiptChanged');ids.add(block.blockId)}
 return structuredClone(next)
}
/** One Y.Doc and the existing permanent block/text store. Fences pin regional
 * topology while scoped reconciliation keeps every other region unchanged.
 * This model is explicit; constructing it never migrates an existing room. */
export class WordRegionStore{
 readonly structure:SemanticBlockStore
 private layout:WordLayout
 private layoutHash:string
 private readonly regions:Catalog[]
 constructor(readonly document:Y.Doc,readonly schema:Schema,readonly documentId:string,layout:WordLayout,layoutHash:string,readonly origin:unknown=wordRegionEditOrigin){
  readWordLayout({layout,layoutHash,revision:0},0,2)
  if(!schema.nodes[wordBoundaryName]||!documentId)throw new Error('unsupportedWordRegionSchema')
  this.layout=structuredClone(layout);this.layoutHash=layoutHash;this.regions=catalog(this.layout)
  this.structure=new SemanticBlockStore(document,schema,origin)
 }
 get initialized(){const meta=this.document.getMap(wordRegionStoreField);if(!meta.size)return false;this.fences();return true}
 layoutState(){return{layout:structuredClone(this.layout),layoutHash:this.layoutHash}}
 /** A client receives source bindings through Yjs, but must verify the layout
  * hash against an immutable native receipt before advancing its local view. */
 syncLayout(layout:WordLayout,layoutHash:string){
  readWordLayout({layout,layoutHash,revision:0},0,2)
  if(stableLayout(layout)!==stableLayout(this.layout)||this.document.getMap(wordRegionStoreField).get('layoutHash')!==layoutHash)throw new Error('wordRegionLayoutChanged')
  this.layout=structuredClone(layout);this.layoutHash=layoutHash
 }
 /** Apply a layout-only receipt after the caller has authenticated and verified
  * its immutable native revision, digest, ownership and prior hash. This is an
  * internal building block, not authorization to accept a client Yjs update.
  * It does not acknowledge or rewrite any captured text or source bindings. */
 acceptLayoutFields(expectedHash:string,layout:WordLayout,layoutHash:string,request:WordLayoutPending['request']){
  readWordLayout({layout,layoutHash,revision:0},0,2)
  // Validate all current fences before changing anything, including an empty or
  // damaged room; merely matching a hash must not advance a foreign document.
  this.groups()
  if(expectedHash!==this.layoutHash||request.documentId!==this.documentId||request.edits.baseLayoutHash!==expectedHash||layoutHash===expectedHash||layoutFieldTopology(layout)!==layoutFieldTopology(this.layout)||ordered(layout)===ordered(this.layout)||!matchesWordLayoutTransition(this.layout,layout,request))throw new Error('wordRegionLayoutChanged')
  const next=structuredClone(layout)
  this.document.transact(transaction=>{
   transaction.meta.set('addToHistory',false)
   this.document.getMap(wordRegionStoreField).set('layoutHash',layoutHash)
   this.layout=next;this.layoutHash=layoutHash
  },receiptOrigin)
 }
 /** Staged-copy mutation after an independently verified native link. The
  * existing Yjs carriers, source IDs, images and private drafts stay intact. */
 acceptLinkFields(expectedHash:string,layout:WordLayout,layoutHash:string,request:WordLinkTransaction){
  readWordLayout({layout,layoutHash,revision:0},0,2);this.groups()
  if(expectedHash!==this.layoutHash||request.documentId!==this.documentId||request.link.baseLayoutHash!==expectedHash||layoutHash===expectedHash||!matchesWordStoryLinkTransition(this.layout,layout,request))throw Error('wordRegionLayoutChanged')
  const next=structuredClone(layout)
  this.document.transact(transaction=>{transaction.meta.set('addToHistory',false);this.document.getMap(wordRegionStoreField).set('layoutHash',layoutHash);this.layout=next;this.layoutHash=layoutHash},receiptOrigin)
 }
 /** Apply an already authenticated receipt to a staged copy of the room.
  * The caller must quiesce topology changes, verify ownership and persist the
  * native receipt before this method. Existing Yjs carriers are never replaced. */
 acceptStoryReceipt(base:Projection,receipt:Projection,intent:WordStoryUnlinkIntent,expectedNewBlocks:readonly Block[]){
  const next=verifyWordStoryReceipt(base,receipt,intent,expectedNewBlocks)
  if(this.layoutHash!==base.flowLayoutHash||ordered(this.layout)!==ordered(base.flowLayout))throw new Error('wordRegionLayoutChanged')
  const current=this.capture(),stateVector=Y.encodeStateVector(this.document),staged=new Y.Doc()
  try{
   Y.applyUpdate(staged,Y.encodeStateAsUpdate(this.document))
   const model=new WordRegionStore(staged,this.schema,this.documentId,this.layout,this.layoutHash,this.origin),story=next.flowLayout.stories[next.flowLayout.stories.length-1],region=catalog(next.flowLayout).at(-1)!
   const canonical=next.blocks.filter(block=>block.flowRegionId===story.id)
   const roots=this.schema.nodeFromJSON(projectionToJson({...next,blocks:canonical})).content.content
   const boundary=this.schema.nodes[wordBoundaryName].createChecked({regionId:story.id})
   staged.transact(transaction=>{
    transaction.meta.set('addToHistory',false)
    const keys=model.structure.insert([boundary,...roots],null),meta=staged.getMap(wordRegionStoreField),fences=model.fences()
    meta.set('regions',[...fences,{...region,key:keys[0]}]);meta.set('layoutHash',next.flowLayoutHash)
    model.regions.push(region);model.layout=structuredClone(next.flowLayout);model.layoutHash=next.flowLayoutHash
   },receiptOrigin)
   const after=model.capture()
   // The save digest intentionally omits source and block IDs; migration must
   // retain those identities as well as visible text and formatting.
   if(ordered(after.regions.slice(0,current.regions.length))!==ordered(current.regions)||after.regions.at(-1)?.regionId!==story.id)throw new Error('wordStoryMigrationChangedInput')
   const expectedSnapshot=jsonToSnapshot(this.schema.nodeFromJSON(projectionToJson({...next,blocks:canonical})).toJSON())
   if(ordered(after.regions.at(-1)!.blocks)!==ordered(expectedSnapshot))throw new Error('wordStoryMigrationChangedContent')
   const update=Y.encodeStateAsUpdate(staged,stateVector),oldLayout=this.layout,oldHash=this.layoutHash
   this.regions.push(region);this.layout=structuredClone(next.flowLayout);this.layoutHash=next.flowLayoutHash
   try{Y.applyUpdate(this.document,update,receiptOrigin)}catch(error){
    // Yjs observers can throw after a transaction has already committed. Keep
    // the matching local fence in that case rather than undoing only this
    // object's metadata while the shared document remains advanced.
    if(this.document.getMap(wordRegionStoreField).get('layoutHash')!==next.flowLayoutHash){this.regions.pop();this.layout=oldLayout;this.layoutHash=oldHash}
    throw error
   }
  }finally{staged.destroy()}
 }
 /** After receiving the corresponding Yjs update, adopt a separately verified
  * receipt without replacing shared state. If a later edit already arrived,
  * the caller must supply the coordinator-authenticated initial room update and
  * enforce the ordinary update authorization/guards for subsequent edits. */
 syncStoryReceipt(base:Projection,receipt:Projection,intent:WordStoryUnlinkIntent,expectedNewBlocks:readonly Block[],authenticatedInitialUpdate?:Uint8Array){
  const next=verifyWordStoryReceipt(base,receipt,intent,expectedNewBlocks)
  if(this.layoutHash!==base.flowLayoutHash||ordered(this.layout)!==ordered(base.flowLayout)||this.document.getMap(wordRegionStoreField).get('layoutHash')!==next.flowLayoutHash)throw new Error('wordRegionLayoutChanged')
  const candidate=new WordRegionStore(this.document,this.schema,this.documentId,next.flowLayout,next.flowLayoutHash,this.origin),capture=candidate.capture(),story=next.flowLayout.stories.at(-1)!
  const expected=jsonToSnapshot(this.schema.nodeFromJSON(projectionToJson({...next,blocks:next.blocks.filter(block=>block.flowRegionId===story.id)})).toJSON()),actual=capture.regions.at(-1)
  if(!actual||actual.regionId!==story.id)throw new Error('wordStoryMigrationChangedContent')
  if(authenticatedInitialUpdate){
   if(!(authenticatedInitialUpdate instanceof Uint8Array)||!authenticatedInitialUpdate.length||authenticatedInitialUpdate.length>32*1024*1024)throw new Error('wordStoryMigrationInvalidBaseline')
   const baseline=new Y.Doc()
   try{
    Y.applyUpdate(baseline,authenticatedInitialUpdate)
    const original=new WordRegionStore(baseline,this.schema,this.documentId,next.flowLayout,next.flowLayoutHash,this.origin),initial=original.capture().regions.at(-1)
    if(!initial||initial.regionId!==story.id||ordered(initial.blocks)!==ordered(expected)||ordered(baseline.getMap(wordRegionStoreField).get('regions'))!==ordered(this.document.getMap(wordRegionStoreField).get('regions')))throw new Error('wordStoryMigrationInvalidBaseline')
    if(!wordContainsBaseline(this.document,baseline))throw new Error('wordStoryMigrationMissingBaseline')
   }finally{baseline.destroy()}
  }else if(ordered(actual.blocks)!==ordered(expected))throw new Error('wordStoryMigrationChangedContent')
  this.regions.push(catalog(next.flowLayout).at(-1)!);this.layout=structuredClone(next.flowLayout);this.layoutHash=next.flowLayoutHash
 }
 private fences():Fence[]{
  const meta=this.document.getMap(wordRegionStoreField),fences=meta.get('regions') as Fence[]
  if(this.document.getMap('hcdSchema').get('typography')!==2||this.document.getMap('hcdSchema').get('sourceIdentity')!==1||meta.get('version')!==1||meta.get('documentId')!==this.documentId||meta.get('layoutHash')!==this.layoutHash||!Array.isArray(fences)||fences.length!==this.regions.length||new Set(fences.map(fence=>fence?.key)).size!==fences.length||!this.structure.initialized)throw new Error('invalidWordRegionMetadata')
  fences.forEach((fence,index)=>{if(!fence||typeof fence.key!=='string'||!fence.key||ordered({...fence,key:undefined})!==ordered({...this.regions[index],key:undefined}))throw new Error('invalidWordRegionMetadata')})
  return fences
 }
 private groups(){
  const fences=this.fences(),byKey=new Map(fences.map(fence=>[fence.key,fence])),groups=new Map(fences.map(fence=>[fence.regionId,[] as StableSemanticBlock[]]));let region: string|undefined,index=0
  for(const block of this.structure.blocks()){
   if(block.node.type.name===wordBoundaryName){const expected=fences[index++];if(!expected||byKey.get(block.key)!==expected||block.node.attrs.regionId!==expected.regionId)throw new Error('wordRegionBoundaryChanged');region=expected.regionId;continue}
   if(!region)throw new Error('unscopedWordBlock')
   block.node.descendants(node=>{if(node.type.name===wordBoundaryName)throw new Error('nestedWordRegionBoundary')})
   groups.get(region)!.push(block)
  }
  if(index!==fences.length||[...groups.values()].some(blocks=>!blocks.length))throw new Error('wordRegionBoundaryChanged')
  return groups
 }
 initialize(projection:Projection){
  const native=readProjection(projection)
  if(native.documentId!==this.documentId||native.flowLayoutHash!==this.layoutHash||ordered(native.flowLayout)!==ordered(this.layout))throw new Error('wordRegionLayoutChanged')
  if(this.document.getMap(wordRegionStoreField).size||this.structure.metadata.size)throw new Error('alreadyInitializedWordRegions')
  for(const [name,value]of this.document.share){if(name==='hcdSchema'){for(const [key,version]of this.document.getMap(name))if(!['typography','sourceIdentity'].includes(key)||version!==(key==='typography'?2:1))throw new Error('unsupportedWordRegionSchema')}else if(value instanceof Y.Map?value.size>0:value instanceof Y.Array||value instanceof Y.Text||value instanceof Y.XmlFragment?value.length>0:true)throw new Error('alreadyInitializedWordRegions')}
  const groups=partition(native),nodes:PmNode[]=[]
  for(const region of this.regions){nodes.push(this.schema.nodes[wordBoundaryName].createChecked({regionId:region.regionId}));const json=projectionToJson({...native,blocks:groups.get(region.regionId)!});nodes.push(...this.schema.nodeFromJSON(json).content.content)}
  const root=this.schema.topNodeType.createChecked(null,nodes)
  this.document.transact(()=>{
   const keys=this.structure.initialize(root),fences=this.regions.map(region=>({...region,key:keys[nodes.findIndex(node=>node.type.name===wordBoundaryName&&node.attrs.regionId===region.regionId)]}))
   const meta=this.document.getMap(wordRegionStoreField);meta.set('regions',fences);meta.set('documentId',this.documentId);meta.set('layoutHash',this.layoutHash);meta.set('version',1);this.document.getMap('hcdSchema').set('typography',2);this.document.getMap('hcdSchema').set('sourceIdentity',1)
  },receiptOrigin)
 }
 region(regionId:string):StableSemanticBlock[]{const blocks=this.groups().get(regionId);if(!blocks)throw new Error('unknownWordRegion');return blocks}
 project(regionId:string){return this.schema.topNodeType.createChecked(null,this.region(regionId).map(block=>block.node))}
 private planRegion(regionId:string,before:readonly StableSemanticBlock[],after:readonly ProposedSemanticBlock[]){
  const group=this.region(regionId)
  if(before.length!==group.length||before.some((block,index)=>block.key!==group[index].key||!block.node.eq(group[index].node)))throw new Error('staleWordRegion')
  const selected=new Set<string>(),all=this.structure.blocks();for(const block of group){selected.add(block.key);block.node.descendants(node=>{if(typeof node.attrs.hcdStructureKey==='string')selected.add(node.attrs.hcdStructureKey)})}
  const global=new Set<string>();for(const block of all){global.add(block.key);block.node.descendants(node=>{if(typeof node.attrs.hcdStructureKey==='string')global.add(node.attrs.hcdStructureKey)})}
  const ownBlocks=new Set<string>(),ownSources=new Set<string>()
  const collect=(node:PmNode)=>{if(typeof node.attrs.hcdBlockId==='string')ownBlocks.add(node.attrs.hcdBlockId);if(typeof node.attrs.hcdSourceId==='string')ownSources.add(node.attrs.hcdSourceId);for(const mark of node.marks)if(mark.type.name==='hcdSource'&&typeof mark.attrs.nodeId==='string')ownSources.add(mark.attrs.nodeId)}
  for(const block of group){collect(block.node);block.node.descendants(collect)}
  const retained=new Map(after.map(block=>[block.key??block.node.attrs.hcdStructureKey,block.node]))
  for(const block of group)if(block.node.type.name==='hcdOpaque'&&!retained.get(block.key)?.eq(block.node))throw new Error('readOnlyWordBlock')
  const validate=(node:PmNode)=>{const id=node.attrs.hcdBlockId,source=node.attrs.hcdSourceId;if(typeof id==='string'&&id.startsWith('n_')&&!ownBlocks.has(id))throw new Error('crossWordRegionSource');if(typeof source==='string'&&!ownSources.has(source))throw new Error('crossWordRegionSource');for(const mark of node.marks)if(mark.type.name==='hcdSource'&&typeof mark.attrs.nodeId==='string'&&!ownSources.has(mark.attrs.nodeId))throw new Error('crossWordRegionSource');if(node.type.name===wordBoundaryName)throw new Error('wordRegionBoundaryChanged');const key=node.attrs.hcdStructureKey;if(typeof key==='string'&&global.has(key)&&!selected.has(key))throw new Error('crossWordRegionMove')}
  for(const block of after){if(block.key&&global.has(block.key)&&!selected.has(block.key))throw new Error('crossWordRegionMove');validate(block.node);block.node.descendants(validate)}
  const replacement=after.length?[...after]:[{node:this.schema.nodes.paragraph.createChecked()}],start=all.findIndex(block=>block.key===group[0].key)
  return{all,next:[...all.slice(0,start),...replacement,...all.slice(start+group.length)]}
 }
 validateReconcile(regionId:string,before:readonly StableSemanticBlock[],after:readonly ProposedSemanticBlock[],options:SemanticReconcileOptions={}){const plan=this.planRegion(regionId,before,after);this.structure.validateReconcile(plan.all,plan.next,options)}
 reconcile(regionId:string,before:readonly StableSemanticBlock[],after:readonly ProposedSemanticBlock[],options:SemanticReconcileOptions={}){const plan=this.planRegion(regionId,before,after);this.structure.reconcile(plan.all,plan.next,options);return this.region(regionId)}
 /** The ordinary binding sees one region. Shared text and bookmarks retain the
  * same permanent carriers and peer updates in other regions remain untouched. */
 view(regionId:string):StructureBindingStore{
  this.region(regionId);const store=this
  return{document:this.document,contents:this.structure.contents,inline:this.structure.inline,flow:this.structure.flow,get initialized(){return store.document.getMap(wordRegionStoreField).get('layoutHash')===store.layoutHash&&store.initialized},project:()=>store.project(regionId),blocks:()=>store.region(regionId),validateReconcile:(before,after,options)=>store.validateReconcile(regionId,before,after,options),reconcile:(before,after,options)=>store.reconcile(regionId,before,after,options)}
 }
 capture():WordRegionCapture{
  const groups=this.groups(),fences=new Set(this.fences().map(fence=>fence.key)),regions=this.regions.map(region=>({regionId:region.regionId,blocks:structuredClone(jsonToSnapshot(this.schema.topNodeType.createChecked(null,groups.get(region.regionId)!.map(block=>block.node)).toJSON()))})),sources=structureSourceTargets(this.structure).filter(target=>!(target instanceof Y.XmlElement)&&!fences.has(target.key))
  if(sources.length!==regions.reduce((sum,region)=>sum+region.blocks.length,0))throw new Error('wordRegionSourceMismatch')
  return{layoutHash:this.layoutHash,regions,sources}
 }
 /** Called only with a coordinator-verified canonical response. It acknowledges
  * captured carriers; edits made while saving remain live in those carriers. */
 acceptSources(captured:WordRegionCapture,projection:Projection){
  const native=readProjection(projection)
  if(native.documentId!==this.documentId||captured.layoutHash!==this.layoutHash||stableLayout(native.flowLayout)!==stableLayout(this.layout))throw new Error('wordRegionLayoutChanged')
  const groups=partition(native),canonical=this.regions.flatMap(region=>groups.get(region.regionId)!)
  if(captured.regions.length!==this.regions.length||captured.regions.some((region,index)=>region.regionId!==this.regions[index].regionId||region.blocks.length!==groups.get(region.regionId)!.length))throw new Error('wordRegionSourceMismatch')
  // Prepare against one immutable projection, outside the mutation transaction.
  // Inside a transaction the structure cache is deliberately disabled; reading
  // each leaf there rebuilt the whole document once per source on long files.
  // No async gap separates this plan from its atomic source/layout commit.
  const apply=prepareStructureSources(this.structure,captured.sources,canonical)
  this.document.transact(transaction=>{
   transaction.meta.set('addToHistory',false);apply(receiptOrigin)
   captured.sources.forEach((target,index)=>{
    const content=canonical[index].content;if(target instanceof Y.XmlElement||content.kind!=='extension'||content.extension?.contentModel==='blocks')return
    const attrs=this.structure.attributes.get(target.key);if(!attrs)return
    const fallback={...(attrs.get('fallbackInline') as Record<string,unknown>??{})}
    for(const key of ['bold','italic','underline','strike','code','hardBreak'] as const)if(!Object.hasOwn(fallback,key))fallback[key]=content.inlines[0]?.[key]??false
    attrs.set('fallbackInline',fallback)
   })
   this.document.getMap(wordRegionStoreField).set('layoutHash',native.flowLayoutHash);this.layout=structuredClone(native.flowLayout);this.layoutHash=native.flowLayoutHash
  },receiptOrigin)
 }
 contents(){return wordCheckpointContents(this.capture())}
}
