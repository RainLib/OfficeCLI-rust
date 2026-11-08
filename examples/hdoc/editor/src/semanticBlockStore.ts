import {inlineContainerEditFields,publishInlineContainerEdits} from './inlineContainerEdits.ts'
import {SemanticInlineContainers,inlineContainerNodeName} from './semanticInlineContainers.ts'
import {referenceEditIndex,referenceEditField,prepareReferenceEdits,publishReferenceEdits,projectReferenceEdits,storageReferenceNode} from './referenceEdits.ts'
import {deletionReviewField,prepareDeletionBatch} from './deletionReview.ts'
import {inlineDeletionField,prepareInlineDeletions} from './inlineDeletionReview.ts'
import {extensionEditIndex,prepareExtensionEdits,publishExtensionEdits,projectExtensionEdits,nodeEditFields,storageExtensionNode} from './extensionEdits.ts'
import {extensionNodes} from './extensionNode.ts'
import * as Y from 'yjs'
import {Fragment,type Node as PmNode,type Schema} from '@tiptap/pm/model'
import {duplicateBlock} from './commands/blocks.ts'
import {validateSemanticInline,writeSemanticInline,type SemanticInlineEdit,type SemanticInlineSplice} from './semanticInlineContent.ts'
import {SemanticTextFlow} from './semanticTextFlow.ts'
import {protectStructuralUndo,type PrepareHistoryProjectionGuard} from './structuralUndoGuard.ts'

/** Permanent nodes and text; references describe their logical tree. This
 * opt-in prototype is not a writer for a legacy default-fragment room. */
