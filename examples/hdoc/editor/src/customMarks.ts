import {Mark} from '@tiptap/core'
import {Plugin,type Transaction} from '@tiptap/pm/state'
import {Decoration,DecorationSet} from '@tiptap/pm/view'
import type {Node as PmNode,Mark as PmMark} from '@tiptap/pm/model'
import {Mark as PmMarkSet,DOMSerializer,type DOMOutputSpec} from '@tiptap/pm/model'
import {ySyncPluginKey} from '@tiptap/y-tiptap'
import {readExtensionNode} from './extensionNode.ts'
import type {EditorCommand} from './commands/types.ts'
import {translate,type EditorLocale} from './i18n.tsx'

import type {CustomMarkPayload,CustomMarkDefinition} from './customMarkTypes.js'
export type {CustomMarkPayload,CustomMarkDefinition,CustomMarkStyle} from './customMarkTypes.js'
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
const exact=(value:unknown,keys:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',')
function frozen<T>(value:T):Readonly<T>{const copy=structuredClone(value);const freeze=(v:unknown)=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}};freeze(copy);return copy}
/** Text is owned by the document. A mark never carries replacement text or executable HTML. */
export function readCustomMark(input:unknown):CustomMarkPayload{
 const value=input as CustomMarkPayload
 if(!exact(value,['schemaVersion','type','version','data','fallback'])||value.schemaVersion!=='hcd.mark/1'||!exact(value.fallback,['label','style'])||typeof value.fallback.label!=='string'||new TextEncoder().encode(value.fallback.label).length>256||!value.fallback.style||typeof value.fallback.style!=='object'||Array.isArray(value.fallback.style))throw new Error('unsupportedCustomMark')
 readExtensionNode({schemaVersion:'hcd.extension/1',instanceId:'x_'+'0'.repeat(32),type:value.type,version:value.version,display:'inline',data:value.data,fallback:{text:value.fallback.label}})
 for(const[key,item]of Object.entries(value.fallback.style))if(['bold','italic','underline','strike'].includes(key)?item!==true:!['textColor','backgroundColor'].includes(key)||typeof item!=='string'||!/^#[a-f0-9]{6}$/.test(item))throw new Error('unsupportedCustomMarkStyle')
 if(new TextEncoder().encode(JSON.stringify(value)).length>65536)throw new Error('customMarkLimit')
 return structuredClone(value)
}
export function readCustomMarks(input:unknown):CustomMarkPayload[]{
 if(!Array.isArray(input)||input.length>8)throw new Error('customMarkLimit')
 const values=input.map(readCustomMark).sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:0)
 if(new Set(values.map(value=>value.type)).size!==values.length)throw new Error('duplicateCustomMarkType')
 return values
}
export function customMarkCss(value:CustomMarkPayload){const s=value.fallback.style;return[s.bold?'font-weight:700':'',s.italic?'font-style:italic':'',s.underline||s.strike?`text-decoration:${[s.underline?'underline':'',s.strike?'line-through':''].filter(Boolean).join(' ')}`:'',s.textColor?`color:${s.textColor}`:'',s.backgroundColor?`background-color:${s.backgroundColor}`:''].filter(Boolean).join(';')}
function customMarkHtml(value:CustomMarkPayload,display:boolean):DOMOutputSpec{
 const css=customMarkCss(value)
 return['span',{'data-hcd-custom-mark':JSON.stringify(value),title:value.fallback.label,...(display?{class:'hcd-custom-text-mark'}:{}),style:display?css.replace(/(^|;)(font-weight|font-style|text-decoration|color|background-color):/g,'$1--hcd-mark-$2:'):css},0]
}
/** Resolve inert HTML metadata before the editor parser can flatten it. */
export function customMarkHtmlScope(tag:string,attributes:Record<string,string>,inherited:readonly CustomMarkPayload[]){
 const single=attributes['data-hcd-custom-mark'],plural=attributes['data-hcd-custom-marks'],style=attributes['data-hcd-custom-mark-style'],recognized=single!==undefined||plural!==undefined||style!==undefined
 if(!recognized)return{marks:[...inherited],singular:false}
 if(tag.toLowerCase()!=='span'||single!==undefined&&plural!==undefined||single===undefined&&style!==undefined)throw new Error('unsupportedCustomMark')
 if(single!==undefined){
  if(single.length>65536)throw new Error('customMarkLimit')
  const value=readCustomMark(JSON.parse(single)),marks=readCustomMarks([...inherited.filter(mark=>mark.type!==value.type),value]);return{marks,singular:true}
 }
 if(plural!.length>8*65536+16)throw new Error('customMarkLimit')
 const raw=JSON.parse(plural!),marks=readCustomMarks(raw)
 if(stable(raw)!==stable(marks)||inherited.length&&stable(inherited)!==stable(marks))throw new Error('unsupportedCustomMark')
 return{marks,singular:false}
}
/** Rebuild marks on text leaves, preserving ordinary inner formatting. Fallback
 * CSS must not be parsed a second time as ordinary bold/color marks. */
