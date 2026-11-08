import {validateNodeResources,validateNodeExports} from './extensionPortable.ts'
import {Node,Extension} from '@tiptap/core'
import {Plugin,PluginKey,type Transaction} from '@tiptap/pm/state'
import type {Node as PmNode} from '@tiptap/pm/model'
import {ySyncPluginKey} from '@tiptap/y-tiptap'
import {translate,type EditorLocale} from './i18n.tsx'
import type {ExtensionNodePayload} from './extensionTypes.ts'
import type {NodeExtensionRegistry} from './extensionRegistry.ts'
export type {ExtensionNodePayload} from './extensionTypes.ts'
function deepFreeze<T>(value:T):Readonly<T>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value)}return value}
const size=(value:string)=>new TextEncoder().encode(value).length
const exact=(value:unknown,names:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...names].sort().join(',')
const scalar=(text:string)=>![...text].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff||n===0xfffe||n===0xffff})
export function readExtensionNode(input:unknown):ExtensionNodePayload{
 const node=input as ExtensionNodePayload
 if(!exact(node,['schemaVersion','instanceId','type','version','display','data','fallback',...(node.schemaVersion==='hcd.extension/2'?Object.keys(node).filter(key=>['resources','contentModel','exports'].includes(key)):[])])||!['hcd.extension/1','hcd.extension/2'].includes(node.schemaVersion)||typeof node.instanceId!=='string'||!/^x_[a-f0-9]{32}$/.test(node.instanceId)||typeof node.type!=='string'||node.type.length>128||!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/.test(node.type)||node.type.startsWith('hcd.')||!Number.isInteger(node.version)||node.version<1||node.version>0xffffffff||!['inline','block'].includes(node.display)||!exact(node.fallback,['text'])||typeof node.fallback.text!=='string'||!node.fallback.text.trim()||size(node.fallback.text)>16384||!scalar(node.fallback.text)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(node.fallback.text)||node.display==='inline'&&/[\n\r\t]/u.test(node.fallback.text)||!node.data||typeof node.data!=='object'||Array.isArray(node.data))throw new Error('unsupportedExtensionNode')
 let remaining=1024
 const parents=new Set<object>()
 const data=(value:unknown,depth:number):void=>{
  if(depth>16||--remaining<0)throw new Error('extensionDataLimit')
  if(value===null||typeof value==='boolean')return
  if(typeof value==='number'){if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)throw new Error('extensionNumberRange');return}
  if(typeof value==='string'){if(!scalar(value))throw new Error('extensionString');return}
  if(typeof value!=='object'||parents.has(value)||!Array.isArray(value)&&![null,Object.prototype].includes(Object.getPrototypeOf(value)))throw new Error('extensionData')
  parents.add(value)
  for(const [key,child]of Object.entries(value)){if(!Array.isArray(value)&&(size(key)>256||!scalar(key)||/[\u0000-\u001f\u007f-\u009f]/u.test(key)||['__proto__','constructor','prototype'].includes(key)))throw new Error('extensionDataKey');data(child,depth+1)}
  parents.delete(value)
 }
 if(node.schemaVersion==='hcd.extension/2'){if(node.resources!==undefined)validateNodeResources(node.resources);if(node.contentModel!==undefined&&(node.contentModel!=='blocks'||node.display!=='block'))throw new Error('extensionContentModel');if(node.exports!==undefined)validateNodeExports(node.exports,node.resources??[],node.display==='inline',!!node.contentModel)}
 data(node.data,0)
 if(size(JSON.stringify(node))>65536)throw new Error('extensionDataLimit')
 const result=structuredClone(node);if(result.resources?.length===0)delete result.resources;if(result.exports&&Object.keys(result.exports).length===0)delete result.exports;for(const snapshot of Object.values(result.exports??{}))for(const block of snapshot.blocks)for(const run of block.runs)if('text'in run)for(const flag of ['bold','italic','underline','strike'] as const)if(run[flag]===false)delete run[flag];return result
}
export function copyExtensionNode(value:unknown){return{...readExtensionNode(value),instanceId:`x_${crypto.randomUUID().replaceAll('-','')}`}}
/** Index identities and positions without serializing potentially large container bodies. */
export function extensionNodeLocations(doc:PmNode){const found=new Map<string,{value:ExtensionNodePayload;position:number}>();doc.descendants((node,position)=>{if(!['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(node.type.name))return;const value=readExtensionNode(node.attrs.extension);if(found.has(value.instanceId))throw new Error('duplicateExtensionIdentity');found.set(value.instanceId,{value,position});return node.type.name==='hcdExtensionContainer'});return found}
export function extensionNodes(doc:PmNode){const found=new Map<string,{value:ExtensionNodePayload;position:number;marks:string;content:string}>();doc.descendants((node,position)=>{if(!['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(node.type.name))return;const value=readExtensionNode(node.attrs.extension);if(found.has(value.instanceId))throw new Error('duplicateExtensionIdentity');found.set(value.instanceId,{value,position,marks:JSON.stringify(node.marks.map(mark=>mark.toJSON())),content:JSON.stringify(node.content.toJSON())});return node.type.name==='hcdExtensionContainer'});return found}
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
/** Source text identities are internal receipts, not business content. Keep all
 * attrs, visible marks, text and descendants exact while ignoring only this
 * one nonvisual mark. Callers separately authorize a core repair transaction. */
export function sameNodeExceptSourceMarks(before:PmNode,after:PmNode):boolean{
 if(before.eq(after))return true
 if(before.type!==after.type||before.text!==after.text||stable(before.attrs)!==stable(after.attrs)||before.childCount!==after.childCount)return false
 const left=before.marks.filter(mark=>mark.type.name!=='hcdSource'),right=after.marks.filter(mark=>mark.type.name!=='hcdSource')
 if(left.length!==right.length||left.some((mark,index)=>!mark.eq(right[index])))return false
 for(let index=0;index<before.childCount;index++)if(!sameNodeExceptSourceMarks(before.child(index),after.child(index)))return false
 return true
}
const migrationPermit=new PluginKey('hcd-node-migration')
const registryPolicy=new PluginKey<()=>NodeExtensionRegistry|undefined>('hcd-node-edit-policy')
/** Resolve the current registration on every decision, including staged commits. */
export function extensionRegistryForState(state:import('@tiptap/pm/state').EditorState){return registryPolicy.getState(state)?.()}
export function authorizeNodeMigration(tr:Transaction,registry:NodeExtensionRegistry,before:ExtensionNodePayload,after:ExtensionNodePayload){
 const preview=registry.previewMigration(before)
 if(!preview||stable(preview.after)!==stable(after))throw new Error('extensionChanged')
 tr.setMeta(migrationPermit,{registry,before:preview.before,after:preview.after})
}
/** Default reader knows the envelope, not the business codec. Unknown data is
 * retained, and ordinary local transactions cannot alter/remove its atom. */
export function readExtensionElement(element:HTMLElement){const value=readExtensionNode(JSON.parse(element.getAttribute('data-hcd-extension-node')??element.getAttribute('data-hcd-extension')??''));if(value.contentModel==='blocks'){if(element.tagName!=='DIV'&&element.tagName!=='SECTION')throw new Error('extensionHtmlMismatch');return value}if(element.textContent!==value.fallback.text||!(value.display==='inline'?['SPAN']:['DIV','P']).includes(element.tagName))throw new Error('extensionHtmlMismatch');return value}
export function extensionPreservationPlugin(onUnsupportedPaste:()=>void=()=>{},registry:()=>NodeExtensionRegistry|undefined=()=>undefined){let plainPaste=false;return new Plugin({key:registryPolicy,state:{init:()=>registry,apply:(_tr,value)=>value},props:{transformPasted:(slice,_view,plain)=>{plainPaste=plain;return slice},handlePaste:(view,event)=>{
 const html=event.clipboardData?.getData('text/html')??''
 const plain=plainPaste;plainPaste=false;if(plain&&html)return false
 if(!view.state.schema.nodes.hcdExtensionInlineContainer&&(event.clipboardData?.getData('application/x-hcd-inline-slice+json')||/data-hcd-inline-(container|payload)/i.test(html))){onUnsupportedPaste();return true}
 if(!html.includes('data-hcd-extension'))return false
 try{const template=view.dom.ownerDocument.createElement('template');template.innerHTML=html;for(const element of template.content.querySelectorAll<HTMLElement>('[data-hcd-extension-node],[data-hcd-extension]'))readExtensionElement(element);return false}catch{onUnsupportedPaste();return true}
}},filterTransaction:(tr,state)=>{
 if(!tr.docChanged||tr.getMeta(ySyncPluginKey)?.isChangeOrigin)return true
 try{const before=extensionNodes(state.doc),after=extensionNodes(tr.doc),permit=tr.getMeta(migrationPermit);for(const [id,old]of before){const next=after.get(id),sourceRepair=tr.getMeta('hcd-source-defaults')===true&&!!next&&sameNodeExceptSourceMarks(state.doc.nodeAt(old.position)!,tr.doc.nodeAt(next.position)!);if(next&&stable(old.value)===stable(next.value)&&(old.marks===next.marks||sourceRepair)){if(old.value.contentModel==='blocks'&&!registry()?.resolve(old.value)&&old.content!==next.content&&!sourceRepair)return false;continue;}if(next&&permit?.registry===registry()&&old.marks===next.marks&&stable(permit.before)===stable(old.value)&&stable(permit.after)===stable(next.value)&&stable(registry()?.previewMigration(old.value)?.after)===stable(next.value))continue;const codec=registry()?.resolve(old.value);if(!codec||next&&(next.value.type!==old.value.type||next.value.version!==old.value.version||next.value.display!==old.value.display||old.marks!==next.marks||!registry()?.resolve(next.value)))return false}return true}catch{return false}
}})}
export const PreserveExtensionNodes=Extension.create({name:'hcdExtensionPreservation',addOptions(){return{onUnsupportedPaste:()=>{},registry:()=>undefined as NodeExtensionRegistry|undefined}},addProseMirrorPlugins(){return[extensionPreservationPlugin(this.options.onUnsupportedPaste,this.options.registry)]}})
function extensionAtom(display:'inline'|'block'){
 return Node.create({addOptions(){return{registry:()=>undefined as NodeExtensionRegistry|undefined}},name:display==='inline'?'hcdExtensionInline':'hcdExtensionBlock',inline:display==='inline',group:display,atom:true,selectable:true,
  extendNodeSchema(extension){return extension.name===(display==='inline'?'hcdExtensionInline':'hcdExtensionBlock')?{leafText:(node:PmNode)=>readExtensionNode(node.attrs.extension).fallback.text}:{}},
  addAttributes(){return{extension:{default:null,validate:(value:unknown)=>{if(readExtensionNode(value).display!==display)throw new Error('extensionDisplay')},renderHTML:()=>({})},...(display==='block'?{fallbackInline:{default:null,renderHTML:()=>({})}}:{})}},
  parseHTML(){const tags=display==='inline'?['span[data-hcd-extension-node]','span[data-hcd-extension]']:['div[data-hcd-extension-node]','div[data-hcd-extension]','p[data-hcd-extension]'];return tags.map(tag=>({tag,priority:100,getAttrs:(element:HTMLElement)=>{try{const value=readExtensionElement(element);return value.display===display&&!value.contentModel?{extension:copyExtensionNode(value)}:false}catch{return false}}}))},
  renderHTML({node}){const value=readExtensionNode(node.attrs.extension);return[display==='inline'?'span':'div',{'data-hcd-extension-node':JSON.stringify(value),contenteditable:'false',class:`hcd-extension-${display}`},value.fallback.text]},
  addNodeView(){return({node:initial,editor})=>{
   const registry=this.options.registry;const dom=document.createElement(display==='inline'?'span':'div');dom.className=`hcd-extension-${display}`;dom.contentEditable='false';dom.tabIndex=0;dom.setAttribute('role','group');dom.setAttribute('aria-readonly','true');let current=initial,cleanup:(()=>void)|undefined,lastEditable=editor.isEditable
   const paint=()=>{try{cleanup?.()}catch(error){registry()?.error(error)}cleanup=undefined;const value=readExtensionNode(current.attrs.extension),locale=(editor.storage as unknown as {hcdIdentity?:{locale:EditorLocale}}).hcdIdentity?.locale||'en-US',codec=registry()?.resolve(value);lastEditable=editor.isEditable;dom.replaceChildren();dom.textContent=value.fallback.text;dom.title=codec?value.fallback.text:translate(locale,'extensionUnavailable',{type:value.type,version:value.version});dom.setAttribute('aria-readonly',String(!codec||!editor.isEditable));dom.setAttribute('aria-label',`${value.fallback.text} · ${dom.title}`);if(codec?.mountView){try{const mounted=codec.mountView(dom,{node:deepFreeze(value),locale,readOnly:!editor.isEditable});if(mounted!==undefined&&typeof mounted!=='function')throw new Error('nodeExtensionViewCleanup');cleanup=mounted}catch(error){dom.textContent=value.fallback.text;registry()?.error(error)}}}
   const update=({transaction}:{transaction:Transaction})=>{if(transaction.getMeta('hcd-ui-locale')||transaction.getMeta('hcd-node-registry')||lastEditable!==editor.isEditable)paint()};editor.on('transaction',update);paint()
   return{dom,update(node){if(node.type!==initial.type)return false;current=node;paint();return true},destroy(){editor.off('transaction',update);try{cleanup?.()}catch(error){registry()?.error(error)}}}
  }}
 })
}
export const HcdExtensionInline=extensionAtom('inline'),HcdExtensionBlock=extensionAtom('block')

/** One permanent collaborative subtree; rich text is never duplicated in data. */
export const HcdExtensionContainer=Node.create({
 name:'hcdExtensionContainer',group:'block',content:'block+',defining:true,isolating:true,selectable:true,
 addOptions(){return{registry:()=>undefined as NodeExtensionRegistry|undefined}},
 addAttributes(){return{extension:{default:null,validate:(v:unknown)=>{if(readExtensionNode(v).contentModel!=='blocks')throw new Error('extensionContentModel')},renderHTML:()=>({})}}},
 parseHTML(){return ['div[data-hcd-extension-node]','div[data-hcd-extension]'].map(tag=>({tag,priority:110,contentElement:(element:HTMLElement)=>element.querySelector('[data-hcd-extension-content]')??element,getAttrs:(element:HTMLElement)=>{try{const value=readExtensionElement(element);return value.contentModel==='blocks'?{extension:copyExtensionNode(value)}:false}catch{return false}}}))},
 renderHTML({node}){const value=readExtensionNode(node.attrs.extension);return['div',{'data-hcd-extension-node':JSON.stringify(value),class:'hcd-extension-container'},['div',{'data-hcd-extension-title':'',contenteditable:'false'},value.fallback.text],['div',{'data-hcd-extension-content':''},0]]},
 addNodeView(){return({node:initial,editor,getPos})=>{
  const dom=document.createElement('section'),label=document.createElement('button'),contentDOM=document.createElement('div');dom.className='hcd-extension-container';label.type='button';label.contentEditable='false';label.className='hcd-extension-container-title';contentDOM.className='hcd-extension-container-content';dom.append(label,contentDOM);let current=initial,lastEditable=editor.isEditable
  const select=()=>{const pos=getPos();if(typeof pos==='number')editor.chain().focus().setNodeSelection(pos).run()};label.addEventListener('click',select)
  const paint=()=>{const value=readExtensionNode(current.attrs.extension),known=!!this.options.registry()?.resolve(value);lastEditable=editor.isEditable;if(label.textContent!==value.fallback.text)label.textContent=value.fallback.text;const editable=String(known&&editor.isEditable);if(contentDOM.contentEditable!==editable)contentDOM.contentEditable=editable;const encoded=JSON.stringify(value);if(dom.getAttribute('data-hcd-extension-node')!==encoded)dom.setAttribute('data-hcd-extension-node',encoded);dom.setAttribute('aria-readonly',String(!known||!editor.isEditable));dom.classList.toggle('hcd-extension-unavailable',!known)}
  const update=({transaction}:{transaction:Transaction})=>{if(transaction.getMeta('hcd-node-registry')||transaction.getMeta('hcd-ui-locale')||lastEditable!==editor.isEditable)paint()};editor.on('transaction',update);paint()
  return{dom,contentDOM,update(node){if(node.type!==initial.type)return false;current=node;paint();return true},stopEvent:event=>label.contains(event.target as globalThis.Node),ignoreMutation:mutation=>label.contains(mutation.target)||mutation.type==='attributes'&&(mutation.target===dom||mutation.target===contentDOM),destroy(){editor.off('transaction',update);label.removeEventListener('click',select)}}
 }},
})
