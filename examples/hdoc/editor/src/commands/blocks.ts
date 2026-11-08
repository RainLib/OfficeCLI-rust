import {readExtensionNode,copyExtensionNode,extensionRegistryForState} from '../extensionNode.ts'
import type {NodeExtensionRegistry} from '../extensionRegistry.ts'
import type {InlineContainerRegistry} from '../inlineContainerRegistry.ts'
import {readInlineContainerPayload} from '../inlineContainerPayload.ts'
import {inlineContainerRegistryForState} from '../inlineContainerPreservation.ts'
import {readCustomMark} from '../customMarks.ts'
import {extensionPmNode} from '../extensionCommands.ts'
import {inlineContainerPmNode} from '../inlineContainerCommands.ts'
import {copyInlineReference} from '../inlineReference.ts'
import {Fragment,Mark,type Node as PmNode} from '@tiptap/pm/model'
import {Selection,TextSelection,type EditorState,type Transaction} from '@tiptap/pm/state'
import type {Editor} from '@tiptap/core'
import {typography,type TextTypography} from '../typography.ts'
export type BlockTarget={kind:'block';from:number;to:number;fingerprint:string;anchor:string|null;intent:'operate'|'before'|'after';destination?:number;scope?:{from:number;instanceId:string}}
export const blockTypes=['block.paragraph','block.heading','block.bulletList','block.orderedList','block.quote','block.code','block.divider'] as const
export const blockOperations=[...blockTypes,'block.insertParagraph','block.duplicate','block.delete','block.up','block.down','block.move']
/** Ephemeral intent for the structural binding; never serialized as content. */
export const blockMoveMeta='hcd-block-move-intent/1'
export const blockDeleteMeta='hcd-block-delete-intent/1'
export type BlockEntry={node:PmNode;from:number;to:number}
export function rootBlocks(doc:PmNode){const result:BlockEntry[]=[];doc.forEach((node,from)=>result.push({node,from,to:from+node.nodeSize}));return result}
function scopeEntries(doc:PmNode,scope?:BlockTarget['scope']){if(!scope)return rootBlocks(doc);const parent=doc.nodeAt(scope.from);if(parent?.type.name!=='hcdExtensionContainer'||parent.attrs.extension?.instanceId!==scope.instanceId)return[];const entries:BlockEntry[]=[];parent.forEach((node,offset)=>{const from=scope.from+1+offset;entries.push({node,from,to:from+node.nodeSize})});return entries}
export function blockEntryScope(doc:PmNode,entry:BlockEntry):BlockTarget['scope']{const position=doc.resolve(entry.from);if(position.parent.type.name==='hcdExtensionContainer')return{from:position.before(position.depth),instanceId:position.parent.attrs.extension.instanceId}}
export function siblingBlockEntries(doc:PmNode,entry:BlockEntry){return scopeEntries(doc,blockEntryScope(doc,entry))}
function selectionScope(state:EditorState):BlockTarget['scope']{const {selection}=state;for(let d=selection.$from.depth;d>0;d--){const parent=selection.$from.node(d);if(parent.type.name==='hcdExtensionContainer'&&selection.$to.depth>=d&&selection.$to.node(d)===parent)return{from:selection.$from.before(d),instanceId:parent.attrs.extension.instanceId}}}
/** Root handles plus direct children of extension containers. */
export function editorBlockEntries(doc:PmNode){const entries=rootBlocks(doc);doc.descendants((node,at)=>{if(node.type.name==='hcdExtensionContainer')entries.push(...scopeEntries(doc,{from:at,instanceId:node.attrs.extension.instanceId}))});return entries.sort((a,b)=>a.from-b.from)}
const protectionCache=new WeakMap<PmNode,boolean>()
/** PM nodes are immutable: unchanged subtrees keep their protection result. */
export function protectedBlock(node:PmNode,registry?:NodeExtensionRegistry,inline?:InlineContainerRegistry):boolean{
 let protectedContent=protectionCache.get(node)
 if(protectedContent===undefined){protectedContent=node.marks.some(mark=>mark.type.name==='hcdCustomMark')||['hcdOpaque','hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer','hcdExtensionInlineContainer'].includes(node.type.name)||node.content.content.some(child=>protectedBlock(child));protectionCache.set(node,protectedContent)}
 if(!protectedContent||!registry)return protectedContent
 if(node.type.name==='hcdOpaque')return true
 if(node.type.name==='hcdExtensionInlineContainer'&&!inline?.resolve(readInlineContainerPayload(node.attrs.extension)))return true
 if(node.marks.some(mark=>mark.type.name==='hcdCustomMark'&&!registry.marks.resolve(readCustomMark(mark.attrs.value))))return true
 if(['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(node.type.name)&&!registry.resolve(readExtensionNode(node.attrs.extension)))return true
 return node.content.content.some(child=>protectedBlock(child,registry,inline))
}
function writableTarget(doc:PmNode,target:BlockTarget,registry?:NodeExtensionRegistry,inline?:InlineContainerRegistry){
 const entries=targeted(doc,target);if(!entries||entries.some(entry=>protectedBlock(entry.node,registry,inline)))return false
 if(target.scope){const parent=doc.nodeAt(target.scope.from);if(!parent||!registry?.resolve(readExtensionNode(parent.attrs.extension)))return false;const position=doc.resolve(target.scope.from);for(let depth=1;depth<=position.depth;depth++){const ancestor=position.node(depth);if(ancestor.type.name==='hcdExtensionContainer'&&!registry.resolve(readExtensionNode(ancestor.attrs.extension)))return false}}
 return true
}
export function operableBlockEntry(doc:PmNode,entry:BlockEntry,registry?:NodeExtensionRegistry,inline?:InlineContainerRegistry){
 if(protectedBlock(entry.node,registry,inline))return false
 const position=doc.resolve(entry.from)
 for(let depth=1;depth<=position.depth;depth++){const ancestor=position.node(depth);if(ancestor.type.name==='hcdExtensionContainer'&&!registry?.resolve(readExtensionNode(ancestor.attrs.extension)))return false}
 return true
}
export function selectedRootBlocks(state:EditorState){const {from,to,empty}=state.selection;return scopeEntries(state.doc,selectionScope(state)).filter(block=>empty?from>=block.from&&from<block.to:block.to>from&&block.from<to)}
export function blockTarget(state:EditorState,entries=selectedRootBlocks(state),intent:BlockTarget['intent']='operate',anchor:string|null=null):BlockTarget|null{
 if(!entries.length)return null
 const proposedScope=selectionScope(state),scope=proposedScope&&scopeEntries(state.doc,proposedScope).some(e=>e.from===entries[0].from)?proposedScope:undefined
 return{kind:'block',...(scope?{scope}:{}),from:entries[0].from,to:entries.at(-1)!.to,fingerprint:JSON.stringify(entries.map(entry=>entry.node.toJSON())),intent,anchor}
}
function targeted(doc:PmNode,target:BlockTarget){
 const entries=scopeEntries(doc,target.scope).filter(block=>block.from>=target.from&&block.to<=target.to)
 return entries.length&&entries[0].from===target.from&&entries.at(-1)!.to===target.to&&JSON.stringify(entries.map(entry=>entry.node.toJSON()))===target.fingerprint?entries:null
}
export function targetBlockCount(doc:PmNode,target:BlockTarget){return targeted(doc,target)?.length??0}
/** A clone never inherits canonical/source identity. Preserve visible typography. */
export function duplicateBlock(node:PmNode,createId:()=>string=()=>`tmp_${crypto.randomUUID()}`,inherited?:TextTypography):PmNode{
 const font=typography(node.attrs.hcdSourceTypography)??inherited
 let marks=node.marks.filter(mark=>mark.type.name!=='hcdSource').map(mark=>mark.type.name==='textTypography'?mark.type.create({...mark.attrs,explicitSize:mark.attrs.sizePt!=null||mark.attrs.explicitSize===true}):mark)
 if(node.isText){if(font&&!marks.some(mark=>mark.type.name==='textTypography')&&node.type.schema.marks.textTypography)marks=[...marks,node.type.schema.marks.textTypography.create({...font,explicitSize:font.sizePt!=null})];return node.mark(marks)}
 const attrs={...node.attrs}
 if(node.type.name==='hcdMention')attrs.reference=copyInlineReference(attrs.reference)
 if(node.type.name==='hcdExtensionInlineContainer')attrs.extension={...readInlineContainerPayload(attrs.extension),instanceId:`x_${crypto.randomUUID().replaceAll('-','')}`}
 if(['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(node.type.name)){
  attrs.extension=copyExtensionNode(attrs.extension)
  if(node.type.name==='hcdExtensionBlock'&&attrs.fallbackInline){const {nodeId:_source,...fallback}=attrs.fallbackInline;attrs.fallbackInline={...fallback,text:attrs.extension.fallback.text}}
 }
 for(const key of ['hcdStructureKey','hcdCanonicalKey'])if(key in attrs)attrs[key]=null
 if('hcdBlockId'in attrs)attrs.hcdBlockId=createId()
 for(const key of ['hcdSourceId','hcdSourceTypography'])if(key in attrs)attrs[key]=null
 if('hcdSourceSizeExplicit'in attrs)attrs.hcdSourceSizeExplicit=false
 const children:PmNode[]=[];node.forEach(child=>children.push(duplicateBlock(child,createId,font)))
 return node.type.createChecked(attrs,Fragment.fromArray(children),marks)
}
function flatTextBlocks(nodes:PmNode[]):PmNode[]|null{
 const result:PmNode[]=[]
 for(const node of nodes){
  if(node.isTextblock||node.type.name==='horizontalRule'){result.push(node);continue}
  if(node.type.name==='blockquote'&&[...node.content.content].every(child=>child.isTextblock)){node.forEach((child,index)=>result.push(child.type.create({...child.attrs,...(index===0?node.attrs:{} ),...('hcdStructureKey'in child.attrs?{hcdStructureKey:child.attrs.hcdStructureKey}:{})},child.content,child.marks)));continue}
  if(['bulletList','orderedList'].includes(node.type.name)&&node.content.content.every(item=>item.type.name==='listItem'&&item.childCount===1&&item.firstChild?.isTextblock)){
   node.forEach(item=>{const child=item.firstChild!;result.push(child.type.create({...child.attrs,...item.attrs,...('hcdStructureKey'in child.attrs?{hcdStructureKey:child.attrs.hcdStructureKey}:{})},child.content,child.marks))});continue
  }
  return null
 }
 return result
}
function inlineFor(node:PmNode,code:boolean){
 const children:PmNode[]=[];node.forEach(child=>{
  if(child.type.name==='hardBreak'&&code)children.push(node.type.schema.text('\n',child.marks.filter(mark=>['hcdSource','textTypography'].includes(mark.type.name))))
  else if(code)children.push(child.mark(child.marks.filter(mark=>['hcdSource','textTypography'].includes(mark.type.name))))
  else if(node.type.name==='codeBlock'&&child.isText&&child.text?.includes('\n'))child.text.split('\n').forEach((line,index)=>{if(index)children.push(node.type.schema.nodes.hardBreak.create());if(line)children.push(node.type.schema.text(line,child.marks))})
  else children.push(child)
 });return Fragment.fromArray(children)
}
function converted(nodes:PmNode[],id:string):PmNode[]|null{
 const flat=flatTextBlocks(nodes);if(!flat?.length)return null
 const schema=nodes[0].type.schema
 if(id==='block.divider')return flat.length===1&&flat[0].content.size===0?[schema.nodes.horizontalRule.create(flat[0].attrs)]:null
 if(id==='block.quote')return[schema.nodes.blockquote.createChecked({...flat[0].attrs,...('hcdStructureKey'in flat[0].attrs?{hcdStructureKey:null}:{})},flat.map(node=>schema.nodes.paragraph.createChecked({...node.attrs,hcdBlockId:null,...('hcdCanonicalKey'in node.attrs?{hcdCanonicalKey:null}:{})},inlineFor(node,false))))]
 if(id==='block.code'){
  if(flat.some(node=>node.content.content.some(child=>!child.isText&&child.type.name!=='hardBreak')))return null
  const content:PmNode[]=[];flat.forEach((node,index)=>{if(index)content.push(schema.text('\n'));content.push(...inlineFor(node,true).content)})
  return[schema.nodes.codeBlock.createChecked({...flat[0].attrs,language:null},content)]
 }
 if(id==='block.bulletList'||id==='block.orderedList')return[schema.nodes[id==='block.bulletList'?'bulletList':'orderedList'].createChecked(id==='block.orderedList'?{start:1}:{},flat.map(node=>schema.nodes.listItem.createChecked({...node.attrs,...('hcdStructureKey'in node.attrs?{hcdStructureKey:null}:{})},[schema.nodes.paragraph.createChecked({...node.attrs,hcdBlockId:null,...('hcdCanonicalKey'in node.attrs?{hcdCanonicalKey:null}:{})},inlineFor(node,false))])))]
 if(id==='block.paragraph'||id==='block.heading')return flat.map(node=>schema.nodes[id==='block.heading'?'heading':'paragraph'].createChecked({...node.attrs,...(id==='block.heading'?{level:2}:{})},inlineFor(node,false)))
 return null
}
function newContent(doc:PmNode,id:string,input:unknown):PmNode[]|null{
 const schema=doc.type.schema,paragraph=schema.nodes.paragraph.create({hcdBlockId:`tmp_${crypto.randomUUID()}`})
 if(id==='node.insert'){try{const value=(input as {extension?:{schemaVersion?:unknown}})?.extension,node=value?.schemaVersion==='hcd.extension/3'?inlineContainerPmNode(schema,value):extensionPmNode({schema},readExtensionNode(value));return node.isInline?[paragraph.type.createChecked(paragraph.attrs,[node])]:[node]}catch{return null}}
 if(id==='block.insertParagraph')return[paragraph]
 if(id==='text.insert'){
  const text=(input as {text?:unknown})?.text;if(typeof text!=='string'||!text.length||text.length>1_000_000)return null
  const nodes:PmNode[]=[];text.replaceAll('\r\n','\n').split('\n').forEach((line,index)=>{if(index)nodes.push(schema.nodes.hardBreak.create());if(line)nodes.push(schema.text(line))})
  return[paragraph.type.createChecked(paragraph.attrs,nodes)]
 }
 return converted([paragraph],id)
}
function moveDestination(doc:PmNode,id:string,input:unknown,target:BlockTarget,registry?:NodeExtensionRegistry,inline?:InlineContainerRegistry){
 const entries=targeted(doc,target);if(!entries||!writableTarget(doc,target,registry,inline))return null
 const roots=scopeEntries(doc,target.scope),first=roots.findIndex(block=>block.from===target.from),last=first+entries.length-1
 const destination=id==='block.up'?roots[first-1]?.from:id==='block.down'?roots[last+1]?.to:target.destination??(input as {destination?:number})?.destination
 if(destination===undefined||!Number.isSafeInteger(destination)||destination>=target.from&&destination<=target.to||!([target.scope?target.scope.from+1:0,target.scope?target.scope.from+1+doc.nodeAt(target.scope.from)!.content.size:doc.content.size,...roots.map(block=>block.from)].includes(destination)))return null
 const traversed=roots.filter(block=>destination<target.from?block.from>=destination&&block.to<=target.from:block.from>=target.to&&block.to<=destination)
 return traversed.some(block=>protectedBlock(block.node,registry,inline))?null:destination
}
/** All edits are built against an immutable target; no intermediate dispatch. */
export function transformBlocks(tr:Transaction,id:string,input:unknown,target:BlockTarget,registry?:NodeExtensionRegistry,inline?:InlineContainerRegistry):boolean{
 const entries=targeted(tr.doc,target);if(!entries||!writableTarget(tr.doc,target,registry,inline))return false
 const roots=scopeEntries(tr.doc,target.scope),first=roots.findIndex(block=>block.from===target.from)
 let focus=target.from
 try{
  if(target.intent!=='operate'){
   const content=newContent(tr.doc,id,input);if(!content)return false
   focus=target.intent==='before'?target.from:target.to;tr.insert(focus,content)
  }else if(id==='block.duplicate'){
   const content=entries.map(entry=>duplicateBlock(entry.node));focus=target.to;tr.insert(target.to,content)
  }else if(id==='block.delete'){
   tr.setMeta(blockDeleteMeta,{first,count:entries.length,...(target.scope?{keys:entries.map(e=>e.node.attrs.hcdStructureKey)}:{})})
   tr.delete(target.from,target.to)
  }else if(['block.up','block.down','block.move'].includes(id)){
   const destination=moveDestination(tr.doc,id,input,target,registry,inline);if(destination===null)return false
   tr.setMeta(blockMoveMeta,{first,count:entries.length,...(target.scope?{keys:entries.map(e=>e.node.attrs.hcdStructureKey)}:{})})
   const slice=tr.doc.slice(target.from,target.to);tr.delete(target.from,target.to);focus=destination>target.to?destination-(target.to-target.from):destination;tr.insert(focus,slice.content)
  }else if(id==='block.insertParagraph'){
   focus=target.to;tr.insert(focus,newContent(tr.doc,id,input)!)
  }else{
   const content=converted(entries.map(entry=>entry.node),id);if(!content)return false
   tr.replaceWith(target.from,target.to,content)
  }
  tr.doc.check();tr.setSelection(Selection.near(tr.doc.resolve(Math.min(focus+1,tr.doc.content.size))));tr.scrollIntoView();return true
 }catch{return false}
}
export function prepareBlockTransaction(editor:Editor,id:string,input:unknown,target:BlockTarget):(()=>boolean)|null{
 if(editor.isDestroyed||!editor.isEditable||editor.view.composing)return null
 const before=editor.state,tr=before.tr
 if(!transformBlocks(tr,id,input,target,extensionRegistryForState(before),inlineContainerRegistryForState(before)))return null
 return()=>{
  if(editor.isDestroyed||!editor.isEditable||editor.view.composing||editor.state.doc!==before.doc||!editor.state.selection.eq(before.selection)||!Mark.sameSet(editor.state.storedMarks??[],before.storedMarks??[]))return false
  if(!writableTarget(editor.state.doc,target,extensionRegistryForState(editor.state),inlineContainerRegistryForState(editor.state)))return false
  if(['block.up','block.down','block.move'].includes(id)&&moveDestination(editor.state.doc,id,input,target,extensionRegistryForState(editor.state),inlineContainerRegistryForState(editor.state))===null)return false
  editor.view.dispatch(tr);if(editor.state.doc===before.doc)return false;editor.view.focus();return true
 }
}
export function blockActionStates(state:EditorState,target:BlockTarget|null=blockTarget(state),registry=extensionRegistryForState(state),inline=inlineContainerRegistryForState(state)){
 const entries=target&&targeted(state.doc,target),roots=scopeEntries(state.doc,target?.scope)
 const safe=!!entries&&!!target&&writableTarget(state.doc,target,registry,inline),flat=entries&&flatTextBlocks(entries.map(entry=>entry.node)),insert=target?.intent!=='operate'
 const first=target?roots.findIndex(entry=>entry.from===target.from):-1,last=first+(entries?.length??0)-1
 const actions:Record<string,{enabled:boolean;active?:boolean;reason?:string}>={}
 for(const id of blockTypes)actions[id]={enabled:safe&&(insert||!!flat&&!(id==='block.divider'&&(flat.length!==1||flat[0].content.size>0)))}
 if(!insert&&flat?.some(node=>node.content.content.some(child=>child.type.name==='hcdMention')))actions['block.code']={enabled:false,reason:'mentionIncompatibleFormat'}
 if(!insert&&flat?.some(node=>node.content.content.some(child=>['hcdExtensionInline','hcdExtensionInlineContainer'].includes(child.type.name))))actions['block.code']={enabled:false,reason:'commandProtected'}
 actions['block.duplicate']={enabled:safe};actions['block.delete']={enabled:safe};actions['block.insertParagraph']={enabled:safe}
 actions['block.up']={enabled:safe&&first>0&&!protectedBlock(roots[first-1].node,registry,inline)}
 actions['block.down']={enabled:safe&&last+1<roots.length&&!protectedBlock(roots[last+1].node,registry,inline)}
 actions['block.move']={enabled:safe&&!!target&&blockDestinations(state.doc,target,registry,inline).length>0};if(insert)actions['text.insert']={enabled:safe}
 return actions
}
export function blockDestinations(doc:PmNode,target:BlockTarget,registry?:NodeExtensionRegistry,inline?:InlineContainerRegistry){
 const entries=targeted(doc,target);if(!entries||!writableTarget(doc,target,registry,inline))return[]
 const roots=scopeEntries(doc,target.scope),start=target.scope?target.scope.from+1:0,end=target.scope?target.scope.from+1+(doc.nodeAt(target.scope.from)?.content.size??0):doc.content.size,positions=[start,...roots.map(entry=>entry.to)]
 // Only the nearest protected barrier on either side can limit a destination.
 // Rewalking every subtree for every destination made palette typing quadratic.
 let left=start,right=end
 for(const entry of roots)if(protectedBlock(entry.node,registry,inline)){
  if(entry.to<=target.from)left=Math.max(left,entry.to)
  if(entry.from>=target.to)right=Math.min(right,entry.from)
 }
 return positions.filter(position=>(position<target.from||position>target.to)&&position>=left&&position<=right)
}