export function normalizeCustomMarkHtml(document:Document,html:string){
 if(html.length>64*1024*1024)throw new Error('customMarkLimit')
 const template=document.createElement('template');template.innerHTML=html
 let count=0,budget=html.length
 const visit=(node:Node,inherited:readonly CustomMarkPayload[],depth:number,protectedContent=false)=>{
  if(++count>1000000||depth>256)throw new Error('customMarkLimit')
  if(node.nodeType===3){
   if(!node.textContent||!inherited.length)return
   if(protectedContent)throw new Error('unsupportedCustomMark')
   const values=inherited.map(mark=>JSON.stringify(mark));budget+=values.reduce((size,value)=>size+value.length+64,0)
   if(budget>64*1024*1024)throw new Error('customMarkLimit')
   let wrapped:Node=node.cloneNode(true)
   for(const value of values.reverse()){const span=document.createElement('span');span.setAttribute('data-hcd-custom-mark',value);span.append(wrapped);wrapped=span}
   node.parentNode!.replaceChild(wrapped,node);return
  }
  if(node.nodeType!==1)return
  const element=node as HTMLElement,attributes:Record<string,string>={}
  for(const name of ['data-hcd-custom-mark','data-hcd-custom-marks','data-hcd-custom-mark-style']){const value=element.getAttribute(name);if(value!==null)attributes[name]=value}
  const scope=customMarkHtmlScope(element.tagName,attributes,inherited)
  if(scope.singular)element.removeAttribute('style')
  for(const name of Object.keys(attributes))element.removeAttribute(name)
  for(const name of ['data-hcd-source-text','data-hcd-id','data-hcd-node-hash','data-hcd-block-id'])element.removeAttribute(name)
  const protectedChild=protectedContent||element.tagName==='PRE'||element.hasAttribute('data-hcd-extension')||element.hasAttribute('data-hcd-reference')
  for(const child of Array.from(element.childNodes))visit(child,scope.marks,depth+1,protectedChild)
 }
 for(const child of Array.from(template.content.childNodes))visit(child,[],0)
 return template.innerHTML
}
export const customMarkKey=(type:string)=>'hcdCustomMark:'+type
export function customMarkAttributes(marks:readonly PmMark[]){return Object.fromEntries(marks.map(mark=>mark.type.name==='hcdCustomMark'?[customMarkKey(readCustomMark(mark.attrs.value).type),{value:readCustomMark(mark.attrs.value)}]:[mark.type.name,{...mark.attrs}]))}
export function customMarkAttribute(type:string,attrs:unknown){const value=readCustomMark((attrs as {value:unknown})?.value);if(!exact(attrs,['value'])||type!==customMarkKey(value.type))throw new Error('unsupportedCustomMark');return{type:'hcdCustomMark',attrs:{value}}}

export class CustomMarkRegistry{
 private entries=new Map<string,{definition:CustomMarkDefinition;owner:symbol}>()
 constructor(definitions:readonly CustomMarkDefinition[]=[]){this.add(definitions)}
 private build(definition:CustomMarkDefinition,data:Record<string,unknown>){
  readCustomMark({schemaVersion:'hcd.mark/1',type:definition.type,version:definition.version,data,fallback:{label:'validation',style:{}}})
  const safe=frozen(data);if(definition.validate(safe)!==true)throw new Error('customMarkInvalidData')
  const first=readCustomMark({schemaVersion:'hcd.mark/1',type:definition.type,version:definition.version,data:safe,fallback:definition.fallback(safe)}),second=readCustomMark({...first,fallback:definition.fallback(frozen(data))})
  if(stable(first)!==stable(second))throw new Error('customMarkNonDeterministic')
  return first
 }
 private add(definitions:readonly CustomMarkDefinition[]){
  if(this.entries.size+definitions.length>64)throw new Error('customMarkLimit')
  const next=new Map(this.entries),owner=Symbol('mark registration')
  for(const input of definitions){
   if(!input||typeof input.type!=='string'||input.type.length>116||next.has(input.type)||typeof input.validate!=='function'||typeof input.fallback!=='function'||!(typeof input.label==='string'?!!input.label.trim()&&input.label.length<=256:!!input.label&&typeof input.label==='object'&&!Array.isArray(input.label)&&Object.keys(input.label).length>0&&Object.entries(input.label).every(([key,value])=>key.length<=32&&typeof value==='string'&&!!value.trim()&&value.length<=256))||input.icon!==undefined&&(typeof input.icon!=='string'||input.icon.length>32))throw new Error('customMarkDefinition')
   const definition=Object.freeze({...input,label:frozen(input.label),defaultData:frozen(input.defaultData) as Record<string,unknown>});this.build(definition,definition.defaultData);next.set(input.type,{definition,owner})
  }
  this.entries=next;return owner
 }
 register(definitions:readonly CustomMarkDefinition[]){const owner=this.add(definitions);return()=>{for(const[type,entry]of this.entries)if(entry.owner===owner)this.entries.delete(type)}}
 list(){return Object.freeze([...this.entries.values()].map(({definition:{type,version,label}})=>Object.freeze({type,version,label})))}
 create(type:string,data?:Record<string,unknown>){const entry=this.entries.get(type);if(!entry)throw new Error('customMarkUnavailable');return this.build(entry.definition,data??structuredClone(entry.definition.defaultData))}
 resolve(input:CustomMarkPayload){const entry=this.entries.get(input.type);if(!entry||entry.definition.version!==input.version)return false;try{return stable(this.build(entry.definition,input.data))===stable(readCustomMark(input))}catch{return false}}
 commands():EditorCommand[]{return[...this.entries.values()].map(({definition})=>({id:`mark.toggle.${definition.type}`,label:definition.label,icon:definition.icon??'A',profiles:['flow'],surfaces:['ribbon','context','bubble','palette'],tabs:['insert'],group:'format',requires:['mark.toggle'],isActive:context=>context.selection.customMarkTypes?.includes(definition.type)===true,execute:({commands})=>commands.run('mark.toggle',{type:definition.type})}))}
}