export const semanticBlockFields={metadata:'hcd-semantic-blocks/3/meta',content:'hcd-semantic-blocks/3/content',order:'hcd-semantic-blocks/3/order',placement:'hcd-semantic-blocks/3/placement',visibility:'hcd-semantic-blocks/3/visibility',kinds:'hcd-semantic-blocks/3/kinds',attributes:'hcd-semantic-blocks/3/attributes',inline:'hcd-semantic-blocks/3/inline',children:'hcd-semantic-blocks/3/children',owners:'hcd-semantic-blocks/3/owners',canonical:'hcd-semantic-blocks/3/canonical'} as const
export const semanticBlockOrigin=Object.freeze({kind:'hcd-semantic-block-edit/3'})
const allocationOrigin=Object.freeze({kind:'hcd-semantic-block-allocation/3'})
type OrderReference={key:string;reference:string}
type Location={parent:string|null;reference:string;splitFrom?:string;beforeBoundary?:{key:string;reference:string}}
export type StableSemanticBlock={key:string;node:PmNode}
type ProjectedTree={roots:StableSemanticBlock[];nodes:Map<string,PmNode>}
// A document can have several stores (binding, coordinator, history). Reuse
// only immutable completed projections; never cache reads during a mutation.
const projectionCaches=new WeakMap<Y.Doc,{schemas:WeakMap<Schema,ProjectedTree>}>()
function projectionCache(document:Y.Doc){let cache=projectionCaches.get(document);if(!cache){cache={schemas:new WeakMap()};projectionCaches.set(document,cache);const entry=cache;document.on('beforeTransaction',()=>{entry.schemas=new WeakMap()})}return cache}
export type ProposedSemanticBlock={key?:string;node:PmNode}
export type SemanticTextSplice=SemanticInlineSplice&{key:string}
export type SemanticTextEdits={key:string;containerId?:string;edits:readonly SemanticInlineEdit[]}
export type SemanticReconcileOptions={textEdits?:readonly SemanticTextEdits[];textSplices?:readonly SemanticTextSplice[];addToHistory?:boolean;movedKeys?:readonly string[];deletedKeys?:readonly string[];textSplit?:boolean;textJoin?:boolean}
type Existing={node:PmNode;parent:string|null;children:string[]}
type Plan={key:string;node:PmNode;parent:string|null;children:Plan[];existing:boolean;owner:string|null}
function retainedOrder(before:readonly string[],after:readonly string[]){
 const indices=new Map(before.map((key,index)=>[key,index])),tails:number[]=[],previous:number[]=[],candidates=after.filter(key=>indices.has(key))
 candidates.forEach((key,index)=>{const position=indices.get(key)!;let low=0,high=tails.length;while(low<high){const middle=(low+high)>>1;if(indices.get(candidates[tails[middle]])!<position)low=middle+1;else high=middle}previous[index]=low?tails[low-1]:-1;tails[low]=index})
 const retained=new Set<string>();for(let index=tails.at(-1)??-1;index>=0;index=previous[index])retained.add(candidates[index]);return retained
}
export class SemanticStructureError extends Error{
 constructor(readonly code:'uninitialized'|'alreadyInitialized'|'invalidStructure'|'staleContent'|'missingBlock'|'invalidMove'|'ownershipTransition'){super(code);this.name='SemanticStructureError'}
}
export class SemanticBlockStore{
 readonly flow:SemanticTextFlow;readonly metadata:Y.Map<unknown>;readonly contents:Y.Map<Y.XmlFragment>;readonly order:Y.Array<OrderReference>;readonly placement:Y.Map<Location>;readonly visibility:Y.Map<boolean>;readonly kinds:Y.Map<string>;readonly attributes:Y.Map<Y.Map<unknown>>;readonly inline:Y.Map<boolean>;readonly children:Y.Map<Y.Array<OrderReference>>;readonly owners:Y.Map<string|null>;readonly canonicalIds:Y.Map<string|null>
 constructor(readonly document:Y.Doc,readonly schema:Schema,readonly origin:unknown=semanticBlockOrigin,readonly options:{inlineContainers?:true}={}){
  this.metadata=document.getMap(semanticBlockFields.metadata);this.contents=document.getMap(semanticBlockFields.content);this.order=document.getArray(semanticBlockFields.order);this.placement=document.getMap(semanticBlockFields.placement);this.visibility=document.getMap(semanticBlockFields.visibility);this.kinds=document.getMap(semanticBlockFields.kinds);this.attributes=document.getMap(semanticBlockFields.attributes);this.inline=document.getMap(semanticBlockFields.inline);this.children=document.getMap(semanticBlockFields.children);this.owners=document.getMap(semanticBlockFields.owners);this.canonicalIds=document.getMap(semanticBlockFields.canonical);this.flow=new SemanticTextFlow(document,this.contents,schema,origin,options.inlineContainers?new SemanticInlineContainers(document,schema,origin):undefined)
 }
 get initialized(){if(this.metadata.get('version')===3&&this.metadata.get('inlineContainers')!==(this.flow.containers?1:undefined))throw new Error('unsupportedInlineContainerModel');return this.metadata.get('version')===3&&this.flow.initialized}
 private requireInitialized(){if(!this.initialized)throw new SemanticStructureError('uninitialized')}
 private fresh(){return crypto.randomUUID()}
 private keyed(node:PmNode,key:string,owner:string|null=this.owners.get(key)??null){const attrs={...node.attrs,...('hcdStructureKey'in node.attrs?{hcdStructureKey:key}:{}),...('hcdCanonicalKey'in node.attrs?{hcdCanonicalKey:owner}:{})};if(!owner&&'hcdBlockId'in attrs)attrs.hcdBlockId=null;return node.type.createChecked(attrs,node.content,node.marks)}
 private storedCanonicalBlockId(key:string,owner=this.owners.get(key),derived=false){if(owner&&this.canonicalIds.has(owner)){const id=this.canonicalIds.get(owner);if(id!==null&&(typeof id!=='string'||!id.length||id.length>256))throw new SemanticStructureError('invalidStructure');return id??`tmp_${owner}`}return (derived||owner?.startsWith('branch_'))&&owner?`tmp_${owner}`:this.attributes.get(key)?.get('hcdBlockId')??(owner?`tmp_${owner}`:null)}
 canonicalBlockId(key:string){return this.projectedTree().nodes.get(key)?.attrs.hcdBlockId??this.storedCanonicalBlockId(key)}
 private checkNode(node:PmNode){if(node.type.schema!==this.schema||!node.isBlock||node.attrs.hcdBlockId==='')throw new SemanticStructureError('invalidStructure');node.check();if(node.isTextblock){if(this.flow.containers)this.flow.containers.validate([node]);else validateSemanticInline(node)}}
 private prepareInlineDocument(doc:PmNode){
  if(!this.flow.containers)return undefined
  const legacy=extensionNodes(doc),ids=new Set<string>(),roots:PmNode[]=[]
  doc.descendants(node=>{
   if(node.isTextblock)roots.push(node)
   if(node.type.name===inlineContainerNodeName){const id=node.attrs.extension.instanceId;if(ids.has(id)||legacy.has(id))throw new Error('duplicateInlineContainerIdentity');ids.add(id)}
  })
  const edits=extensionEditIndex(this.document),references=referenceEditIndex(this.document)
  return this.flow.containers.prepare(roots,value=>storageReferenceNode(storageExtensionNode(value,edits),references))
 }
 private sequence(parent:string|null){const sequence=parent===null?this.order:this.children.get(parent);if(!sequence)throw new SemanticStructureError('invalidStructure');return sequence}
 private active(parent:string|null){
  const seen=new Set<string>(),result:string[]=[]
  for(const entry of this.sequence(parent).toArray()){
   if(!entry||typeof entry.key!=='string'||typeof entry.reference!=='string')throw new SemanticStructureError('invalidStructure')
   const location=this.placement.get(entry.key)
   if(this.visibility.get(entry.key)!==true||location?.parent!==parent||location.reference!==entry.reference)continue
   if(seen.has(entry.key)||!this.contents.has(entry.key))throw new SemanticStructureError('invalidStructure');seen.add(entry.key);result.push(entry.key)
  }
  // Sort concurrent split siblings within their insertion gap. A separately
  // moved node is a barrier; moving the original prefix must not drag siblings.
  const family=(key:string)=>{let source=this.placement.get(key)?.splitFrom;if(!source)return null;const visited=new Set([key]);while(source&&!visited.has(source)){visited.add(source);const next:string|undefined=this.placement.get(source)?.splitFrom;if(!next)break;source=next}return source}
  const ordered:string[]=[]
  for(let index=0;index<result.length;){const source=family(result[index]);let end=index+1;if(source)while(end<result.length&&family(result[end])===source)end++;ordered.push(...(source?result.slice(index,end).sort((a,b)=>this.flow.compareBoundaries(a,b)):result.slice(index,end)));index=end}
  // A manual insertion before a split boundary refers to its LOGICAL place,
  // which can differ from the physical root-array order after concurrent cuts.
  const anchors=new Map<string,string>()
  for(const key of result){const before=this.placement.get(key)?.beforeBoundary;if(before&&before.key!==key&&result.includes(before.key)&&this.placement.get(before.key)?.reference===before.reference)anchors.set(key,before.key)}
  const done=new Set<string>()
  for(const key of anchors.keys()){let at:string|undefined=key;const path:string[]=[],indices=new Map<string,number>();while(at!==undefined&&!done.has(at)){const cycle=indices.get(at);if(cycle!==undefined){anchors.delete(path.slice(cycle).sort()[0]);break}indices.set(at,path.length);path.push(at);at=anchors.get(at)}path.forEach(key=>done.add(key))}
  const placed=new Set<string>(),place=(key:string)=>{if(placed.has(key))return;placed.add(key);const before=anchors.get(key);if(!before)return;place(before);ordered.splice(ordered.indexOf(key),1);ordered.splice(ordered.indexOf(before),0,key)}
  result.forEach(place);return ordered
 }
 private validateLocations(){
  const valid=new Set<string>(),references=new Map<string|null,Set<string>>();let work=0
  const exists=(key:string,location:Location)=>{let entries=references.get(location.parent);if(!entries){entries=new Set(this.sequence(location.parent).toArray().map(entry=>JSON.stringify([entry.key,entry.reference])));references.set(location.parent,entries)}return entries.has(JSON.stringify([key,location.reference]))}
  for(const [key,visible] of this.visibility){
   if(!visible)continue
   let current:string|null=key;const path=new Set<string>()
   while(current!==null&&!valid.has(current)){
    if(++work>1_000_000||path.has(current))throw new SemanticStructureError('invalidStructure')
    path.add(current);const location:Location|undefined=this.placement.get(current)
    if(!location||typeof location.reference!=='string'||location.parent!==null&&typeof location.parent!=='string'||!exists(current,location))throw new SemanticStructureError('invalidStructure')
    if(location.parent!==null){if(!this.contents.has(location.parent)||this.inline.get(location.parent))throw new SemanticStructureError('invalidStructure');if(this.visibility.get(location.parent)!==true)break}
    current=location.parent
   }
   path.forEach(key=>valid.add(key))
  }
 }
 childKeys(key:string){this.requireInitialized();return this.active(key)}
 /** Permanent children can contain empty losing wrappers or joined carriers
  * that read() prunes. Save slots and source mappings follow the projected
  * tree, while history/late edits must retain those permanent children. Pass
  * the already-read parent to avoid recursively projecting each subtree again. */
 projectedChildren(key:string,node:PmNode=this.content(key)):StableSemanticBlock[]{
  this.requireInitialized();if(node.isTextblock)return[]
  const active=new Set(this.active(key)),result:StableSemanticBlock[]=[]
  node.forEach(child=>{const childKey=child.attrs.hcdStructureKey;if(typeof childKey!=='string'||!active.has(childKey))throw new SemanticStructureError('invalidStructure');result.push({key:childKey,node:child})})
  return result
 }
 private read(key:string,path=new Set<string>()):PmNode|null{
  if(path.has(key)||path.size>128)throw new SemanticStructureError('invalidStructure')
  const kind=this.kinds.get(key),type=kind?this.schema.nodes[kind]:null,attrs=this.attributes.get(key),fragment=this.contents.get(key),inline=this.inline.get(key)
  if(!type||!(attrs instanceof Y.Map)||!(fragment instanceof Y.XmlFragment)||inline!==type.isTextblock||Object.keys(Object.fromEntries(attrs)).some(name=>!(name in(type.spec.attrs??{}))))throw new SemanticStructureError('invalidStructure')
  path.add(key)
  try{
   let content:Fragment
   if(inline){if(this.flow.rootFor(key)!==key)return null;content=this.flow.read(key)}
   else{
    // An empty paragraph can become a divider/container. A later offline edit
    // to its old carrier cannot silently disappear in that non-text projection.
    if(this.flow.segments.has(key)&&this.flow.rootFor(key)===key&&this.flow.read(key).size)throw new SemanticStructureError('ownershipTransition')
    const nodes=this.active(key).map(child=>this.read(child,path)).filter((node):node is PmNode=>node!==null)
    content=Fragment.fromArray(nodes)
    // A losing concurrent wrapper may have no remaining children. Prune only
    // empty wrappers, never a nonempty schema mismatch or a cyclic subtree.
    if(!nodes.length&&!type.validContent(content))return null
   }
   const values=Object.fromEntries(attrs),owner=this.owners.get(key)??null;if('hcdStructureKey'in(type.spec.attrs??{}))values.hcdStructureKey=key;if('hcdCanonicalKey'in(type.spec.attrs??{}))values.hcdCanonicalKey=owner;if(owner)values.hcdBlockId=this.storedCanonicalBlockId(key);const node=type.createChecked(values,content);node.check();return node
  }finally{path.delete(key)}
 }
 content(key:string){this.requireInitialized();const node=this.projectedTree().nodes.get(key)??this.read(key);if(!node)throw new SemanticStructureError('missingBlock');return projectReferenceEdits(projectExtensionEdits(node,extensionEditIndex(this.document)),referenceEditIndex(this.document))}
 private projectedTree():ProjectedTree{
  this.requireInitialized();const cache=projectionCache(this.document),cached=this.document._transaction?undefined:cache.schemas.get(this.schema);if(cached)return cached
  this.validateLocations()
  const result=this.active(null).map(key=>({key,node:this.read(key)})).filter((block):block is StableSemanticBlock=>block.node!==null)
  if(!result.length){const key=this.metadata.get('emptyRoot'),node=typeof key==='string'?this.read(key):null;if(typeof key!=='string'||!node)throw new SemanticStructureError('invalidStructure');result.push({key,node})}
  const slots=result.flatMap(block=>['bulletList','orderedList'].includes(block.node.type.name)?this.projectedChildren(block.key,block.node):[block]),groups=new Map<string,StableSemanticBlock[]>(),occupied=new Set<string>(),slotForNode=new Map<string,string>(),resolved=new Map<string,string>()
  for(const slot of slots){const raw=this.owners.get(slot.key),owner=raw===null?slot.key:raw;if(typeof owner!=='string')throw new SemanticStructureError('invalidStructure');if(raw===null)resolved.set(slot.key,owner);occupied.add(owner);const group=groups.get(owner)??[];group.push(slot);groups.set(owner,group);const visit=(node:PmNode)=>{const key=node.attrs.hcdStructureKey;if(typeof key==='string')slotForNode.set(key,slot.key);node.forEach(child=>{if(child.isBlock)visit(child)})};visit(slot.node)}
  for(const [owner,group]of groups){
   if(group.length<2)continue
   // Borrowed owners identify a permanent original carrier. Concurrent
   // wrappers may both borrow it, but only the slot containing that carrier
   // keeps the original canonical identity. Other additions stay visible.
   let anchor=this.contents.has(owner)?owner:null
   if(!anchor){const match=/^(?:branch|restore)_(.+?)(?:_\d+)?$/.exec(owner);if(match&&this.contents.has(match[1]))anchor=match[1]}
   if(!anchor)throw new SemanticStructureError('invalidStructure')
   const carrier=this.flow.segments.has(anchor)?this.flow.rootFor(anchor):anchor,primary=slotForNode.get(carrier)
   for(const slot of [...group].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)){
    if(slot.key===primary)continue
    let branch=`branch_${slot.key}`,index=0;while(occupied.has(branch))branch=`branch_${slot.key}_${++index}`
    if(branch.length>128)throw new SemanticStructureError('invalidStructure');occupied.add(branch);resolved.set(slot.key,branch)
   }
  }
  const nodes=new Map<string,PmNode>(),rewrite=(key:string,node:PmNode):PmNode=>{
   const children=node.isTextblock?[]:this.projectedChildren(key,node).map(child=>rewrite(child.key,child.node));let next=children.some((child,index)=>child!==node.child(index))?node.copy(Fragment.fromArray(children)):node
   const owner=resolved.get(key);if(owner)next=next.type.createChecked({...next.attrs,hcdCanonicalKey:owner,hcdBlockId:this.storedCanonicalBlockId(key,owner,true)},next.content,next.marks)
   nodes.set(key,next);return next
  }
  const tree={roots:result.map(block=>({key:block.key,node:rewrite(block.key,block.node)})),nodes};if(!this.document._transaction)cache.schemas.set(this.schema,tree);return tree
 }
 blocks():StableSemanticBlock[]{
  const index=extensionEditIndex(this.document),references=referenceEditIndex(this.document);return this.projectedTree().roots.map(block=>({...block,node:projectReferenceEdits(projectExtensionEdits(block.node,index),references)}))
 }
 keys(){return this.blocks().map(block=>block.key)}
 project(){return this.schema.topNodeType.createChecked(null,this.blocks().map(block=>block.node))}
 private snapshotNodes(roots:readonly StableSemanticBlock[]){
  const result=new Map<string,Existing>()
  const walk=(key:string,node:PmNode,parent:string|null)=>{
   if(result.has(key))throw new SemanticStructureError('invalidStructure')
   const children:string[]=[];result.set(key,{node,parent,children})
   if(!node.isTextblock)node.forEach(child=>{const nested=child.attrs.hcdStructureKey;if(typeof nested!=='string')throw new SemanticStructureError('invalidStructure');children.push(nested);walk(nested,child,key)})
  }
  roots.forEach(block=>walk(block.key,block.node,null));return result
 }
 private plan(before:readonly StableSemanticBlock[],after:readonly ProposedSemanticBlock[],options:SemanticReconcileOptions,allocate:boolean){
  const current=this.blocks()
  if(current.length!==before.length||current.some((block,index)=>block.key!==before[index].key||!block.node.eq(before[index].node)))throw new SemanticStructureError('staleContent')
  const old=this.snapshotNodes(before),seen=new Set<string>();let temporary=0
  const knownOwners=new Set([...old.values()].map(entry=>entry.node.attrs.hcdCanonicalKey).filter((owner):owner is string=>typeof owner==='string')),usedOwners=new Set<string>()
  const proposedDocument=this.schema.topNodeType.createChecked(null,after.map(block=>block.node));proposedDocument.check();extensionNodes(proposedDocument);this.prepareInlineDocument(proposedDocument)
  const walk=(node:PmNode,parent:string|null,forced?:string,canonicalOwner=false,root=false):Plan=>{
   this.checkNode(node)
   const proposed=forced??node.attrs.hcdStructureKey,key=typeof proposed==='string'&&old.has(proposed)&&!seen.has(proposed)?proposed:allocate?this.fresh():`new:${++temporary}`,previous=old.get(key)
   if(forced&&(!previous||seen.has(key)))throw new SemanticStructureError('invalidStructure')
   seen.add(key)
   if(previous&&previous.node.isTextblock!==node.isTextblock){
    if(previous.node.textContent||node.textContent)throw new SemanticStructureError('ownershipTransition')
   }
   const children:Plan[]=[]
   if(!node.isTextblock)node.forEach(child=>children.push(walk(child,key,undefined,root&&['bulletList','orderedList'].includes(node.type.name))))
   let owner:string|null=null
   if(canonicalOwner){
    const candidates:string[]=[];if(typeof node.attrs.hcdCanonicalKey==='string')candidates.push(node.attrs.hcdCanonicalKey)
    node.descendants(child=>{if(typeof child.attrs.hcdCanonicalKey==='string')candidates.push(child.attrs.hcdCanonicalKey)})
    const retained=previous?.node.attrs.hcdCanonicalKey;if(typeof retained==='string')candidates.unshift(retained)
    owner=candidates.find(candidate=>knownOwners.has(candidate)&&!usedOwners.has(candidate))??key;usedOwners.add(owner)
   }
   return{key,node:this.keyed(node,key,owner),parent,children,existing:!!previous,owner}
  }
  const plans=after.map(block=>walk(block.node,null,block.key,!['bulletList','orderedList'].includes(block.node.type.name),true))
  const allPlans:Plan[]=[];const collect=(plan:Plan)=>{allPlans.push(plan);plan.children.forEach(collect)};plans.forEach(collect)
  const oldTexts=[...old].filter(([,entry])=>entry.node.isTextblock),oldTextIndex=new Map(oldTexts.map(([key],index)=>[key,index])),nextTexts=allPlans.filter(plan=>plan.node.isTextblock)
  const retainedTexts=new Set(nextTexts.filter(plan=>old.has(plan.key)).map(plan=>plan.key)),merged=new Set<string>(),splitKeys=new Set<string>()
  const explicitDelete=(key:string)=>{let ancestor:string|null=key;while(ancestor!==null){if(options.deletedKeys?.includes(ancestor))return true;ancestor=old.get(ancestor)?.parent??null}return false}
  const flows:Array<{target:Plan;sources:string[];nodes:Plan[]}>=[]
  for(let index=0;index<nextTexts.length;index++){
   const target=nextTexts[index],previous=old.get(target.key)
   if(!previous?.node.isTextblock)continue
   const removed:string[]=[],following:Plan[]=[]
   const at=oldTextIndex.get(target.key)!
   for(let i=at+1;i<oldTexts.length&&!retainedTexts.has(oldTexts[i][0]);i++)if(!explicitDelete(oldTexts[i][0]))removed.push(oldTexts[i][0])
   if(options.textSplit)for(let i=index+1;i<nextTexts.length&&!old.has(nextTexts[i].key);i++)following.push(nextTexts[i])
   const changed=options.textJoin||previous.node.textBetween(0,previous.node.content.size,'\n','\n')!==target.node.textBetween(0,target.node.content.size,'\n','\n')
   if((changed||following.length)&&removed.length)removed.forEach(key=>merged.add(key))
   const sources=(changed||following.length)?removed:[]
   if(following.length)following.forEach(plan=>splitKeys.add(plan.key))
   if(sources.length||following.length)flows.push({target,sources,nodes:[target,...following]})
  }
  // Retained carriers must never be copied across a conversion. Unaccounted
  // removed text requires an explicit delete or a supported flow join.
  if(nextTexts.some(plan=>old.has(plan.key)&&!old.get(plan.key)!.node.content.eq(plan.node.content)))for(const [key,entry] of oldTexts)if(!seen.has(key)&&entry.node.content.size&&!merged.has(key)&&!explicitDelete(key))throw new SemanticStructureError('ownershipTransition')
  if(options.movedKeys){
   const moved=new Set(options.movedKeys),rest=before.filter(block=>!moved.has(block.key)).map(block=>block.key),next=plans.filter(block=>!moved.has(block.key)).map(block=>block.key)
   if(!moved.size||moved.size!==options.movedKeys.length||options.movedKeys.some(key=>!old.has(key)||!seen.has(key))||plans.length!==before.length||rest.length!==next.length||rest.some((key,index)=>key!==next[index]))throw new SemanticStructureError('invalidMove')
  }
  const splices=new Map<string,SemanticTextSplice>()
  for(const splice of options.textSplices??[]){
   const plan=nextTexts.find(plan=>plan.key===splice.key)
   if(typeof splice.key!=='string'||splices.has(splice.key)||!old.get(splice.key)?.node.isTextblock||!plan||flows.some(group=>group.nodes.some(node=>node.key===splice.key)||group.sources.includes(splice.key)))throw new Error('invalidSemanticTextSplice')
   this.flow.validateSplice(splice.key,plan.node,splice);splices.set(splice.key,splice)
  }
  const textEdits=new Map<string,SemanticTextEdits[]>()
  for(const batch of options.textEdits??[]){
   const plan=nextTexts.find(plan=>plan.key===batch.key)
   const group=textEdits.get(batch.key)??[]
   if(typeof batch.key!=='string'||splices.has(batch.key)||group.some(entry=>entry.containerId===batch.containerId)||!old.get(batch.key)?.node.isTextblock||!plan||batch.containerId!==undefined&&(!this.flow.containers||typeof batch.containerId!=='string')||flows.some(group=>group.nodes.some(node=>node.key===batch.key)||group.sources.includes(batch.key)))throw new Error('invalidSemanticTextEdits')
   group.push(batch);textEdits.set(batch.key,group)
  }
  for(const [key,group]of textEdits)this.flow.validateEdits(key,nextTexts.find(plan=>plan.key===key)!.node,group.find(batch=>batch.containerId===undefined)?.edits??[],group.filter((batch):batch is SemanticTextEdits&{containerId:string}=>batch.containerId!==undefined))
  return{plans,old,seen,flows,merged,splitKeys,splices,textEdits}
 }
 private allocate(plans:readonly Plan[],splitKeys:ReadonlySet<string>=new Set()){
  const nodes=extensionEditIndex(this.document),references=referenceEditIndex(this.document)
  this.document.transact(()=>{
   const visit=(plan:Plan)=>{
    // Once an edit persists a derived owner, older readers must also see an
    // explicit provisional binding rather than inherit the wrapper's old ID.
    if(plan.owner?.startsWith('branch_')&&!this.canonicalIds.has(plan.owner))this.canonicalIds.set(plan.owner,null)
    if(!plan.existing){
     const fragment=new Y.XmlFragment(),attrs=new Y.Map<unknown>();this.contents.set(plan.key,fragment);fragment.insert(0,[new Y.XmlText()]);this.attributes.set(plan.key,attrs);this.children.set(plan.key,new Y.Array<OrderReference>())
     this.kinds.set(plan.key,plan.node.type.name);this.inline.set(plan.key,plan.node.isTextblock);this.owners.set(plan.key,plan.owner);Object.entries(plan.node.attrs).forEach(([name,value])=>attrs.set(name,value))
     if(plan.owner&&!this.canonicalIds.has(plan.owner)&&typeof plan.node.attrs.hcdBlockId==='string')this.canonicalIds.set(plan.owner,plan.node.attrs.hcdBlockId)
     if(plan.node.isTextblock&&!splitKeys.has(plan.key)){const text=fragment.get(0) as Y.XmlText,storage=(value:Record<string,unknown>)=>storageReferenceNode(storageExtensionNode(value,nodes),references);if(this.flow.containers)this.flow.containers.writeReferences(text,plan.node,storage);else writeSemanticInline(text,plan.node,storage);if(this.flow.initialized)this.flow.register(plan.key)}
    }
    plan.children.forEach(visit)
   };plans.forEach(visit)
  },allocationOrigin)
 }
 private position(key:string,parent:string|null,before:string|null,splitFrom?:string){
  const sequence=this.sequence(parent),at=before===null?sequence.length:sequence.toArray().findIndex(entry=>entry.key===before&&this.placement.get(before)?.reference===entry.reference&&this.placement.get(before)?.parent===parent)
  if(at<0)throw new SemanticStructureError('invalidMove')
  const reference=this.fresh();sequence.insert(at,[{key,reference}]);this.placement.set(key,{parent,reference,...(splitFrom?{splitFrom}:before&&this.flow.segments.get(before)?.boundary?{beforeBoundary:{key:before,reference:this.placement.get(before)!.reference}}:{})})
 }
 private placeSequence(parent:string|null,previous:readonly string[],next:readonly string[],moved?:readonly string[],splits?:ReadonlyMap<string,string>){
  const retained=moved?new Set(previous.filter(key=>!moved.includes(key))):retainedOrder(previous,next)
  // A reference anchored before a logical split boundary stays in its old gap
  // when that boundary moves. Reposition its dependents before invalidating the
  // target reference; otherwise their physical Y.Array order leaks into view.
  const displaced=new Set(next.filter(key=>!retained.has(key)||this.placement.get(key)?.parent!==parent))
  let changed=true
  while(changed){changed=false;for(const key of next){const anchor=this.placement.get(key)?.beforeBoundary;if(anchor&&displaced.has(anchor.key)&&this.placement.get(anchor.key)?.reference===anchor.reference&&!displaced.has(key)){displaced.add(key);retained.delete(key);changed=true}}}
  let before:string|null=null
  for(let index=next.length-1;index>=0;index--){const key=next[index];if(!retained.has(key)||this.placement.get(key)?.parent!==parent)this.position(key,parent,before,splits?.get(key));before=key}
 }
 initialize(doc:PmNode){
  if(this.document.getMap('hcd-semantic-blocks/1/meta').get('version')!==undefined||this.document.getMap('hcd-semantic-blocks/2/meta').get('version')!==undefined||this.flow.metadata.size||this.document.getXmlFragment('default').length)throw new SemanticStructureError('alreadyInitialized')
  if(this.metadata.size||this.contents.size||this.order.length||this.placement.size||this.visibility.size||this.kinds.size||this.attributes.size||this.inline.size||this.children.size||this.owners.size||this.canonicalIds.size)throw new SemanticStructureError('alreadyInitialized')
  if(doc.type!==this.schema.topNodeType)throw new SemanticStructureError('invalidStructure');doc.check();extensionNodes(doc);const inlinePreparation=this.prepareInlineDocument(doc)
  const build=(node:PmNode,parent:string|null,canonicalOwner=false,root=false):Plan=>{this.checkNode(node);const key=this.fresh(),children:Plan[]=[];if(!node.isTextblock)node.forEach(child=>children.push(build(child,key,root&&['bulletList','orderedList'].includes(node.type.name))));const owner=canonicalOwner?key:null;return{key,node:this.keyed(node,key,owner),parent,children,existing:false,owner}}
  const roots:Plan[]=[];doc.forEach(node=>roots.push(build(node,null,!['bulletList','orderedList'].includes(node.type.name),true)))
  const empty=build(this.schema.nodes.paragraph.createChecked(),null,true)
  inlinePreparation?.allocate()
  this.document.transact(()=>{
   this.allocate([...roots,empty])
   const place=(node:Plan)=>{this.placeSequence(node.key,[],node.children.map(child=>child.key));this.visibility.set(node.key,true);node.children.forEach(place)}
   this.placeSequence(null,[],[empty.key,...roots.map(root=>root.key)]);roots.forEach(place);this.visibility.set(empty.key,false)
   const textKeys:string[]=[];const collect=(plan:Plan)=>{if(plan.node.isTextblock)textKeys.push(plan.key);plan.children.forEach(collect)};[...roots,empty].forEach(collect);this.flow.initialize(textKeys)
   if(this.flow.containers){const seed=(plan:Plan)=>{if(plan.node.isTextblock)this.flow.write(plan.key,plan.node);plan.children.forEach(seed)};roots.forEach(seed);this.metadata.set('inlineContainers',1)}
   this.metadata.set('emptyRoot',empty.key);this.metadata.set('version',3)
  },allocationOrigin)
  return roots.map(root=>root.key)
 }
 validateReconcile(before:readonly StableSemanticBlock[],after:readonly ProposedSemanticBlock[],options:SemanticReconcileOptions={}){const plan=this.plan(before,after,options,false);prepareDeletionBatch(this,[...plan.old].filter(([key,previous])=>!plan.seen.has(key)&&!plan.merged.has(key)&&(previous.parent===null||plan.seen.has(previous.parent))).map(([key,previous])=>({key,node:previous.node})));const old=this.schema.topNodeType.createChecked(null,before.map(b=>b.node)),next=this.schema.topNodeType.createChecked(null,after.map(b=>b.node));prepareInlineDeletions(this,next,key=>plan.seen.has(key)||plan.merged.has(key));prepareExtensionEdits(this.document,old,next);prepareReferenceEdits(this.document,old,next)}
 reconcile(before:readonly StableSemanticBlock[],after:readonly ProposedSemanticBlock[],options:SemanticReconcileOptions={}){
  const {plans,old,seen,flows,merged,splitKeys,splices,textEdits}=this.plan(before,after,options,true),oldDoc=this.schema.topNodeType.createChecked(null,before.map(b=>b.node)),nextDoc=this.schema.topNodeType.createChecked(null,after.map(b=>b.node)),records=prepareExtensionEdits(this.document,oldDoc,nextDoc),references=prepareReferenceEdits(this.document,oldDoc,nextDoc)
  const deletions=prepareDeletionBatch(this,[...old].filter(([key,previous])=>!seen.has(key)&&!merged.has(key)&&(previous.parent===null||seen.has(previous.parent))).map(([key,previous])=>({key,node:previous.node}))),inlineDeletions=prepareInlineDeletions(this,nextDoc,key=>seen.has(key)||merged.has(key));const inlinePreparation=this.prepareInlineDocument(nextDoc);inlinePreparation?.allocate();this.allocate(plans,splitKeys)
  this.document.transact(transaction=>{
   transaction.meta.set('addToHistory',options.addToHistory!==false)
   for(const record of inlineDeletions)this.document.getMap(inlineDeletionField).set(record.key,record.receipt)
   if(inlinePreparation)publishInlineContainerEdits(this.document,inlinePreparation.records)
   publishExtensionEdits(this.document,records);publishReferenceEdits(this.document,references)
   const flowWritten=new Set<string>(),splitSources=new Map<string,string>()
   for(const group of flows){
    group.sources.forEach(key=>this.flow.join(group.target.key,key))
    const content=group.nodes.reduce((content,plan)=>content.append(plan.node.content),Fragment.empty)
    this.flow.write(group.target.key,group.target.node.copy(content));flowWritten.add(group.target.key)
    let current=group.target
    for(const node of group.nodes.slice(1)){this.flow.split(current.key,current.node.content.size,node.key);splitSources.set(node.key,group.target.key);flowWritten.add(node.key);current=node}
   }
   const update=(plan:Plan)=>{
    const previous=old.get(plan.key)?.node
    if(previous){
     if(this.owners.get(plan.key)!==plan.owner)this.owners.set(plan.key,plan.owner)
     if(previous.type!==plan.node.type)this.kinds.set(plan.key,plan.node.type.name)
     if(previous.isTextblock!==plan.node.isTextblock)this.inline.set(plan.key,plan.node.isTextblock)
     if(plan.node.isTextblock&&!this.flow.segments.has(plan.key))this.flow.register(plan.key)
     const attrs=this.attributes.get(plan.key)!
     for(const name of new Set([...Object.keys(previous.attrs),...Object.keys(plan.node.attrs)]))if(!(name==='extension'&&['hcdExtensionBlock','hcdExtensionContainer'].includes(previous.type.name))&&JSON.stringify(previous.attrs[name])!==JSON.stringify(plan.node.attrs[name])){if(name in plan.node.attrs)attrs.set(name,plan.node.attrs[name]);else attrs.delete(name)}
    }
    if(plan.node.isTextblock&&!flowWritten.has(plan.key)&&(previous||this.flow.containers)){const group=textEdits.get(plan.key);if(group)this.flow.writeEdits(plan.key,plan.node,group.find(batch=>batch.containerId===undefined)?.edits??[],group.filter((batch):batch is SemanticTextEdits&{containerId:string}=>batch.containerId!==undefined));else if(!previous||!previous.content.eq(plan.node.content))this.flow.write(plan.key,plan.node,splices.get(plan.key))}
    if(this.visibility.get(plan.key)!==true)this.visibility.set(plan.key,true)
    this.placeSequence(plan.key,old.get(plan.key)?.children??[],plan.children.map(child=>child.key),undefined,splitSources);plan.children.forEach(update)
   }
   this.placeSequence(null,before.map(block=>block.key),plans.map(plan=>plan.key),options.movedKeys,splitSources);plans.forEach(update)
   for(const {key,receipt}of deletions){this.document.getMap(deletionReviewField).set(key,receipt);this.visibility.set(key,false)}
  },this.origin)
  return this.blocks()
 }
 update(key:string,expected:PmNode,next:PmNode,addToHistory=true){
  const before=this.blocks(),nodes=this.snapshotNodes(before),previous=nodes.get(key)
  if(!previous)throw new SemanticStructureError('missingBlock');if(!previous.node.eq(expected))throw new SemanticStructureError('staleContent')
  next=this.keyed(next,key,previous.node.attrs.hcdCanonicalKey??null);if(expected.eq(next))return false
  const replace=(node:PmNode):PmNode=>node.attrs.hcdStructureKey===key?next:node.isTextblock?node:node.copy(Fragment.fromArray(node.content.content.map(replace)))
  // Schemas without the opt-in key still support the original root-only API.
  const proposed=before.map(block=>({key:block.key,node:block.key===key?next:replace(block.node)}));this.reconcile(before,proposed,{addToHistory});return true
 }
 move(keys:readonly string[],before:string|null){
  const current=this.keys(),selected=new Set(keys)
  if(!keys.length||selected.size!==keys.length||keys.some(key=>!current.includes(key)))throw new SemanticStructureError('missingBlock')
  if(before!==null&&(!current.includes(before)||selected.has(before)))throw new SemanticStructureError('invalidMove')
  const ordered=current.filter(key=>selected.has(key)),rest=current.filter(key=>!selected.has(key)),index=before===null?rest.length:rest.indexOf(before),next=[...rest.slice(0,index),...ordered,...rest.slice(index)]
  if(current.every((key,index)=>next[index]===key))return false
  this.document.transact(()=>this.placeSequence(null,current,next,ordered),this.origin);return true
 }
 insert(nodes:readonly PmNode[],before:string|null){
  const current=this.blocks(),index=before===null?current.length:current.findIndex(block=>block.key===before)
  if(!nodes.length||index<0)throw new SemanticStructureError('invalidMove')
  const result=this.reconcile(current,[...current.slice(0,index),...nodes.map(node=>({node})),...current.slice(index)]);return result.slice(index,index+nodes.length).map(block=>block.key)
 }
 duplicate(keys:readonly string[],before:string|null){const blocks=this.blocks(),selected=new Set(keys);if(!keys.length||selected.size!==keys.length||keys.some(key=>!blocks.some(block=>block.key===key)))throw new SemanticStructureError('missingBlock');return this.insert(blocks.filter(block=>selected.has(block.key)).map(block=>duplicateBlock(block.node)),before)}
 remove(keys:readonly string[]){const current=this.keys();if(!keys.length||new Set(keys).size!==keys.length||keys.some(key=>!current.includes(key)))throw new SemanticStructureError('missingBlock');const receipts=prepareDeletionBatch(this,keys.map(key=>({key,node:this.content(key)})));this.document.transact(()=>receipts.forEach(({key,receipt})=>{this.document.getMap(deletionReviewField).set(key,receipt);this.visibility.set(key,false)}),this.origin)}
 undoManager(guarded=true,prepareProjectionGuard?:PrepareHistoryProjectionGuard):Y.UndoManager{const manager=new Y.UndoManager([this.document.getMap(deletionReviewField),this.document.getMap(inlineDeletionField),this.document.getMap(referenceEditField),this.document.getMap(nodeEditFields.intents),this.contents,this.order,this.placement,this.visibility,this.kinds,this.attributes,this.children,this.inline,this.owners,this.flow.links,this.flow.order,...(this.flow.containers?[this.flow.containers.bodies,this.document.getMap(inlineContainerEditFields.intents)]:[])],{trackedOrigins:new Set([this.origin]),captureTransaction:transaction=>transaction.meta.get('addToHistory')!==false});return guarded?protectStructuralUndo(manager,this,document=>new SemanticBlockStore(document,this.schema,this.origin,this.options),prepareProjectionGuard):manager}
}
