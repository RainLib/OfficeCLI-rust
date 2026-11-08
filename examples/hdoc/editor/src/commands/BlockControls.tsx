import {extensionRegistryForState} from '../extensionNode.ts'
import {inlineContainerRegistryForState} from '../inlineContainerPreservation.ts'
import {useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from 'react'
import type {Editor} from '@tiptap/core'
import {NodeSelection,Plugin,PluginKey,TextSelection} from '@tiptap/pm/state'
import {Decoration,DecorationSet} from '@tiptap/pm/view'
import {editorBlockEntries as rootBlocks,selectedRootBlocks,blockTarget,operableBlockEntry,blockDestinations,blockEntryScope,siblingBlockEntries,targetBlockCount,type BlockEntry,type BlockTarget} from './blocks.ts'
import {blockDropEntries,pickBlockDrop,blockEdgeScroll,type BlockDrop,type DropRect} from './blockDrop.ts'
import type {CommandRegistry} from './registry.ts'
import {useI18n} from '../i18n.tsx'
import {isEditorIcon,EditorIcon} from '../EditorIcon.tsx'
const uiKey=new PluginKey<BlockTarget|null>('hcd-block-controls')
function selectionPlugin(){return new Plugin<BlockTarget|null>({key:uiKey,state:{init:()=>null,apply:(tr,range)=>tr.getMeta(uiKey)!==undefined?tr.getMeta(uiKey):tr.docChanged?null:range},props:{decorations:state=>{const range=uiKey.getState(state);return range?DecorationSet.create(state.doc,blockDropEntries(state.doc,range).filter(entry=>entry.from>=range.from&&entry.to<=range.to).map(entry=>Decoration.node(entry.from,entry.to,{class:'hcd-block-selected'}))):null}}})}
type Frame={target:BlockTarget;mode:'operate'|'insert'|'move'}
type Geometry={left:number;top:number;stacked:boolean;menuLeft:number;menuTop:number;menuHeight:number}
export function useBlockControls(editor:Editor|null,registry:CommandRegistry,execute:(id:string,target:BlockTarget,signal?:AbortSignal)=>Promise<boolean>,onTarget:(target:BlockTarget|null)=>void,disabled:boolean){
 const isBlocked=(entry:BlockEntry)=>!editor||editor.isDestroyed||!operableBlockEntry(editor.state.doc,entry,extensionRegistryForState(editor.state),inlineContainerRegistryForState(editor.state))
 const {t}=useI18n(),id=useId(),root=useRef<HTMLDivElement>(null),search=useRef<HTMLInputElement>(null)
 const [,refresh]=useState(0),[hover,setHover]=useState<number|null>(null),[focused,setFocused]=useState(false),[frame,setFrame]=useState<Frame|null>(null),[query,setQuery]=useState(''),[selected,setSelected]=useState(0),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false),[geometry,setGeometry]=useState<Geometry|null>(null),[drop,setDrop]=useState<BlockDrop|null>(null),[dragging,setDragging]=useState(false)
 const pending=useRef(false),cancellation=useRef<AbortController|null>(null),origin=useRef<{from:number;scope:string|null}|null>(null),drag=useRef<{target:BlockTarget;doc:Editor['state']['doc'];entries:BlockEntry[];allowed:number[]}|null>(null),dragGeometry=useRef<Geometry|null>(null),pointer=useRef<{id:number;x:number;y:number;started:boolean;begin:()=>boolean}|null>(null),suppressClick=useRef(false),cancelDrag=useRef<()=>void>(()=>{})
 const latest=useRef({frame,disabled,onTarget,execute,hover});latest.current={frame,disabled,onTarget,execute,hover}
 const roots=useMemo(()=>editor&&!editor.isDestroyed?rootBlocks(editor.state.doc):[],[editor,editor?.state.doc]),selection=useMemo(()=>editor&&!editor.isDestroyed?selectedRootBlocks(editor.state):[],[editor,editor?.state.doc,editor?.state.selection])
 const hovered=roots.find(entry=>entry.from===hover),entry=(dragging&&drag.current?roots.find(entry=>entry.from===drag.current!.target.from):undefined)??hovered??(focused?selection[0]:undefined),targetEntry=frame?roots.find(entry=>entry.from===frame.target.from):entry
 const close=(restore=false)=>{
  cancellation.current?.abort()
  setFrame(null);setQuery('');setFailed(false);latest.current.onTarget(null)
  if(editor&&!editor.isDestroyed){if(uiKey.getState(editor.state))editor.view.dispatch(editor.state.tr.setMeta(uiKey,null).setMeta('addToHistory',false));if(restore)editor.view.focus()}
 }
 const selectRange=(entries:BlockEntry[])=>{
  if(!editor||!entries.length)return
  const doc=editor.state.doc,first=entries[0],last=entries.at(-1)!,selection=entries.length===1?NodeSelection.create(doc,first.from):TextSelection.between(doc.resolve(Math.min(first.from+1,doc.content.size)),doc.resolve(Math.max(first.from,last.to-1)))
  editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta('addToHistory',false))
 }
 const open=(intent:BlockTarget['intent']='operate',extend=false)=>{
  if(!editor||editor.isDestroyed||latest.current.disabled||!entry||isBlocked(entry))return
  let entries=selectedRootBlocks(editor.state)
  const scope=blockEntryScope(editor.state.doc,entry)?.instanceId??null
  if(extend&&origin.current!==null){if(origin.current.scope!==scope)return;const from=Math.min(origin.current.from,entry.from),to=Math.max(origin.current.from,entry.from);entries=siblingBlockEntries(editor.state.doc,entry).filter(block=>block.from>=from&&block.from<=to)}
  else if(!entries.some(block=>block.from===entry.from)||entries.length<2)entries=[entry]
  if(entries.some(block=>isBlocked(block)))return
  origin.current=extend?origin.current:{from:entries[0].from,scope};selectRange(entries)
  const target=blockTarget(editor.state,entries,intent,registry.context().selection.anchor);if(!target)return
  latest.current.onTarget(target);editor.view.dispatch(editor.state.tr.setMeta(uiKey,target).setMeta('addToHistory',false));registry.refresh()
  setQuery('');setSelected(0);setFailed(false);setFrame({target,mode:intent==='operate'?'operate':'insert'})
 }
 const openSelected=()=>{
  if(!editor||editor.isDestroyed||latest.current.disabled)return
  const entries=selectedRootBlocks(editor.state);if(!entries.length||entries.some(block=>isBlocked(block)))return
  selectRange(entries);const target=blockTarget(editor.state,entries,'operate',registry.context().selection.anchor);if(!target)return
  latest.current.onTarget(target);editor.view.dispatch(editor.state.tr.setMeta(uiKey,target).setMeta('addToHistory',false));registry.refresh();setFrame({target,mode:'operate'});setQuery('');setSelected(0);setFailed(false)
 }
 const invoke=async(commandId:string,target=frame?.target)=>{
  if(!target||pending.current)return
  pending.current=true;const controller=new AbortController();cancellation.current=controller;setBusy(true);setFailed(false)
  try{if(await latest.current.execute(commandId,target,controller.signal))close();else if(!controller.signal.aborted)setFailed(true)}finally{pending.current=false;setBusy(false)}
 }
 useEffect(()=>{
  if(!editor||editor.isDestroyed)return
  editor.registerPlugin(selectionPlugin())
  const update=({transaction}:{transaction:Editor['state']['tr']})=>{
   if(transaction.docChanged||transaction.selectionSet){if(latest.current.frame)close();if(transaction.docChanged){if(drag.current)resetDrag();setHover(null)}}
   if(transaction.getMeta('hcd-node-registry')&&drag.current)resetDrag()
   refresh(value=>value+1)
  },focus=()=>setFocused(true),blur=()=>setFocused(false)
  const over=(event:MouseEvent)=>{
   if(drag.current||latest.current.frame||latest.current.disabled)return
   const hit=editor.view.posAtCoords({left:event.clientX,top:event.clientY});if(!hit)return
   const block=rootBlocks(editor.state.doc).filter(block=>hit.pos>=block.from&&hit.pos<block.to).at(-1)
   setHover(block&&!isBlocked(block)?block.from:null)
  }
  const surface=editor.view.dom.closest<HTMLElement>('.document-scroll')??editor.view.dom
  let animation=0,point:{x:number;y:number}|null=null
  const resetDrag=()=>{
   cancelAnimationFrame(animation);animation=0;point=null;drag.current=null;dragGeometry.current=null;pointer.current=null;setDragging(false);setDrop(null);latest.current.onTarget(null)
   if(!editor.isDestroyed&&uiKey.getState(editor.state))editor.view.dispatch(editor.state.tr.setMeta(uiKey,null).setMeta('addToHistory',false))
  }
  cancelDrag.current=resetDrag
  const viewport=():DropRect=>{const rect=surface.getBoundingClientRect();return{left:Math.max(0,rect.left),right:Math.min(innerWidth,rect.right),top:Math.max(0,rect.top),bottom:Math.min(innerHeight,rect.bottom)}}
  const feedback=(at:{x:number;y:number})=>{
   const current=drag.current;if(!current||latest.current.disabled||editor.state.doc!==current.doc)return null
   const canvas=editor.view.dom.getBoundingClientRect(),parent=current.target.scope?editor.view.nodeDOM(current.target.scope.from):null,container=parent instanceof Element?parent.getBoundingClientRect():canvas,view=viewport(),region={left:container.left-56,right:container.right+24,top:container.top,bottom:container.bottom}
   // Gutter coordinates can hit the outer container before its child. Probe
   // inside the sibling column, then use the actual pointer for drop geometry.
   const hit=editor.view.posAtCoords({left:(container.left+container.right)/2,top:Math.max(canvas.top+1,Math.min(at.y,canvas.bottom-1))})
   let index=hit?current.entries.findIndex(entry=>hit.pos>=entry.from&&hit.pos<entry.to):-1
   if(index<0)index=hit&&hit.pos<current.entries[0]?.from?0:current.entries.length-1
   const rows=current.entries.slice(Math.max(0,index-1),index+2).flatMap(entry=>{const dom=editor.view.nodeDOM(entry.from);return dom instanceof Element?[{from:entry.from,to:entry.to,name:entry.node.attrs.extension?.fallback?.text??entry.node.textContent,rect:dom.getBoundingClientRect()}]:[]})
   return pickBlockDrop(rows,at,view,region,current.allowed)
  }
  const paint=(next:BlockDrop|null)=>setDrop(previous=>previous&&next&&previous.row.from===next.row.from&&previous.edge===next.edge&&previous.allowed===next.allowed&&previous.lineTop===next.lineTop&&Object.keys(next.rect).every(key=>next.rect[key as keyof DropRect]===previous.rect[key as keyof DropRect])?previous:next)
  const tick=()=>{
   animation=0;if(!point||!drag.current)return
   const delta=blockEdgeScroll(point,viewport()),before=surface.scrollTop;if(delta)surface.scrollTop+=delta
   paint(feedback(point));if(delta&&surface.scrollTop!==before)animation=requestAnimationFrame(tick)
  }
  const schedule=()=>{if(point&&drag.current&&!animation)animation=requestAnimationFrame(tick)}
  const pointerMove=(event:PointerEvent)=>{
   const current=pointer.current;if(!current||current.id!==event.pointerId)return
   if(!current.started){if(Math.hypot(event.clientX-current.x,event.clientY-current.y)<6)return;current.started=true;suppressClick.current=true;if(!current.begin()){resetDrag();return}}
   event.preventDefault();event.stopPropagation();point={x:event.clientX,y:event.clientY};paint(feedback(point));schedule()
  }
  const pointerUp=(event:PointerEvent)=>{
   const pending=pointer.current;if(!pending||pending.id!==event.pointerId)return
   if(!pending.started){pointer.current=null;return}
   event.preventDefault();event.stopPropagation();const current=drag.current,next=feedback({x:event.clientX,y:event.clientY});resetDrag()
   if(current&&next?.allowed&&!latest.current.disabled)void invoke('block.move',{...current.target,destination:next.position})
  }
  const cancelPointer=()=>{if(pointer.current||drag.current)resetDrag()}
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&(pointer.current||drag.current)){event.preventDefault();event.stopPropagation();resetDrag()}}
  editor.on('transaction',update);editor.on('focus',focus);editor.on('blur',blur);setFocused(editor.isFocused)
  const dom=editor.view.dom;dom.addEventListener('mousemove',over);window.addEventListener('pointermove',pointerMove,true);window.addEventListener('pointerup',pointerUp,true);window.addEventListener('pointercancel',cancelPointer,true);window.addEventListener('keydown',escape,true);window.addEventListener('blur',cancelPointer);window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule)
  return()=>{cancellation.current?.abort();editor.off('transaction',update);editor.off('focus',focus);editor.off('blur',blur);dom.removeEventListener('mousemove',over);cancelAnimationFrame(animation);cancelDrag.current=()=>{};window.removeEventListener('pointermove',pointerMove,true);window.removeEventListener('pointerup',pointerUp,true);window.removeEventListener('pointercancel',cancelPointer,true);window.removeEventListener('keydown',escape,true);window.removeEventListener('blur',cancelPointer);window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule);latest.current.onTarget(null);if(!editor.isDestroyed)editor.unregisterPlugin(uiKey)}
 },[editor])
 useEffect(()=>{if(disabled){cancelDrag.current();if(frame)close()}},[disabled])
 useEffect(()=>{
  if(!frame)return
  const outside=(event:MouseEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))close()}
  window.addEventListener('mousedown',outside);return()=>window.removeEventListener('mousedown',outside)
 },[frame?.mode])
 useLayoutEffect(()=>{
  if(!editor||!targetEntry||disabled){setGeometry(null);return}
  let raf=0,closed=false
  const update=()=>{
   raf=0;if(closed||editor.isDestroyed)return
   if(drag.current&&dragGeometry.current){setGeometry(dragGeometry.current);return}
   const node=editor.view.nodeDOM(targetEntry.from),rect=node instanceof Element?node.getBoundingClientRect():null,canvas=editor.view.dom.closest('.document-scroll')?.getBoundingClientRect()
   const top=Math.max(canvas?.top??0,0),bottom=Math.min(canvas?.bottom??innerHeight,innerHeight)
   if(!rect||rect.bottom<top||rect.top>bottom){setGeometry(null);return}
   const stacked=rect.left<56,left=Math.max(4,rect.left-(stacked?26:50)),y=Math.max(top+3,rect.top),below=bottom-y-32,above=y-top-8,height=Math.min(430,Math.max(below,above)),flip=below<240&&above>below
   setGeometry({left,top:y,stacked,menuLeft:Math.max(8,Math.min(left,innerWidth-296)),menuTop:flip?Math.max(top+4,y-height-4):y+28,menuHeight:Math.max(0,height)})
  }
  const schedule=()=>{if(!raf)raf=requestAnimationFrame(update)}
  window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);const observer=new ResizeObserver(schedule);observer.observe(editor.view.dom);update()
  return()=>{closed=true;cancelAnimationFrame(raf);observer.disconnect();window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule)}
 },[editor,targetEntry?.from,targetEntry?.to,frame?.mode,disabled])
 useLayoutEffect(()=>{if(frame&&geometry)search.current?.focus()},[frame?.mode,!!geometry])
 const items=frame?registry.list(frame.mode==='insert'?'slash':'block',query).filter(item=>frame.mode!=='insert'||item.id!=='ai.compose'):[]
 const destinations=frame?.mode==='move'&&editor?blockDestinations(editor.state.doc,frame.target,extensionRegistryForState(editor.state),inlineContainerRegistryForState(editor.state)).map(position=>({position,label:position===editor.state.doc.content.size?t('blockAtEnd'):t('blockBeforeNamed',{name:rootBlocks(editor.state.doc).find(block=>block.from===position)?.node.textContent.slice(0,48)||t('bodyText')})})).filter(item=>item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())):[]
 const index=Math.max(0,Math.min(selected,(frame?.mode==='move'?destinations.length:items.length)-1))
 useEffect(()=>{root.current?.querySelector(`[data-block-option="${index}"]`)?.scrollIntoView({block:'nearest'})},[index,query])
 const setIntent=(intent:BlockTarget['intent'])=>{if(!frame)return;const target={...frame.target,intent};latest.current.onTarget(target);registry.refresh();setFrame({target,mode:intent==='operate'?'operate':'insert'});setQuery('');setSelected(0)}
 const choose=(item:typeof items[number])=>{if(!item.enabled||busy)return;if(item.id==='block.move'){setFrame(previous=>previous&&({...previous,mode:'move'}));setQuery('');setSelected(0)}else void invoke(item.id)}
 const visible=geometry&&!disabled&&targetEntry&&!isBlocked(targetEntry)
 const controls=visible?<div ref={root} className="hcd-block-ui" onFocusCapture={()=>setFocused(true)} onBlurCapture={event=>{if(event.relatedTarget instanceof Node&&!root.current?.contains(event.relatedTarget))close()}}>
  <div className={`hcd-block-controls ${geometry.stacked?'stacked':''} ${dragging?'dragging':''}`} style={{left:geometry.left,top:geometry.top}}>
   <button type="button" aria-label={t('blockInsertAfter')} title={t('blockInsertAfter')} onMouseDown={event=>event.preventDefault()} onClick={()=>open('after')}>+</button>
   <button type="button" className="hcd-block-grip" aria-label={t('blockActions')} title={t('blockActionsHint')} onClick={event=>{if(suppressClick.current){suppressClick.current=false;return}open('operate',event.shiftKey)}} onPointerDown={event=>{
    if(event.button!==0||!editor||!entry||disabled)return
    event.preventDefault();suppressClick.current=false;event.currentTarget.setPointerCapture(event.pointerId)
    pointer.current={id:event.pointerId,x:event.clientX,y:event.clientY,started:false,begin:()=>{
     if(editor.isDestroyed||latest.current.disabled)return false
     const selected=selectedRootBlocks(editor.state),entries=selected.length>1&&selected.some(block=>block.from===entry.from)?selected:[entry];if(entries.some(block=>isBlocked(block)))return false
     close();selectRange(entries);const target=blockTarget(editor.state,entries,'operate',registry.context().selection.anchor);if(!target)return false
     drag.current={target,doc:editor.state.doc,entries:blockDropEntries(editor.state.doc,target),allowed:blockDestinations(editor.state.doc,target,extensionRegistryForState(editor.state),inlineContainerRegistryForState(editor.state))};dragGeometry.current=geometry;setDragging(true);latest.current.onTarget(target);editor.view.dispatch(editor.state.tr.setMeta(uiKey,target).setMeta('addToHistory',false));editor.view.dom.closest('.document-scroll')?.dispatchEvent(new Event('hcd-user-navigation'));return true
    }}
   }}>⠿</button>
  </div>
  {frame&&<div className="hcd-block-menu" role="dialog" aria-label={t('blockActions')} style={{left:geometry.menuLeft,top:geometry.menuTop,maxHeight:geometry.menuHeight}} onKeyDown={event=>{
   if(event.nativeEvent.isComposing||event.keyCode===229)return
   const count=frame.mode==='move'?destinations.length:items.length
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true)}
   else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setSelected((index+(event.key==='ArrowDown'?1:-1)+count)%Math.max(1,count))}
   else if(event.key==='Enter'){event.preventDefault();if(frame.mode==='move'){const item=destinations[Math.min(selected,Math.max(0,destinations.length-1))];if(item)void invoke('block.move',{...frame.target,destination:item.position})}else if(items[index])choose(items[index])}
  }}>
   <div className="hcd-block-menu-head"><strong>{t('selectedBlocks',{count:editor?targetBlockCount(editor.state.doc,frame.target):0})}</strong><button type="button" aria-label={t('close')} onClick={()=>close(true)}>×</button></div>
   <input ref={search} role="combobox" aria-expanded="true" aria-label={t('commandSearch')} aria-controls={id} aria-activedescendant={(frame.mode==='move'?destinations.length:items.length)?`${id}-${index}`:undefined} value={query} onChange={event=>{setQuery(event.target.value);setSelected(0)}} placeholder={t('commandSearch')}/>
   <div className="hcd-block-insert-directions"><button onClick={()=>setIntent('before')}>{t('blockInsertBefore')}</button><button onClick={()=>setIntent('after')}>{t('blockInsertAfter')}</button>{frame.mode!=='operate'&&<button onClick={()=>setIntent('operate')}>{t('blockActions')}</button>}</div>
   <div id={id} role="listbox" aria-label={t('commandResults')}>
    {frame.mode==='move'?destinations.map((item,i)=><button key={item.position} id={`${id}-${i}`} role="option" aria-selected={i===selected} data-block-option={i} onMouseMove={()=>setSelected(i)} onClick={()=>void invoke('block.move',{...frame.target,destination:item.position})}>{item.label}</button>):items.map((item,i)=><button key={item.id} id={`${id}-${i}`} data-block-option={i} data-command-id={item.id} type="button" role="option" aria-selected={index===i} aria-disabled={!item.enabled||busy} onMouseMove={()=>setSelected(i)} onClick={()=>choose(item)}><span aria-hidden="true">{item.icon&&isEditorIcon(item.icon)?<EditorIcon name={item.icon}/>:item.icon??'•'}</span><span>{item.label}</span></button>)}
    {!(frame.mode==='move'?destinations.length:items.length)&&<p>{t('commandNoResults')}</p>}
   </div>{failed&&<p role="status">{t('commandUnavailable')}</p>}
  </div>}
 </div>:null
 const dropLabel=drop?t(drop.allowed?(drop.edge==='before'?'blockDropBefore':'blockDropAfter'):drag.current&&drop.position>=drag.current.target.from&&drop.position<=drag.current.target.to?'blockDropNoChange':'blockDropUnavailable',{name:drop.row.name.slice(0,48)||t('bodyText')}):''
 return{controls,openSelected,close,drop:drop?<div className="hcd-block-drop-feedback" data-hcd-drop-state={drop.allowed?'valid':'blocked'} data-hcd-drop-edge={drop.edge}><div className="hcd-block-drop-target" aria-hidden="true" style={{position:'fixed',left:drop.rect.left,top:drop.rect.top,width:drop.rect.right-drop.rect.left,height:drop.rect.bottom-drop.rect.top}}/>{drop.allowed&&drop.lineTop!==null&&<div className="hcd-block-drop" aria-hidden="true" style={{left:drop.rect.left,top:drop.lineTop,width:drop.rect.right-drop.rect.left}}/>}<span className="hcd-block-drop-label" role="status" aria-live="polite" style={{left:Math.max(8,Math.min(drop.rect.left,innerWidth-240)),top:Math.max(8,Math.min((drop.lineTop??drop.rect.top)-28,innerHeight-32))}}>{dropLabel}</span></div>:null,active:!!frame||dragging}
}