const withoutSource=(value:any):any=>{
 if(Array.isArray(value)){const nodes:any[]=[];for(const input of value){const node=withoutSource(input),last=nodes.at(-1);if(node.type==='text'&&last?.type==='text'&&stable({...last,text:''})===stable({...node,text:''}))last.text+=node.text;else nodes.push(node)}return nodes}
 if(!value||typeof value!=='object')return value
 const result={...value};if(result.marks){result.marks=result.marks.filter((mark:any)=>mark.type!=='hcdSource');if(!result.marks.length)delete result.marks}if(result.content)result.content=withoutSource(result.content);return result
}
export function customMarkHistoryGuard(before:PmNode,registry?:CustomMarkRegistry){
 const protectedMarks=(doc:PmNode)=>{const nodes:any[]=[];doc.descendants(node=>{if(node.isText&&node.marks.some(mark=>mark.type.name==='hcdCustomMark'&&!registry?.resolve(readCustomMark(mark.attrs.value))))nodes.push(node.toJSON())});return withoutSource(nodes)}
 const expected=protectedMarks(before);if(!expected.length)return undefined
 return(after:PmNode)=>{if(stable(expected)!==stable(protectedMarks(after)))throw new Error('historyExtensionUnavailable')}
}
/** Missing business codecs protect existing marked content, including programmatic edits. */
export function customMarkPreservationPlugin(registry:()=>CustomMarkRegistry|undefined,onUnsupportedPaste:()=>void=()=>{},enabled:()=>boolean=()=>true,locale:()=>EditorLocale=()=>'en-US'){return new Plugin({filterTransaction:(tr,state)=>{
 if(!tr.docChanged||tr.getMeta(ySyncPluginKey)?.isChangeOrigin)return true
 try{let valid=true;tr.doc.descendants(node=>{const values=node.marks.filter(mark=>mark.type.name==='hcdCustomMark').map(mark=>mark.attrs.value);if(values.length){if(!enabled()||!node.isText)valid=false;readCustomMarks(values)}});if(!valid)return false}catch{return false}
 let valid=true
 state.doc.descendants((node,position)=>{if(!valid||!node.isText||!node.marks.some(mark=>mark.type.name==='hcdCustomMark'&&!registry()?.resolve(readCustomMark(mark.attrs.value))))return;const from=tr.mapping.map(position,1),to=tr.mapping.map(position+node.nodeSize,-1);if(to-from!==node.nodeSize||stable(withoutSource(state.doc.slice(position,position+node.nodeSize).content.toJSON()))!==stable(withoutSource(tr.doc.slice(from,to).content.toJSON())))valid=false})
 return valid
},props:{transformPastedHTML(html,view){if(!/data-hcd-custom-mark/i.test(html))return html;try{if(!enabled())throw new Error('unsupportedCustomMark');return normalizeCustomMarkHtml(view.dom.ownerDocument,html)}catch{return ''}},handlePaste(view,event){const html=event.clipboardData?.getData('text/html')??'';if(!/data-hcd-custom-mark/i.test(html))return false;try{if(!enabled())throw new Error('unsupportedCustomMark');normalizeCustomMarkHtml(view.dom.ownerDocument,html);return false}catch{onUnsupportedPaste();return true}},decorations(state){const decorations:Decoration[]=[];state.doc.descendants((node,position)=>{if(!node.isText)return;const unknown=node.marks.filter(mark=>mark.type.name==='hcdCustomMark'&&!registry()?.resolve(readCustomMark(mark.attrs.value)));if(unknown.length)decorations.push(Decoration.inline(position,position+node.nodeSize,{contenteditable:'false','aria-readonly':'true',class:'hcd-custom-mark-unavailable',title:unknown.map(mark=>{const value=readCustomMark(mark.attrs.value);return `${value.fallback.label} · ${translate(locale(),'customMarkReadOnly')}`}).join(' · ')}))});return DecorationSet.create(state.doc,decorations)}}})}

