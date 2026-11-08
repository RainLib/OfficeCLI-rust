import type {Awareness} from 'y-protocols/awareness'
import {Plugin,PluginKey} from '@tiptap/pm/state'
import {Decoration,DecorationSet,type EditorView} from '@tiptap/pm/view'
import {captureStructureSelection,resolveStructurePoint,validStructureNodePoint,type StructurePoint,type StructureSelection} from './semanticStructureSelection.ts'
import type {StructureBindingStore} from './semanticStructureBinding.ts'
export type StructureUser={id:string;name:string;color:string}
export type StructureCursorContext={sectionId:string;variant:'first'|'default'|'even';paperIndex:number}
export const structureCursorField='hcdStructureCursor'
export const structureCaretKey=new PluginKey('hcd-structure-carets/1')
function selection(input:unknown):Exclude<StructureSelection,{kind:'all'}>|null{
 try{
  if(!input||JSON.stringify(input).length>12_000)return null
  const value=input as StructureSelection
  const point=(point:StructurePoint)=>{
   if(!point||typeof point.key!=='string'||!point.key.length||point.key.length>128||!Number.isSafeInteger(point.offset)||point.offset<0)return false
   if(point.node!==undefined&&!validStructureNodePoint(point.node))return false
   if(point.relative){
    const relative=point.relative,id=(id:any)=>id==null||typeof id==='object'&&Number.isSafeInteger(id.client)&&id.client>=0&&Number.isSafeInteger(id.clock)&&id.clock>=0
    if(!id(relative.type)||!id(relative.item)||relative.tname!=null||relative.assoc!==undefined&&![0,-1,1].includes(relative.assoc))return false
   }
   return true
  }
  if(value.kind==='node'&&point(value.anchor))return value
  if(value.kind==='text'&&point(value.anchor)&&point(value.head))return value
 }catch{/* Untrusted awareness never enters document parsing or content. */}
 return null
}
function user(value:any):StructureUser|null{
 if(!value||typeof value.id!=='string'||typeof value.name!=='string')return null
 return{id:value.id.slice(0,128),name:value.name.trim().slice(0,64)||'User',color:/^#[0-9a-f]{6}$/i.test(value.color??'')?value.color:'#5b8def'}
}
function caret(person:StructureUser){
 const span=document.createElement('span');span.className='collaboration-carets__caret';span.dataset.hcdCollaboratorId=person.id;span.style.borderColor=person.color;span.setAttribute('aria-hidden','true')
 const label=document.createElement('span');label.className='collaboration-carets__label';label.style.backgroundColor=person.color;label.textContent=person.name;span.append(label);return span
}
/** Awareness carries positions only. It cannot resolve personnel, grant access,
 * modify the document, create references or send a reminder. */
export function semanticStructureCarets(store:StructureBindingStore,awareness:Awareness,local:StructureUser,render=caret,regionId?:string,context?:()=>StructureCursorContext|undefined){
 const owner=crypto.randomUUID();let current:EditorView|null=null,closed=false,last=''
 const publish=()=>{
  if(closed||!current)return
  const bookmark=current.hasFocus()&&store.initialized?captureStructureSelection(store,current.state):null
  const scope=context?.(),value=bookmark&&bookmark.kind!=='all'?{version:1,owner,selection:bookmark,...(regionId?{regionId}:{}),...(scope?{context:scope}:{})}:null,signature=JSON.stringify(value)
  if(signature!==last){last=signature;if(value||awareness.getLocalState()?.[structureCursorField]?.owner===owner)awareness.setLocalStateField(structureCursorField,value)}
 }
 return new Plugin({key:structureCaretKey,
  props:{decorations(state){
   try{
    const decorations:Decoration[]=[],states=awareness.getStates()
    for(const [client,value] of states){
     if(client===store.document.clientID)continue
     const person=user(value.user),cursor=value[structureCursorField]
     if(!person||person.id===local.id||!cursor||cursor.version!==1||cursor.regionId!==regionId||[...states].some(([other,entry])=>other<client&&entry.user?.id===person.id))continue
     const bookmark=selection(cursor.selection);if(!bookmark)continue
     const anchor=resolveStructurePoint(store,state.doc,bookmark.anchor);if(anchor===null)continue
     const head=bookmark.kind==='text'?resolveStructurePoint(store,state.doc,bookmark.head):anchor;if(head===null)continue
     if(bookmark.kind==='node'){const node=state.doc.nodeAt(anchor);if(node)decorations.push(Decoration.node(anchor,anchor+node.nodeSize,{class:'hcd-peer-block',style:`outline:2px solid ${person.color}`}))}
     else{
      if(anchor!==head)decorations.push(Decoration.inline(Math.min(anchor,head),Math.max(anchor,head),{style:`background-color:${person.color}33`}))
      const position=state.doc.resolve(head)
      if(position.depth){const from=position.before(position.depth),node=position.parent;decorations.push(Decoration.node(from,from+node.nodeSize,{class:'hcd-peer-active',style:`--hcd-peer-color:${person.color}`}))}
     }
     decorations.push(Decoration.widget(head,()=>render(person),{key:`${client}:${person.name}:${person.color}`,side:1}))
    }
    return DecorationSet.create(state.doc,decorations)
   }catch{return DecorationSet.empty}
  },handleDOMEvents:{focus(){queueMicrotask(publish);return false},blur(){if(current){last='null';if(awareness.getLocalState()?.[structureCursorField]?.owner===owner)awareness.setLocalStateField(structureCursorField,null)}return false}}},
  view(view){
   current=view;closed=false
   const changed=()=>{if(!closed&&current)current.dispatch(current.state.tr.setMeta(structureCaretKey,true))}
   awareness.on('change',changed)
   queueMicrotask(()=>{if(!closed){awareness.setLocalStateField('user',user(local));publish()}})
   return{update(view){current=view;publish()},destroy(){closed=true;current=null;awareness.off('change',changed);if(awareness.getLocalState()?.[structureCursorField]?.owner===owner)awareness.setLocalStateField(structureCursorField,null)}}
  },
 })
}
