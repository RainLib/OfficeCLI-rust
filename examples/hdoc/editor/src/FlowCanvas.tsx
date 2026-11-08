import { useEffect, useRef } from 'react'
import type {HistoricalReferenceNavigation} from './ReferencePanel.tsx'
import {referenceElement} from './referenceIndex.ts'

/** The frame cannot execute scripts or navigate the parent. Same-origin access
 * is used only to measure this already validated HCD chunk and select its nodes. */
type FlowPeer={clientId:number;name:string;color:string;nodeId:string}
const noPeers:FlowPeer[]=[]
export function FlowCanvas({ onInteraction,peers=noPeers,selectableIds,srcDoc, width, height, scale, selected, onSelect, onHeight, title, referenceNavigation, onReferenceLocated }: {
  onInteraction?:()=>void;peers?:FlowPeer[];selectableIds?:string[]
  srcDoc: string; width: number; height: number; scale: number; selected: string
  onSelect: (nodeId: string) => void; onHeight: (height: number) => void; title: string
  referenceNavigation?:HistoricalReferenceNavigation;onReferenceLocated?:(requestId:string,found:boolean)=>void
}) {
  const interact=useRef(onInteraction);interact.current=onInteraction
  const remote=useRef(peers);remote.current=peers
  const allowed=useRef(selectableIds);allowed.current=selectableIds
  const overlay=useRef<HTMLElement|null>(null)
  const decoratePeers=()=>{
    const document=frame.current?.contentDocument;if(!document?.body)return
    overlay.current?.remove();overlay.current=null;if(!remote.current.length)return;const layer=document.createElement('div');layer.setAttribute('data-hcd-peer-overlay','true');layer.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:100;overflow:visible';
    const nodes=new Map(Array.from(document.querySelectorAll<HTMLElement>('[data-hcd-node-hash]')).map(node=>[node.getAttribute('data-hcd-id'),node]));const badges=new Map<string,HTMLElement>();
    for(const peer of remote.current){const node=nodes.get(peer.nodeId);if(!node)continue;const color=/^#[a-f0-9]{6}$/i.test(peer.color)?peer.color:'#3478c0';
      const rects=Array.from(node.getClientRects());for(const rect of rects){const mark=document.createElement('span');mark.style.cssText=`position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${Math.max(2,rect.height)}px;outline:1px solid ${color};background:${color}18`;layer.append(mark)}
      const rect=rects[0];if(rect){let group=badges.get(peer.nodeId);if(!group){group=document.createElement('span');group.style.cssText=`position:absolute;left:${rect.left}px;top:${Math.max(0,rect.top-18)}px;display:flex;gap:3px;max-width:${Math.max(80,width-rect.left-8)}px;overflow:hidden`;badges.set(peer.nodeId,group);layer.append(group)}const label=document.createElement('span');label.textContent=peer.name;label.title=peer.name;label.style.cssText=`flex:0 0 auto;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/16px system-ui;color:white;background:${color};padding:0 4px;border-radius:3px`;group.append(label)}
    }
    document.body.append(layer);overlay.current=layer
  }
  const frame = useRef<HTMLIFrameElement>(null)
  const cleanup = useRef<() => void>(() => {})
  const decoration=useRef<{element:HTMLElement;outline:string;offset:string;background:string}|null>(null)
  const clearDecoration=()=>{const old=decoration.current;if(old){old.element.style.outline=old.outline;old.element.style.outlineOffset=old.offset;old.element.style.backgroundColor=old.background;decoration.current=null}}
  const navigation=useRef(referenceNavigation),located=useRef(onReferenceLocated),applied=useRef('')
  navigation.current=referenceNavigation;located.current=onReferenceLocated
  const selection = useRef(selected)
  const select = useRef(onSelect)
  selection.current = selected
  select.current = onSelect
  const highlight = () => {
    for (const node of frame.current?.contentDocument?.querySelectorAll<HTMLElement>('[data-hcd-node-hash]') || []) {
      node.style.outline = node.getAttribute('data-hcd-id') === selection.current ? '1px dashed #5b8ae4' : ''
      node.style.outlineOffset = '2px'
    }
  }
  const navigate=()=>{
    const request=navigation.current,document=frame.current?.contentDocument
    if(!request||!document?.body||applied.current===request.requestId)return
    // Wait until the measured frame height is committed before scrolling its
    // outer document. A tall unloaded frame must not clamp the intended jump.
    if(document.body.scrollHeight>height+2)return
    clearDecoration()
    const node=referenceElement(document,request.reference)
    applied.current=request.requestId
    if(!node){located.current?.(request.requestId,false);return}
    decoration.current={element:node,outline:node.style.outline,offset:node.style.outlineOffset,background:node.style.backgroundColor}
    node.style.outline='2px solid #6b91d5';node.style.backgroundColor='#e8f0ff';node.style.outlineOffset='2px'
    const scroll=frame.current?.closest('.document-scroll') as HTMLElement|null,rect=node.getBoundingClientRect(),outer=frame.current?.getBoundingClientRect()
    if(scroll&&outer){const box=scroll.getBoundingClientRect();scroll.scrollTo({top:scroll.scrollTop+outer.top+rect.top*scale-box.top-scroll.clientHeight/3,behavior:'auto'})}
    located.current?.(request.requestId,true)
  }
  useEffect(() => { highlight() }, [selected])
  useEffect(()=>{decoratePeers()},[peers,height,width,srcDoc])
  useEffect(()=>{if(!referenceNavigation)clearDecoration();else navigate()},[referenceNavigation,height,srcDoc])
  useEffect(() => () => {cleanup.current();clearDecoration();overlay.current?.remove()}, [])
  return <iframe ref={frame} sandbox="allow-same-origin" title={title} srcDoc={srcDoc} referrerPolicy="no-referrer" style={{ width, height, transform: `scale(${scale})` }} onLoad={() => {
    cleanup.current()
    applied.current=''
    const document = frame.current?.contentDocument
    if (!document?.body) return
    document.body.style.cssText = `margin:0;padding:36px 48px;box-sizing:border-box;width:${width}px;overflow:hidden;background:white`
    const measure = () => onHeight(Math.max(200, Math.ceil(document.body.scrollHeight)))
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    const click = (event: MouseEvent) => {
      event.preventDefault()
      const target = event.target as Element | null
      const node = target?.closest('[data-hcd-node-hash]')
      const id = node?.getAttribute('data-hcd-id')
      select.current(id&&(!allowed.current||allowed.current.includes(id))?id:'')
    }
    const interaction=()=>interact.current?.()
    // Frame events do not bubble into the outer workspace. Forward only user
    // intent; the host keeps presence and follow state out of canonical data.
    for(const event of ['pointerdown','wheel','touchstart','keydown'])document.addEventListener(event,interaction,{capture:true,passive:true})
    document.addEventListener('click', click)
    highlight()
    decoratePeers()
    measure()
    navigate()
    cleanup.current = () => { observer.disconnect(); document.removeEventListener('click', click);for(const event of ['pointerdown','wheel','touchstart','keydown'])document.removeEventListener(event,interaction,true) }
  }} />
}
