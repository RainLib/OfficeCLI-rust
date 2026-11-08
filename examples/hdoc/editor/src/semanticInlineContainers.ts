import {inlineContainerEditIndex,prepareInlineContainerEdits,publishInlineContainerEdits} from './inlineContainerEdits.ts'
import {semanticSourceDefaults,sourceDefaultNames,emptySourceDefaults} from './semanticSourceDefaults.ts'
import * as Y from 'yjs'
import {Fragment,type Node as PmNode,type Schema} from '@tiptap/pm/model'
import {readExtensionNode} from './extensionNode.ts'
import {readInlineContainerPayload,inlineContainerNodeName,type InlineContainerPayload} from './inlineContainerPayload.ts'
export {readInlineContainerPayload,inlineContainerNodeName,type InlineContainerPayload} from './inlineContainerPayload.ts'
import {readSemanticInline,validateSemanticInline,validateSemanticNodeJson,writeSemanticInline,validateSemanticEdits,writeSemanticEdits,type SemanticInlineText,type SemanticInlineEdit} from './semanticInlineContent.ts'

/** Internal model only. Active rooms/SDK still reject envelope 3 until their
 * guard, property intents, deletion review and checkpoint binding are ready. */
export const inlineContainerFields={definitions:'hcd-inline-containers/1/definitions',bodies:'hcd-inline-containers/1/bodies'} as const
export const inlineContainerOrigin=Object.freeze({kind:'hcd-inline-container-edit/1'})
const allocationOrigin=Object.freeze({kind:'hcd-inline-container-allocation/1'})
type Payload=InlineContainerPayload
type Definition={version:1;node:{type:typeof inlineContainerNodeName;attrs:Record<string,unknown>&{extension:Payload}}}
type Relative=ReturnType<typeof Y.relativePositionToJSON>
export type InlineContainerPoint={containerId:string|null;relative:Relative}
type Entry={from:number;to:number;storedFrom:number;storedTo:number;child?:Layout}
type Layout={id:string|null;content:Fragment;storedSize:number;entries:Entry[]}
export type InlineContainerLocation={containerId:string|null;offset:number;outerOffset:number}
export type InlineContainerEdits={containerId:string;edits:readonly SemanticInlineEdit[]}
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
const exact=(value:unknown,keys:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',')
const idPattern=/^x_[a-f0-9]{32}$/
const reference=(id:string)=>({hcdInlineContainer:{version:1,id}})
const limits={depth:24,spans:1000,textBytes:1024*1024,retained:10000}

function referenceId(value:Record<string,unknown>):string|null{
 if(!Object.hasOwn(value,'hcdInlineContainer'))return null
 const ref=value.hcdInlineContainer as {version?:unknown;id?:unknown}
 if(!exact(value,['hcdInlineContainer'])||!exact(ref,['version','id'])||ref.version!==1||typeof ref.id!=='string'||!idPattern.test(ref.id))throw new Error('invalidInlineContainerReference')
 return ref.id
}
/** A parent stores one immutable reference. Every body, including an empty
 * one, is a separate permanent XmlText. Reading never allocates or repairs.
 * Property changes use causal candidates in a separate opt-in namespace;
 * immutable definitions and permanent body characters never become LWW attrs. */
