import {useEffect,useRef,useState} from 'react'
import type {Editor} from '@tiptap/core'
import {Plugin,PluginKey} from '@tiptap/pm/state'
import type {Session} from './api.ts'
import {readInlineReference,type InlineReference} from './inlineReference.ts'
import {referencePosition,referenceTargetKey} from './referenceIndex.ts'
import {useReferenceResolution} from './useReferenceResolution.ts'
import {ReferenceProfile} from './ReferenceProfile.tsx'
import {useI18n} from './i18n.tsx'
const inspectorKey=new PluginKey('hcd-mention-inspector')
export function useMentionInspector(editor:Editor|null,session:Session,disabled:boolean,onOpenList:(mentionId:string)=>void){
 const [reference,setReference]=useState<InlineReference|null>(null),[version,render]=useState(0),latest=useRef({disabled});latest.current={disabled}
 const open=(value:InlineReference)=>{if(!editor||editor.isDestroyed||latest.current.disabled)return;try{if(referencePosition(editor.state.doc,value)!==null)setReference(readInlineReference(value))}catch{/* Ambiguous identity cannot open a different profile. */}}
 const openRef=useRef(open);openRef.current=open
 useEffect(()=>{
  setReference(null);if(!editor||editor.isDestroyed)return
  editor.registerPlugin(new Plugin({key:inspectorKey,props:{handleClickOn:(_view,_pos,node,_nodePos,event,direct)=>{if(!direct||node.type.name!=='hcdMention'||latest.current.disabled)return false;event.preventDefault();openRef.current(readInlineReference(node.attrs.reference));return true},handleDOMEvents:{keydown:(_view,event)=>{const element=event.target instanceof Element?event.target.closest('[data-hcd-mention]'):null;if(!element||!['Enter',' '].includes(event.key)||event.isComposing||latest.current.disabled)return false;try{const value=readInlineReference(JSON.parse(element.getAttribute('data-hcd-mention')||''));event.preventDefault();openRef.current(value);return true}catch{return false}}}}}))
  const update=({transaction}:{transaction:{docChanged:boolean}})=>{if(transaction.docChanged)render(n=>n+1)};editor.on('transaction',update)
  return()=>{editor.off('transaction',update);if(!editor.isDestroyed)editor.unregisterPlugin(inspectorKey)}
 },[editor])
 useEffect(()=>{if(disabled)setReference(null)},[disabled])
 let currentReference:InlineReference|null=null;try{if(!disabled&&reference&&editor&&!editor.isDestroyed){const position=referencePosition(editor.state.doc,reference);if(position!==null)currentReference=readInlineReference(editor.state.doc.nodeAt(position)?.attrs.reference)}}catch{/* Unrenderable live content remains preserved by the binding. */}
 const current=currentReference
 const menu=current&&editor?<MentionInspectorCard key={`${current.mentionId}:${referenceTargetKey(current.target)}`} editor={editor} session={session} reference={current} version={version} onClose={()=>setReference(null)} onOpenList={()=>{setReference(null);onOpenList(current.mentionId)}}/>:null
 return{menu,open,dismiss:()=>setReference(null),active:current!==null}
}
function MentionInspectorCard({editor,session,reference,version,onClose,onOpenList}:{editor:Editor;session:Session;reference:InlineReference;version:number;onClose:()=>void;onOpenList:()=>void}){
 const {t}=useI18n(),resolution=useReferenceResolution(session,[reference.target]),root=useRef<HTMLDivElement>(null),[position,setPosition]=useState<{left:number;top:number;maxHeight:number}|null>(null),close=useRef(onClose);close.current=onClose
 useEffect(()=>{
  let frame=0,closed=false,atom:HTMLElement|null=null
  const update=()=>{frame=0;if(closed||editor.isDestroyed)return;const pos=referencePosition(editor.state.doc,reference);if(pos===null){close.current();return}const node=editor.view.nodeDOM(pos);if(!(node instanceof HTMLElement))return;atom=node;atom.setAttribute('aria-expanded','true');const rect=node.getBoundingClientRect(),viewport=editor.view.dom.closest('.document-scroll')?.getBoundingClientRect(),top=Math.max(0,viewport?.top??0),bottom=Math.min(innerHeight,viewport?.bottom??innerHeight),below=bottom-rect.bottom-8,above=rect.top-top-8,flip=below<220&&above>below,maxHeight=Math.min(310,flip?above:below)
   setPosition(rect.bottom<top||rect.top>bottom||maxHeight<80?null:{left:Math.max(8,Math.min(rect.left,innerWidth-300)),top:flip?rect.top-maxHeight-5:rect.bottom+5,maxHeight})}
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(update)}
  window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);update()
  return()=>{closed=true;cancelAnimationFrame(frame);atom?.setAttribute('aria-expanded','false');window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule)}
 },[editor,reference,version])
 useEffect(()=>{
  const down=(event:PointerEvent)=>{if(event.target instanceof Node&&root.current?.contains(event.target))return;if(event.target instanceof Element&&event.target.closest('[data-hcd-mention]'))return;close.current()}
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopPropagation();close.current();editor.view.focus()}}
  document.addEventListener('pointerdown',down,true);document.addEventListener('keydown',key,true);return()=>{document.removeEventListener('pointerdown',down,true);document.removeEventListener('keydown',key,true)}
 },[editor])
 return position?<div ref={root} role="dialog" aria-label={t('referenceDetails')} className="hcd-mention-inspector" style={position}><div className="panel-head"><h3>{t('referenceDetails')}</h3><button type="button" className="panel-close" aria-label={t('close')} onClick={onClose}>×</button></div><ReferenceProfile reference={reference} resolution={resolution.items.get(referenceTargetKey(reference.target))} status={resolution.status}/><div className="hcd-reference-actions"><button type="button" onClick={onOpenList}>{t('referenceOpenList')}</button><button type="button" onClick={resolution.refresh}>{t('referenceRefresh')}</button></div></div>:null
}
