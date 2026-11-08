import {useEffect,useRef} from 'react'
export type MenuAction={id?:string;label:string;action:()=>void;disabled?:boolean;separated?:boolean;active?:boolean;shortcut?:string}
export function ContextMenu({x,y,actions,onClose}:{x:number;y:number;actions:MenuAction[];onClose:()=>void}){
 const root=useRef<HTMLDivElement>(null),previous=useRef<Element|null>(null)
 const closeCallback=useRef(onClose);closeCallback.current=onClose
 useEffect(()=>{
  previous.current=document.activeElement
  const frame=requestAnimationFrame(()=>root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
  const dismiss=(event:MouseEvent)=>{if(!(event.target instanceof Node)||!root.current?.contains(event.target))closeCallback.current()}
  const close=()=>closeCallback.current()
  const scroll=(event:Event)=>{if(!(event.target instanceof Node)||!root.current?.contains(event.target))close()}
  window.addEventListener('mousedown',dismiss);window.addEventListener('resize',close);window.addEventListener('scroll',scroll,true)
  return()=>{cancelAnimationFrame(frame);window.removeEventListener('mousedown',dismiss);window.removeEventListener('resize',close);window.removeEventListener('scroll',scroll,true)}
 },[])
 return <div ref={root} className="hcd-context-menu" role="menu" style={{left:Math.max(8,Math.min(x,window.innerWidth-240)),top:Math.max(8,Math.min(y,window.innerHeight-Math.min(actions.length*37,window.innerHeight-24)-12)),maxHeight:'calc(100vh - 24px)',overflowY:'auto'}} onKeyDown={event=>{
  if(event.nativeEvent.isComposing)return
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();if(previous.current instanceof HTMLElement&&previous.current.isConnected)previous.current.focus()}
  else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...root.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];if(!buttons.length)return;const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus()}
  else if(event.key==='Tab'){event.preventDefault();onClose();if(previous.current instanceof HTMLElement)previous.current.focus()}
 }}>
  {actions.map((item,index)=><button key={item.id??`${index}:${item.label}`} role={item.active===undefined?'menuitem':'menuitemcheckbox'} aria-checked={item.active} className={item.separated?'separated':''} disabled={item.disabled} onClick={()=>{item.action();onClose();queueMicrotask(()=>{if(document.activeElement===document.body&&previous.current instanceof HTMLElement&&previous.current.isConnected)previous.current.focus()})}}><span>{item.label}</span>{item.shortcut&&<kbd>{item.shortcut}</kbd>}</button>)}
 </div>
}
