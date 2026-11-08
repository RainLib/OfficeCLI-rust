import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import type {Editor} from '@tiptap/core'
import type {Awareness} from 'y-protocols/awareness'
import type {SemanticBlockStore} from './semanticBlockStore.ts'
import {structureCursorField} from './semanticStructureCarets.ts'
import {captureStructurePoint,resolveStructurePoint} from './semanticStructureSelection.ts'
import {readStructureViewport,viewportFollowCycle,selectViewportConnections,structureViewportField,type StructureViewport} from './collaborationViewport.ts'
import {useI18n} from './i18n.tsx'
type Peer={client:number;id:string;name:string;color:string;viewport:StructureViewport;activity:StructureViewport['anchor'];canFollow:boolean}
type Member={id:string;name:string;color:string;connections:number}
/** Scroll awareness is separate from the editing caret. Following is opt-in,
 * never changes selection, and stops on the viewer's own interaction. */
export function SemanticActivity({editor,awareness,localId,rightInset,members,panelHost,onClose}:{editor:Editor|null;awareness:Awareness|null;localId:string;rightInset:number;members:Member[];panelHost:HTMLElement|null;onClose:()=>void}){
 const {t}=useI18n(),[peers,setPeers]=useState<Peer[]>([]),[following,setFollowing]=useState<number|null>(null),followingRef=useRef(following);followingRef.current=following
 const publishRef=useRef<(()=>void)|null>(null)
 useEffect(()=>{publishRef.current?.()},[following])
 useEffect(()=>{
  setPeers([]);setFollowing(null)
  if(!editor||!awareness)return
  const store=(editor.storage as unknown as {hcdSemanticStructureCollaboration?:{store:SemanticBlockStore}}).hcdSemanticStructureCollaboration?.store
  const scroll=editor.view.dom.closest('.document-scroll') as HTMLElement|null
  if(!store||!scroll)return
  const owner=crypto.randomUUID();let closed=false,timer:ReturnType<typeof setTimeout>|undefined,last='',peerSignature=''
  const publish=()=>{
   timer=undefined;if(closed||editor.isDestroyed||!store.initialized)return
   try{const box=scroll.getBoundingClientRect(),body=editor.view.dom.getBoundingClientRect(),x=Math.max(box.left+1,Math.min(box.right-1,body.left+body.width/2)),y=Math.max(box.top+1,Math.min(box.bottom-1,Math.max(box.top,body.top)+24))
   let anchor:StructureViewport['anchor']=null
   try{const position=editor.view.posAtCoords({left:x,top:y});if(position)anchor=captureStructurePoint(store,editor.state.doc,position.pos)}catch{/* Skipped long-text layout can still publish its scroll marker. */}
   const value:StructureViewport={version:1,owner,progress:Math.min(1,Math.max(0,scroll.scrollTop/Math.max(1,scroll.scrollHeight-scroll.clientHeight))),anchor,...(followingRef.current===null?{}:{following:followingRef.current})}
   const signature=JSON.stringify(value);if(signature!==last){last=signature;awareness.setLocalStateField(structureViewportField,value)}}catch{/* A detached or skipped viewport is not a document failure. */}
  }
  const schedule=()=>{if(!closed&&!timer)timer=setTimeout(publish,150)}
  publishRef.current=schedule
  const update=()=>{
   const candidates:Omit<Peer,'canFollow'>[]=[]
   for(const [client,value]of [...awareness.getStates()].sort(([a],[b])=>a-b)){
    const person=value.user,viewport=readStructureViewport(value[structureViewportField])
    if(client===awareness.clientID||!person||typeof person.id!=='string'||person.id===localId||typeof person.name!=='string'||!viewport)continue
    const cursor=value[structureCursorField],point=cursor?.version===1?(cursor.selection?.head??cursor.selection?.anchor):null
    const activity=point?readStructureViewport({version:1,owner:'cursor',progress:0,anchor:point})?.anchor??null:null
    candidates.push({client,id:person.id,name:person.name.slice(0,64),color:/^#[a-f0-9]{6}$/i.test(person.color??'')?person.color:'#3478c0',viewport,activity})
   }
   const next=selectViewportConnections(candidates,followingRef.current).slice(0,100).map(peer=>({...peer,canFollow:!viewportFollowCycle(awareness.getStates(),awareness.clientID,peer.client)}))
   const signature=JSON.stringify(next);if(signature!==peerSignature){peerSignature=signature;setPeers(next)}
   if(followingRef.current!==null&&(!next.some(peer=>peer.client===followingRef.current)||viewportFollowCycle(awareness.getStates(),awareness.clientID,followingRef.current)))setFollowing(null)
  }
  const stop=()=>{if(followingRef.current!==null)setFollowing(null)}
  const key=(event:KeyboardEvent)=>{if(['PageUp','PageDown','Home','End','ArrowUp','ArrowDown'].includes(event.key))stop()}
  scroll.addEventListener('hcd-user-navigation',stop);scroll.addEventListener('scroll',schedule,{passive:true});scroll.addEventListener('wheel',stop,{passive:true});scroll.addEventListener('touchstart',stop,{passive:true});scroll.addEventListener('pointerdown',stop);scroll.addEventListener('beforeinput',stop);scroll.addEventListener('keydown',key)
  const resize=new ResizeObserver(schedule);resize.observe(scroll);resize.observe(editor.view.dom)
  editor.on('transaction',schedule);awareness.on('change',update);publish();update()
  return()=>{closed=true;publishRef.current=null;clearTimeout(timer);resize.disconnect();editor.off('transaction',schedule);awareness.off('change',update);scroll.removeEventListener('hcd-user-navigation',stop);scroll.removeEventListener('scroll',schedule);scroll.removeEventListener('wheel',stop);scroll.removeEventListener('touchstart',stop);scroll.removeEventListener('pointerdown',stop);scroll.removeEventListener('beforeinput',stop);scroll.removeEventListener('keydown',key);if(awareness.getLocalState()?.[structureViewportField]?.owner===owner)awareness.setLocalStateField(structureViewportField,null)}
 },[editor,awareness,localId])
 const followed=peers.find(peer=>peer.client===following)
 const locate=(peer:Peer,editing=false)=>{
  if(!editor||editor.isDestroyed)return
  const store=(editor.storage as unknown as {hcdSemanticStructureCollaboration?:{store:SemanticBlockStore}}).hcdSemanticStructureCollaboration?.store,scroll=editor.view.dom.closest('.document-scroll') as HTMLElement|null
  if(!store||!scroll)return
  try{const point=editing?(peer.activity??peer.viewport.anchor):peer.viewport.anchor,position=point?resolveStructurePoint(store,editor.state.doc,point):null
   if(position!==null){const caret=editor.view.coordsAtPos(position),box=scroll.getBoundingClientRect();scroll.scrollTo({top:scroll.scrollTop+caret.top-box.top-32,behavior:'auto'})}
   else scroll.scrollTo({top:peer.viewport.progress*Math.max(0,scroll.scrollHeight-scroll.clientHeight),behavior:'auto'})
  }catch{/* An obsolete peer position cannot disrupt the editor. */}
 }
 const activityText=(peer:Peer|undefined)=>{if(!peer?.activity||!editor||editor.isDestroyed)return '';try{const store=(editor.storage as unknown as {hcdSemanticStructureCollaboration:{store:SemanticBlockStore}}).hcdSemanticStructureCollaboration.store,position=resolveStructurePoint(store,editor.state.doc,peer.activity);if(position===null)return '';const point=editor.state.doc.resolve(position),node=point.parent.isTextblock?point.parent:editor.state.doc.nodeAt(position);return Array.from(node?.textContent||node?.attrs.preview||'').slice(0,64).join('')}catch{return ''}}
 const locateRef=useRef(locate);locateRef.current=locate
 useEffect(()=>{if(followed)locateRef.current(followed)},[followed])
 return <>
  {!!peers.length&&<div className="hcd-collaboration-rail" aria-label={t('collaboratorLocations')} style={{right:rightInset+5}}>{peers.map(peer=><span key={peer.client} className="hcd-location-marker" role="img" aria-label={t('collaboratorViewLocation',{name:peer.name,percent:Math.round(peer.viewport.progress*100)})} title={t('collaboratorViewLocation',{name:peer.name,percent:Math.round(peer.viewport.progress*100)})} style={{top:`${2+peer.viewport.progress*94}%`,backgroundColor:peer.color}}>{Array.from(peer.name)[0]||'•'}</span>)}</div>}
  {panelHost&&createPortal(<section className="collaboration-panel"><div className="panel-head"><h2>{t('collaborationPanelTitle')}</h2><button className="panel-close" aria-label={t('hidePanel')} onClick={onClose}>×</button></div><p className="collaboration-hint">{t('collaborationLocationHint')}</p><ul className="collaboration-members">{members.map(member=>{
   const peer=peers.find(peer=>peer.id===member.id),excerpt=activityText(peer),own=member.id===localId,active=peer?.client===following
   return <li key={member.id}><div className="collaboration-member-name"><i style={{backgroundColor:member.color}}>{Array.from(member.name)[0]}</i><strong>{member.name}{own?` ${t('you')}`:''}</strong></div><small>{own?t('yourView'):peer?t('collaboratorViewProgress',{percent:Math.round(peer.viewport.progress*100)}):t('collaboratorLocationPending')}{member.connections>1?` · ${t('connectionCount',{count:member.connections})}`:''}</small>{excerpt&&<p className="collaboration-activity-text">{t('collaboratorEditingText',{text:excerpt})}</p>}{!own&&<div className="collaboration-member-actions"><button type="button" disabled={!peer} onClick={()=>{setFollowing(null);if(peer)locate(peer,true)}}>{t('locateCollaborator')}</button><button type="button" disabled={!active&&!peer?.canFollow} title={peer&&!peer.canFollow&&!active?t('followLoopUnavailable'):undefined} aria-pressed={active} onClick={()=>{if(active)setFollowing(null);else if(peer&&awareness&&!viewportFollowCycle(awareness.getStates(),awareness.clientID,peer.client))setFollowing(peer.client)}}>{t(active?'stopFollowing':'followCollaboratorAction')}</button></div>}</li>
  })}</ul>{followed&&<p role="status">{t('followingCollaborator',{name:followed.name})}</p>}</section>,panelHost)}
  {followed&&<div className="hcd-follow-status" role="status" style={{right:rightInset+36}}><span>{t('followingCollaborator',{name:followed.name})}</span><button type="button" onClick={()=>setFollowing(null)}>{t('stopFollowing')}</button></div>}
 </>
}