export class SemanticInlineContainers{
 readonly definitions:Y.Map<Definition>
 readonly bodies:Y.Map<Y.XmlText>
 constructor(readonly document:Y.Doc,readonly schema:Schema,readonly origin:unknown=inlineContainerOrigin){
  this.definitions=document.getMap(inlineContainerFields.definitions);this.bodies=document.getMap(inlineContainerFields.bodies)
 }
 private attached(text:Y.XmlText){if(text.doc!==this.document)throw new Error('invalidInlineContainerCarrier')}
 private root(text:Y.XmlText){this.attached(text);if(text.parent===this.bodies)throw new Error('invalidInlineContainerRoot')}
 private definition(node:PmNode):Definition{
  if(node.type.schema!==this.schema||node.type.name!==inlineContainerNodeName||!node.isInline||node.isLeaf||node.isAtom||!node.inlineContent||node.marks.length)throw new Error('unsupportedInlineContainer')
  semanticSourceDefaults(node.attrs)
  const attrs={...node.attrs,extension:readInlineContainerPayload(node.attrs.extension)}
  for(const name of sourceDefaultNames)if(name in attrs)(attrs as Record<string,unknown>)[name]=emptySourceDefaults[name]
  for(const [key,value]of Object.entries(attrs))if(key!=='extension'&&stable(value)!==stable(node.type.spec.attrs?.[key]?.default))throw new Error('unsupportedInlineContainerAttributes')
  return{version:1,node:{type:inlineContainerNodeName,attrs}}
 }
 private stored(id:string){
  if(!idPattern.test(id))throw new Error('invalidInlineContainerReference')
  const definition=this.definitions.get(id),text=this.bodies.get(id)
  if(!exact(definition,['version','node'])||definition?.version!==1||!exact(definition.node,['type','attrs'])||definition.node.type!==inlineContainerNodeName||!(text instanceof Y.XmlText))throw new Error('missingInlineContainer')
  this.attached(text);validateSemanticNodeJson(definition.node,this.schema)
  const node=this.schema.nodes[inlineContainerNodeName]?.create(definition.node.attrs)
  if(!node||stable(this.definition(node))!==stable(definition)||definition.node.attrs.extension.instanceId!==id)throw new Error('invalidInlineContainerDefinition')
  return{definition,text}
 }
 private propertyValue(definition:Definition){
  const base=definition.node.attrs.extension,group=inlineContainerEditIndex(this.document).get(base.instanceId)
  if(group&&stable(group.root)!==stable(base))throw new Error('node-edit-base-changed')
  return group?.value??base
 }
 private projectedAttrs(definition:Definition,text:Y.XmlText){return this.bodyAttrs(text,{...definition.node.attrs,extension:this.propertyValue(definition)})}
 private bodyAttrs(text:Y.XmlText,attrs:Record<string,unknown>){
  const stored=text.getAttributes()
  if(Object.keys(stored).some(key=>!sourceDefaultNames.includes(key as typeof sourceDefaultNames[number])))throw new Error('invalidInlineSourceDefaults')
  const defaults=semanticSourceDefaults(stored),type=this.schema.nodes[inlineContainerNodeName]
  if(sourceDefaultNames.some(name=>!(name in(type.spec.attrs??{}))&&stable(defaults[name])!==stable(emptySourceDefaults[name])))throw new Error('unsupportedInlineSourceDefaults')
  return{...attrs,...Object.fromEntries(sourceDefaultNames.filter(name=>name in(type.spec.attrs??{})).map(name=>[name,defaults[name]]))}
 }
 /** Receipt-only metadata updates: never edit immutable business definitions. */
 sourceDefaultActions(id:string,attrs:Record<string,unknown>):Array<()=>void>{
  const {text,definition}=this.stored(id),defaults=semanticSourceDefaults(attrs)
  this.bodyAttrs(text,definition.node.attrs)
  if(sourceDefaultNames.some(name=>!(name in(this.schema.nodes[inlineContainerNodeName].spec.attrs??{}))&&stable(defaults[name])!==stable(emptySourceDefaults[name])))throw new Error('unsupportedInlineSourceDefaults')
  const current=semanticSourceDefaults(text.getAttributes())
  return sourceDefaultNames.filter(name=>stable(current[name])!==stable(defaults[name])).map(name=>()=>{text.setAttribute(name,defaults[name])})
 }
 private project(root:SemanticInlineText,id:string|null=null):Layout{
  const seen=new Set<string>();let spans=0,bytes=0
  const read=(text:SemanticInlineText,id:string|null,depth:number):Layout=>{
   if(depth>limits.depth)throw new Error('inlineContainerDepthLimit')
   const projected=new Map<string,Layout>()
   const content=readSemanticInline(text,this.schema,value=>{
    const childId=referenceId(value);if(childId===null)return null
    if(seen.has(childId))throw new Error('duplicateInlineContainerIdentity');seen.add(childId)
    const stored=this.stored(childId),child=read(stored.text,childId,depth+1);projected.set(childId,child)
    return this.schema.nodes[inlineContainerNodeName].createChecked(this.projectedAttrs(stored.definition,stored.text),child.content)
   })
   const entries:Entry[]=[];let storedFrom=0
   content.forEach((node,from)=>{
    if(++spans>limits.spans)throw new Error('inlineContainerSpanLimit')
    if(node.isText){bytes+=new TextEncoder().encode(node.text!).length;if(bytes>limits.textBytes)throw new Error('inlineContainerTextLimit')}
    const child=node.type.name===inlineContainerNodeName?projected.get(node.attrs.extension.instanceId):undefined
    const length=node.isText?node.nodeSize:1
    entries.push({from,to:from+node.nodeSize,storedFrom,storedTo:storedFrom+length,...(child?{child}:{})});storedFrom+=length
   })
   const storedSize=text.toDelta().reduce((size,part)=>size+(typeof part.insert==='string'?part.insert.length:1),0)
   if(storedFrom!==storedSize)throw new Error('invalidInlineContainerCarrier')
   return{id,content,storedSize,entries}
  }
  if(id!==null)seen.add(id)
  return read(root,id,0)
 }
 read(root:Y.XmlText){this.root(root);return this.project(root).content}
 /** A logical root can span several permanent parent carriers. Only the
  * trusted flow adapter supplies this interface; child bodies stay XmlText. */
 readText(root:SemanticInlineText){if(root instanceof Y.XmlText)this.root(root);return this.project(root).content}
 readBody(id:string){const stored=this.stored(id);return this.schema.nodes[inlineContainerNodeName].createChecked(this.projectedAttrs(stored.definition,stored.text),this.project(stored.text,id).content)}
 /** Caller supplies its exact current projection. Refuse stale local writes;
  * genuinely offline replicas still diff their own permanent characters. */
 write(root:Y.XmlText,before:Fragment,node:PmNode){
  this.root(root)
  this.writeText(root,before,node)
 }
 private plan(nodes:readonly PmNode[],storage?:(value:Record<string,unknown>)=>Record<string,unknown>){
  const occurrences=new Set<string>()
  const plans=new Map<string,{definition:Definition;node:PmNode}>(),beforeProperties:Payload[]=[],afterProperties:Payload[]=[];let spans=0,bytes=0
  const leafValues=new Map<string,Record<string,unknown>>()
  const leaf=(value:Record<string,unknown>)=>{
   const key=stable(value)
   if(!leafValues.has(key)){
    const stored=storage?storage(value):value
    if(stored.type!==value.type||Object.keys(stored).some(name=>!['type','attrs'].includes(name)))throw new Error('unsupportedInlineContent')
    validateSemanticNodeJson(stored,this.schema)
    const projected=this.schema.nodeFromJSON(stored);projected.check()
    if(!projected.isInline||!projected.isLeaf||projected.isText)throw new Error('unsupportedInlineContent')
    leafValues.set(key,structuredClone(stored))
   }
   return leafValues.get(key)!
  }
  const encode=(child:PmNode)=>reference(this.definition(child).node.attrs.extension.instanceId)
  const visit=(parent:PmNode,depth:number)=>{
   if(depth>limits.depth)throw new Error('inlineContainerDepthLimit')
   validateSemanticInline(parent,encode,leaf)
   parent.forEach(child=>{
    if(++spans>limits.spans)throw new Error('inlineContainerSpanLimit')
    if(child.isText){bytes+=new TextEncoder().encode(child.text!).length;if(bytes>limits.textBytes)throw new Error('inlineContainerTextLimit')}
    if(['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer',inlineContainerNodeName].includes(child.type.name)){const id=child.type.name===inlineContainerNodeName?this.definition(child).node.attrs.extension.instanceId:readExtensionNode(child.attrs.extension).instanceId;if(occurrences.has(id))throw new Error('duplicateInlineContainerIdentity');occurrences.add(id)}
    if(child.isLeaf)return
    let definition=this.definition(child);const id=definition.node.attrs.extension.instanceId
    if(plans.has(id))throw new Error('duplicateInlineContainerIdentity')
    if(this.definitions.has(id)||this.bodies.has(id)){
     const old=this.stored(id),proposed=definition.node.attrs.extension
     beforeProperties.push(this.propertyValue(old.definition));afterProperties.push(proposed)
     definition={...definition,node:{...definition.node,attrs:{...definition.node.attrs,extension:old.definition.node.attrs.extension}}}
     if(stable(old.definition)!==stable(definition))throw new Error('inlineContainerDefinitionChanged')
    }
    plans.set(id,{definition,node:child})
    visit(child,depth+1)
   })
  }
  for(const node of nodes){
   if(node.type.schema!==this.schema||!node.inlineContent)throw new Error('unsupportedInlineContent');node.check();validateSemanticNodeJson(node.toJSON(),this.schema);spans=0;bytes=0;visit(node,0)
  }
  const added=[...plans].filter(([id])=>!this.definitions.has(id))
  if(Math.max(this.definitions.size,this.bodies.size)+added.length>limits.retained)throw new Error('inlineContainerRetainedLimit')
  const records=prepareInlineContainerEdits(this.document,beforeProperties,afterProperties)
  return{plans,added,leaf,encode,records}
 }
 private allocate(plan:ReturnType<SemanticInlineContainers['plan']>){
  // An outer personal transaction would take ownership of these permanent maps.
  if(plan.added.length&&this.document._transaction)throw new Error('inlineContainerAllocationRequiresPreparation')
  if(!plan.added.length)return
  this.document.transact(()=>{
   for(const [id,item]of plan.added){this.definitions.set(id,item.definition);const text=new Y.XmlText();this.bodies.set(id,text);const defaults=semanticSourceDefaults(item.node.attrs);for(const name of sourceDefaultNames)if(stable(defaults[name])!==stable(emptySourceDefaults[name]))text.setAttribute(name,defaults[name])}
  },allocationOrigin)
 }
 /** Pure whole-operation preflight. All roots share one occurrence set; a bad
  * later root cannot cause allocations for an earlier one. */
 validate(nodes:readonly PmNode[],storage?:(value:Record<string,unknown>)=>Record<string,unknown>){this.plan(nodes,storage)}
 /** Explicit preparation for structural callers. Revalidate the complete
  * proposal immediately before allocation, including definitions that changed
  * since prepare() returned. No body content is seeded outside personal undo. */
 prepare(nodes:readonly PmNode[],storage?:(value:Record<string,unknown>)=>Record<string,unknown>){
  const proposal=this.plan(nodes,storage),roots=[...nodes]
  return{records:proposal.records,allocate:()=>{const current=this.plan(roots,storage);if(stable(current.records.map(({id:_id,...record})=>record))!==stable(proposal.records.map(({id:_id,...record})=>record)))throw new Error('staleInlineContainerProperties');this.allocate(current)}}
 }
 /** Seed a permanent parent carrier without modifying any existing/new body.
  * Structural allocation uses this; body changes remain in the user's origin. */
 writeReferences(root:SemanticInlineText,node:PmNode,storage?:(value:Record<string,unknown>)=>Record<string,unknown>){
  if(root instanceof Y.XmlText)this.root(root)
  const plan=this.plan([node],storage)
  if(plan.added.length)throw new Error('inlineContainerAllocationRequiresPreparation')
  writeSemanticInline(root,node,plan.leaf,plan.encode)
 }
 writeText(root:SemanticInlineText,before:Fragment,node:PmNode,storage?:(value:Record<string,unknown>)=>Record<string,unknown>){
  if(!this.readText(root).eq(before))throw new Error('staleInlineContainerContent')
  const plan=this.plan([node],storage);this.allocate(plan)
  this.document.transact(()=>{
   publishInlineContainerEdits(this.document,plan.records)
   for(const [id,item]of [...plan.plans].reverse())writeSemanticInline(this.bodies.get(id)!,item.node,plan.leaf,plan.encode)
   writeSemanticInline(root,node,plan.leaf,plan.encode)
  },this.origin)
 }
 /** Original PM text steps use actual carrier offsets, not expanded wrapper
  * sizes. Validate every body before mutating any; empty batches prove that
  * an unmentioned scope changed formatting only, never hidden text. */
 private textEditPlan(root:SemanticInlineText,node:PmNode,edits:readonly SemanticInlineEdit[],bodies:readonly InlineContainerEdits[],storage?:(value:Record<string,unknown>)=>Record<string,unknown>){
  const plan=this.plan([node],storage)
  if(plan.added.length)throw new Error('inlineContainerTextEditsRequireExistingBodies')
  if(bodies.length>1000||bodies.reduce((n,body)=>n+body.edits.length,edits.length)>256)throw new Error('semanticTextEditsLimit')
  const grouped=new Map<string,readonly SemanticInlineEdit[]>()
  for(const body of bodies){if(!plan.plans.has(body.containerId)||grouped.has(body.containerId))throw new Error('invalidInlineContainerTextEdits');grouped.set(body.containerId,body.edits)}
  const scopes=[...plan.plans].reverse().map(([id,item])=>({text:this.stored(id).text as SemanticInlineText,node:item.node,edits:grouped.get(id)??[]}))
  scopes.push({text:root,node,edits})
  const model={containers:plan.encode,allowEmpty:true}
  for(const scope of scopes)validateSemanticEdits(scope.text,scope.node,scope.edits,plan.leaf,model)
  return{scopes,storage:plan.leaf,model,records:plan.records}
 }
 validateTextEdits(root:SemanticInlineText,node:PmNode,edits:readonly SemanticInlineEdit[],bodies:readonly InlineContainerEdits[]=[],storage?:(value:Record<string,unknown>)=>Record<string,unknown>){this.textEditPlan(root,node,edits,bodies,storage)}
 writeTextEdits(root:SemanticInlineText,node:PmNode,edits:readonly SemanticInlineEdit[],bodies:readonly InlineContainerEdits[]=[],storage?:(value:Record<string,unknown>)=>Record<string,unknown>){
  const plan=this.textEditPlan(root,node,edits,bodies,storage)
  this.document.transact(()=>{publishInlineContainerEdits(this.document,plan.records);for(const scope of plan.scopes)writeSemanticEdits(scope.text,scope.node,scope.edits,plan.storage,plan.model)},this.origin)
 }
 /** Map a PM offset to its actual carrier offset and the outer reference's
  * location. This also works on a split/joined flow's composite adapter. */
 locate(root:SemanticInlineText,offset:number):InlineContainerLocation{
  if(root instanceof Y.XmlText)this.root(root)
  if(!Number.isSafeInteger(offset))throw new Error('invalidInlineContainerPosition')
  const capture=(layout:Layout,index:number,outer?:number):InlineContainerLocation=>{
   if(index<0||index>layout.content.size)throw new Error('invalidInlineContainerPosition')
   for(const entry of layout.entries){
    if(entry.child&&index>entry.from&&index<entry.to)return capture(entry.child,index-entry.from-1,outer??entry.storedFrom)
    if(index<=entry.to){const stored=index===entry.to?entry.storedTo:entry.storedFrom+index-entry.from;return{containerId:layout.id,offset:stored,outerOffset:outer??stored}}
   }
   return{containerId:layout.id,offset:layout.storedSize,outerOffset:outer??layout.storedSize}
  }
  return capture(this.project(root),offset)
 }
 projectOffset(root:SemanticInlineText,containerId:string|null,index:number):number|null{
  if(root instanceof Y.XmlText)this.root(root)
  if(!Number.isSafeInteger(index)||index<0)return null
  const find=(layout:Layout,base:number):number|null=>{
   if(layout.id===containerId){
    if(index>layout.storedSize)return null
    for(const entry of layout.entries)if(index<=entry.storedTo)return base+(index===entry.storedTo?entry.to:entry.from+index-entry.storedFrom)
    return base+layout.content.size
   }
   for(const entry of layout.entries){if(!entry.child)continue;const found=find(entry.child,base+entry.from+1);if(found!==null)return found}
   return null
  }
  return find(this.project(root),0)
 }
 bodyRelative(id:string,index:number,assoc=-1):Relative{
  const {text}=this.stored(id)
  if(!Number.isSafeInteger(index)||index<0||index>text.length||![-1,0,1].includes(assoc))throw new Error('invalidInlineContainerPosition')
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text,index,assoc))
 }
 relativeBody(relative:Relative):{containerId:string;offset:number}|null{
  const absolute=Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(relative),this.document)
  if(!absolute||!(absolute.type instanceof Y.XmlText)||absolute.type.parent!==this.bodies)return null
  const id=absolute.type._item?.parentSub
  if(typeof id!=='string'||this.stored(id).text!==absolute.type||absolute.index<0||absolute.index>absolute.type.length)return null
  return{containerId:id,offset:absolute.index}
 }
 /** A point inside a wrapper belongs to its body, including an empty one. */
 capture(root:Y.XmlText,offset:number,assoc=-1):InlineContainerPoint{
  this.root(root)
  if(![-1,0,1].includes(assoc))throw new Error('invalidInlineContainerPosition')
  const at=this.locate(root,offset)
  return{containerId:at.containerId,relative:at.containerId===null?Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(root,at.offset,assoc)):this.bodyRelative(at.containerId,at.offset,assoc)}
 }
 resolve(root:Y.XmlText,point:InlineContainerPoint):number|null{
  this.root(root)
  if(point.containerId!==null){const body=this.relativeBody(point.relative);return body?.containerId===point.containerId?this.projectOffset(root,body.containerId,body.offset):null}
  const absolute=Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(point.relative),this.document)
  return absolute?.type===root?this.projectOffset(root,null,absolute.index):null
 }
 undoManager(roots:readonly Y.XmlText[]){roots.forEach(root=>this.root(root));return new Y.UndoManager([...roots,this.bodies],{trackedOrigins:new Set([this.origin]),captureTimeout:0})}
}
