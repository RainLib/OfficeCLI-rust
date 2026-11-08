import {DOMParser as PmParser,DOMSerializer,Slice,type Node as PmNode,type Fragment,type Schema} from '@tiptap/pm/model'
import {Plugin,type EditorState} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import {clearPastedBlockIds} from './schema.ts'
import {inlineContainerNodeName,readInlineContainerPayload} from './inlineContainerPayload.ts'
import {readExtensionElement,readExtensionNode} from './extensionNode.ts'
import {readInlineReference,referenceText} from './inlineReference.ts'
import {readCustomMark,normalizeCustomMarkHtml} from './customMarks.ts'
import {stableExtension} from './extensionRegistry.ts'

export const inlineClipboardMime='application/x-hcd-inline-slice+json'
const limits={bytes:2*1024*1024,nodes:1000,depth:64,bodies:24,text:1024*1024}
const invalid=()=>new Error('inlineContainerClipboardInvalid')
const bytes=(value:string)=>new TextEncoder().encode(value).length
const freshPayload=(input:unknown)=>({...readInlineContainerPayload(input),instanceId:`x_${crypto.randomUUID().replaceAll('-','')}`})
export function readInlineContainerElement(element:HTMLElement){
 if(element.tagName!=='SPAN')throw invalid()
 const value=readInlineContainerPayload(JSON.parse(element.getAttribute('data-hcd-inline-payload')??''))
 if(element.getAttribute('data-hcd-inline-container')!==value.instanceId)throw invalid()
 return value
}
export function pastedInlineContainerAttributes(element:HTMLElement){return{extension:freshPayload(readInlineContainerElement(element))}}
function hasBody(fragment:Fragment){let found=false;fragment.descendants(node=>{if(node.type.name===inlineContainerNodeName)found=true});return found}
function validateSlice(slice:Slice){
 let nodes=0,text=0
 const visit=(node:PmNode,depth:number,bodies:number)=>{
  if(++nodes>limits.nodes||depth>limits.depth)throw invalid()
  if(node.type.name==='hcdOpaque')throw invalid()
  if(node.isText){text+=bytes(node.text!);if(text>limits.text||[...node.text!].some(char=>{const n=char.codePointAt(0)!;return n===0||n>=0xd800&&n<=0xdfff}))throw invalid()}
  if(node.type.name===inlineContainerNodeName){if(++bodies>limits.bodies||node.marks.length)throw invalid();readInlineContainerPayload(node.attrs.extension)}
  else if(['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(node.type.name))readExtensionNode(node.attrs.extension)
  else if(node.type.name==='hcdMention')readInlineReference(node.attrs.reference)
  node.marks.forEach(mark=>{if(mark.type.name==='hcdCustomMark')readCustomMark(mark.attrs.value)})
  node.check();node.forEach(child=>visit(child,depth+1,bodies))
 }
 slice.content.forEach(node=>visit(node,0,0))
 if(!Number.isSafeInteger(slice.openStart)||!Number.isSafeInteger(slice.openEnd)||slice.openStart<0||slice.openEnd<0||slice.openStart>limits.depth||slice.openEnd>limits.depth)throw invalid()
}
/** Keep context paragraphs open, but never let the PM fitter assimilate a
 * copied inline wrapper into an existing carrier. Partial bodies copy only
 * their selected text, inside fresh wrappers. */
export function copyInlineContainerSlice(slice:Slice,targetSourceId?:string){
 validateSlice(slice)
 const copied=clearPastedBlockIds(slice,targetSourceId,{inlineContainers:true})
 const closed=(open:number,last:boolean)=>{let node=last?copied.content.lastChild:copied.content.firstChild;for(let depth=0;depth<open&&node;depth++){if(node.type.name===inlineContainerNodeName)return depth;node=last?node.lastChild:node.firstChild}return open}
 return new Slice(copied.content,closed(slice.openStart,false),closed(slice.openEnd,true))
}
export function encodeInlineClipboard(slice:Slice){
 const copied=copyInlineContainerSlice(slice),value=JSON.stringify({schemaVersion:'hcd-inline-clipboard/1',slice:copied.toJSON()})
 if(bytes(value)>limits.bytes||!hasBody(copied.content))throw invalid()
 return{slice:copied,json:value}
}
export function decodeInlineClipboard(value:string,schema:Schema,targetSourceId?:string){
 if(!value||bytes(value)>limits.bytes)throw invalid()
 const packet=JSON.parse(value)
 if(!packet||Object.keys(packet).sort().join(',')!=='schemaVersion,slice'||packet.schemaVersion!=='hcd-inline-clipboard/1'||!packet.slice||typeof packet.slice!=='object'||Object.keys(packet.slice).some(key=>!['content','openStart','openEnd'].includes(key)))throw invalid()
 // Bound and check untrusted JSON before recursive ProseMirror decoding.
 const pending=[{value:packet.slice,depth:0}];let count=0
 while(pending.length){const{value,depth}=pending.pop()!;if(depth>256||++count>200000)throw invalid();if(value&&typeof value==='object')for(const child of Object.values(value))pending.push({value:child,depth:depth+1})}
 const raw=[...(packet.slice.content??[])];let nodes=0
 while(raw.length){const node=raw.pop();if(!node||typeof node!=='object'||Array.isArray(node)||++nodes>limits.nodes||Object.keys(node).some(key=>!['type','attrs','content','marks','text'].includes(key)))throw invalid()
  const type=schema.nodes[node.type];if(!type||node.attrs&&(typeof node.attrs!=='object'||Array.isArray(node.attrs)||Object.keys(node.attrs).some(key=>!Object.hasOwn(type.spec.attrs??{},key))))throw invalid()
  if(node.content!==undefined&&!Array.isArray(node.content)||node.marks!==undefined&&!Array.isArray(node.marks))throw invalid()
  for(const mark of node.marks??[]){const type=schema.marks[mark?.type];if(!type||Object.keys(mark).some(key=>!['type','attrs'].includes(key))||mark.attrs&&(typeof mark.attrs!=='object'||Array.isArray(mark.attrs)||Object.keys(mark.attrs).some(key=>!Object.hasOwn(type.spec.attrs??{},key))))throw invalid()}
  raw.push(...node.content??[])
 }
 const slice=Slice.fromJSON(schema,packet.slice);if(!hasBody(slice.content))throw invalid()
 return copyInlineContainerSlice(slice,targetSourceId)
}
const withoutId=(value:Record<string,unknown>,key:string)=>{const copy={...value};delete copy[key];return stableExtension(copy)}
function fingerprints(fragment:Fragment){const values:string[]=[];fragment.descendants(node=>{
 if(node.type.name===inlineContainerNodeName)values.push('body:'+withoutId(readInlineContainerPayload(node.attrs.extension),'instanceId'))
 else if(['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(node.type.name))values.push('node:'+withoutId(readExtensionNode(node.attrs.extension),'instanceId'))
 else if(node.type.name==='hcdMention')values.push('mention:'+withoutId(readInlineReference(node.attrs.reference),'mentionId'))
 });return values.sort()}
export function decodeInlineClipboardHtml(html:string,schema:Schema,document:Document,targetSourceId?:string){
 if(bytes(html)>limits.bytes)throw invalid()
 const template=document.createElement('template');template.innerHTML=html
 if(template.content.querySelectorAll('*').length>limits.nodes*8)throw invalid()
 const expected:string[]=[]
 for(const element of template.content.querySelectorAll<HTMLElement>('[data-hcd-inline-container],[data-hcd-inline-payload],[data-hcd-extension-node],[data-hcd-extension],[data-hcd-mention]')){
  if(element.hasAttribute('data-hcd-inline-container')||element.hasAttribute('data-hcd-inline-payload'))expected.push('body:'+withoutId(readInlineContainerElement(element),'instanceId'))
  else if(element.hasAttribute('data-hcd-mention'))expected.push('mention:'+withoutId(readInlineReference(JSON.parse(element.getAttribute('data-hcd-mention')!)),'mentionId'))
  else expected.push('node:'+withoutId(readExtensionElement(element),'instanceId'))
 }
 for(const element of template.content.querySelectorAll('[data-hcd-custom-mark],[data-hcd-custom-marks]'))if(!schema.marks.hcdCustomMark)throw invalid()
 // Reuse the mark parser so fallback CSS cannot masquerade as real formatting.
 const normalized=normalizeCustomMarkHtml(document,template.innerHTML);template.innerHTML=normalized
 const slice=PmParser.fromSchema(schema).parseSlice(template.content)
 if(!hasBody(slice.content)||stableExtension(expected.sort())!==stableExtension(fingerprints(slice.content)))throw invalid()
 return copyInlineContainerSlice(slice,targetSourceId)
}
function sourceAt(state:EditorState){return state.selection.$from.parent.attrs.hcdSourceId??(state.storedMarks??state.selection.$from.marks()).find(mark=>mark.type.name==='hcdSource')?.attrs.nodeId}
/** Reject a fitter that drops/duplicates/merges business occurrences. No shared
 * allocation happens before this exact preview and the normal policy filters. */
export function inlineClipboardTransaction(state:EditorState,slice:Slice){
 validateSlice(slice)
 const identity=(node:PmNode)=>node.type.name==='hcdMention'?node.attrs.reference.mentionId:[inlineContainerNodeName,'hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(node.type.name)?node.attrs.extension.instanceId:undefined
 const expected=new Map<string,PmNode>();slice.content.descendants(node=>{const id=identity(node);if(id){if(expected.has(id))throw invalid();expected.set(id,node)}})
 const tr=state.tr.replaceSelection(slice),found=new Map<string,PmNode>()
 tr.doc.descendants(node=>{const id=identity(node);if(id){if(found.has(id))throw invalid();found.set(id,node)}})
 for(const[id,node]of expected)if(!found.get(id)?.eq(node))throw invalid()
 return tr.setMeta('paste',true).setMeta('uiEvent','paste').scrollIntoView()
}
export function inlineContainerClipboardPlugin(onError:(error:unknown)=>void){
 let plainPaste=false
 const report=(error:unknown)=>onError(error instanceof Error&&error.message==='historyExtensionUnavailable'?error:new Error('inlineContainerClipboardInvalid',{cause:error}))
 const copy=(view:EditorView,event:ClipboardEvent,cut:boolean)=>{
  const original=view.state.selection.content();if(!hasBody(original.content))return false
  try{
   if(!event.clipboardData)throw invalid()
   const copied=encodeInlineClipboard(original),document=view.dom.ownerDocument,wrapper=document.createElement('div'),serializer=view.someProp('clipboardSerializer')??DOMSerializer.fromSchema(view.state.schema)
   wrapper.append(serializer.serializeFragment(copied.slice.content,{document}));event.clipboardData.setData(inlineClipboardMime,copied.json);event.clipboardData.setData('text/html',wrapper.innerHTML);event.clipboardData.setData('text/plain',copied.slice.content.textBetween(0,copied.slice.content.size,'\n',node=>node.type.name==='hcdMention'?referenceText(node.attrs.reference):node.attrs.extension?.fallback.text??''));event.preventDefault()
   if(cut&&view.editable)view.dispatch(view.state.tr.deleteSelection().setMeta('uiEvent','cut').scrollIntoView())
  }catch(error){event.preventDefault();report(error)}return true
 }
 return new Plugin({props:{transformPasted(slice,_view,plain){plainPaste=plain;return slice},handleDOMEvents:{copy:(view,event)=>copy(view,event,false),cut:(view,event)=>copy(view,event,true)},handlePaste(view,event){
  const json=event.clipboardData?.getData(inlineClipboardMime),html=event.clipboardData?.getData('text/html')??''
  const plain=plainPaste;plainPaste=false
  if(plain&&(html||view.state.selection.$from.parent.type.spec.code))return false
  if(!json&&!/data-hcd-inline-(container|payload)/i.test(html))return false
  try{if(!view.editable)throw new Error('historyExtensionUnavailable');const slice=json?decodeInlineClipboard(json,view.state.schema,sourceAt(view.state)):decodeInlineClipboardHtml(html,view.state.schema,view.dom.ownerDocument,sourceAt(view.state));view.dispatch(inlineClipboardTransaction(view.state,slice))}catch(error){report(error)}return true
 }}})
}