export const HcdCustomMark=Mark.create({name:'hcdCustomMark',priority:1100,excludes:'',inclusive:false,addOptions(){return{registry:()=>undefined as CustomMarkRegistry|undefined,onUnsupportedPaste:()=>{},enabled:()=>true}},addProseMirrorPlugins(){
 const serializer=DOMSerializer.fromSchema(this.editor.schema),clipboardSerializer=new DOMSerializer(serializer.nodes,{...serializer.marks,hcdCustomMark:mark=>customMarkHtml(readCustomMark(mark.attrs.value),false)})
 return[customMarkPreservationPlugin(this.options.registry,this.options.onUnsupportedPaste,this.options.enabled,()=>((this.editor.storage as unknown as {hcdIdentity?:{locale:EditorLocale}}).hcdIdentity?.locale??'en-US')),new Plugin({props:{clipboardSerializer}})]
},addAttributes(){return{value:{default:null,validate:readCustomMark,renderHTML:()=>({})}}},parseHTML(){return[{tag:'span[data-hcd-custom-mark]',getAttrs:(element:HTMLElement)=>{try{return{value:readCustomMark(JSON.parse(element.getAttribute('data-hcd-custom-mark')!))}}catch{return false}}}]},renderHTML({mark}){return customMarkHtml(readCustomMark(mark.attrs.value),true)}})
export function unavailableCustomMark(doc:PmNode,from:number,to:number,registry?:CustomMarkRegistry){let found=false;doc.nodesBetween(from,to,node=>{if(node.marks.some(mark=>mark.type.name==='hcdCustomMark'&&!registry?.resolve(readCustomMark(mark.attrs.value))))found=true;return!found});return found}
export function selectedCustomMarkTypes(doc:PmNode,from:number,to:number){let common:Set<string>|undefined;doc.nodesBetween(from,to,node=>{if(!node.isText)return;const types=new Set(node.marks.filter(mark=>mark.type.name==='hcdCustomMark').map(mark=>readCustomMark(mark.attrs.value).type));common=common?new Set([...common].filter(type=>types.has(type))):types});return[...(common??[])].sort()}
/** Formatting commands share normal transaction/history/collaboration paths. */
export function applyCustomMark(tr:Transaction,value:CustomMarkPayload,remove=false){
 const mark=tr.doc.type.schema.marks.hcdCustomMark.create({value:readCustomMark(value)}),{from,to,empty}=tr.selection
 const nextMarks=(current:readonly PmMark[])=>{const ordinary=current.filter(old=>old.type!==mark.type),custom=current.filter(old=>old.type===mark.type&&readCustomMark(old.attrs.value).type!==value.type);if(!remove)custom.push(mark);custom.sort((a,b)=>a.attrs.value.type<b.attrs.value.type?-1:a.attrs.value.type>b.attrs.value.type?1:0);readCustomMarks(custom.map(mark=>mark.attrs.value));return PmMarkSet.setFrom([...ordinary,...custom])}
 if(empty){if(!tr.selection.$from.parent.type.allowsMarkType(mark.type))return false;const current=tr.storedMarks??tr.selection.$from.marks(),marks=nextMarks(current);if(PmMarkSet.sameSet(current,marks))return false;tr.setStoredMarks(marks);return true}
 const plans:Array<{from:number;to:number;before:readonly PmMark[];after:readonly PmMark[]}>=[]
 tr.doc.nodesBetween(from,to,(node,position)=>{if(!node.isText||!tr.doc.resolve(position).parent.type.allowsMarkType(mark.type))return;const after=nextMarks(node.marks);if(!PmMarkSet.sameSet(node.marks,after))plans.push({from:Math.max(from,position),to:Math.min(to,position+node.nodeSize),before:node.marks,after})})
 let changed=false
 for(const plan of plans){for(const old of plan.before)if(old.type===mark.type)tr.removeMark(plan.from,plan.to,old);for(const next of plan.after)if(next.type===mark.type)tr.addMark(plan.from,plan.to,next);changed=true}
 return changed&&tr.docChanged
}
