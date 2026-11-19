import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { CaptureUpdateAction, newElementWith, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { noteDirections, type NoteDirection } from './sceneGeometry'
import { PaintMask,usePaintStack } from './paintStack'
import { noteTextStyle } from './StickyToolbar'
import { boardTag, stickyLabel } from './boardObjects'

function paperViews(editor: ExcalidrawImperativeAPI) {
  const { scrollX, scrollY, zoom: { value: z } } = editor.getAppState()
  const elements = editor.getSceneElements()
  return elements.flatMap(el => {
    const tag = boardTag(el)
    if (!tag || !(el.type === 'rectangle' && tag.kind === 'sticky' || el.type === 'ellipse' && tag.kind === 'comment')) return []
    const label = tag.noteFormat && stickyLabel(elements,el.id)
    return [{ id: el.id, tag, body: label?.originalText, fontSize: label?.fontSize ?? 20, left: (el.x + scrollX) * z, top: (el.y + scrollY) * z,
      width: el.width * z, height: el.height * z, angle: el.angle, z, opacity: el.opacity / 100 }]
  })
}

export function BoardPaperLayer({ editor, editing, canPoint, writable, open, onNeighbor, selected, onPinDrop }: {
  onPinDrop:(id:string,point:{x:number;y:number},origin:{x:number;y:number})=>void
  onNeighbor: (id: string, direction: NoteDirection, drop?:{x:number;y:number}) => void; selected: string
  editor: ExcalidrawImperativeAPI; editing?: string; canPoint: boolean; writable: boolean; open: (id: string) => void
}) {
  const stack=usePaintStack(editor)
  const [views, setViews] = useState(() => paperViews(editor))
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  useEffect(() => {
    let previous = ''
    const sync = () => {
      const next = paperViews(editor), key = JSON.stringify(next)
      if (key !== previous) { previous = key; setViews(next) }
    }
    sync()
    return editor.onChange(sync)
  }, [editor])
  const layer = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState('')
  const quick=useRef<{x:number;y:number;id:string;dir:NoteDirection}|null>(null)
  const [ghost,setGhost]=useState<{left:number;top:number}|null>(null)
  const suppressClick=useRef(false)
  useEffect(() => {
    const surface = layer.current?.closest('.canvas-surface')
    if (!surface || !canPoint || !writable) { setHover(''); return }
    const move = (event: Event) => {
      const e = event as globalThis.PointerEvent
      if (e.buttons) { if(!quick.current)setHover(''); return }
      const target = e.target as Element
      if (target.closest('.board-note-neighbors')) return
      if (!(target instanceof HTMLCanvasElement)) { setHover(''); return }
      const app = editor.getAppState()
      const pos = viewportCoordsToSceneCoords(e, app)
      const all = editor.getSceneElements()
      const hit = [...all].reverse().find(el => el.opacity && pos.x >= el.x && pos.y >= el.y && pos.x <= el.x+el.width && pos.y <= el.y+el.height)
      const root = hit?.type === 'text' && hit.containerId ? all.find(el => el.id === hit.containerId) : hit
      if (root && boardTag(root)?.kind === 'sticky' && !root.locked) { setHover(root.id); return }
      setHover(old => {
        const nearby = all.find(el => el.id === old), margin = 20/app.zoom.value
        return nearby && !hit && pos.x >= nearby.x-margin && pos.x <= nearby.x+nearby.width+margin &&
          pos.y >= nearby.y-margin && pos.y <= nearby.y+nearby.height+margin ? old : ''
      })
    }
    const leave = () => setHover('')
    surface.addEventListener('pointermove', move)
    surface.addEventListener('pointerleave', leave)
    return () => { surface.removeEventListener('pointermove', move); surface.removeEventListener('pointerleave', leave) }
  }, [editor, canPoint, writable])
  const activeNote = canPoint && writable && views.find(v => v.tag.kind === 'sticky' && v.id === (hover || selected))
  function finish(e: PointerEvent<HTMLButtonElement>, id: string) {
    const start = drag.current
    drag.current = null
    e.currentTarget.style.translate = ''
    if (!start || !start.moved || !writable) return
    const zoom = editor.getAppState().zoom.value
    const dx = (e.clientX - start.x) / zoom, dy = (e.clientY - start.y) / zoom
    editor.updateScene({ elements: editor.getSceneElementsIncludingDeleted().map(el =>
      el.id === id || (el.type === 'text' && el.containerId === id)
        ? newElementWith(el, { x: el.x + dx, y: el.y + dy }) : el),
      appState: { selectedElementIds: { [id]: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
    const app=editor.getAppState()
    onPinDrop(id,viewportCoordsToSceneCoords(e,app),viewportCoordsToSceneCoords({clientX:start.x,clientY:start.y},app))
    // Suppress the synthetic click after dragging the pin.
    e.currentTarget.dataset.dragged = 'true'
  }
  return <div className="board-paper-layer" ref={layer}>
    {views.map(({ id, tag, body, fontSize, left, top, width, height, angle, z, opacity }) => {
      if (tag.kind === 'sticky') return editing === id ? null :
        <PaintMask key={id} api={editor} scene={stack} id={id} x={left/z-editor.getAppState().scrollX} y={top/z-editor.getAppState().scrollY} width={width/z} height={height/z} angle={angle} scale={z}>{maskImage=>
        <div className="board-paper-shadow" data-note-id={id} style={{ maskImage,left, top, width, height, opacity, transform: `rotate(${angle}rad)` }}>
          {body && tag.noteFormat && Object.keys(tag.noteFormat).length>0 && <div className="note-formatted-body" style={{...noteTextStyle(tag.noteFormat,fontSize),left:15*z,top:15*z,width:Math.max(1,width/z-30),transform:`scale(${z})`}}>{tag.noteFormat.list?body.split('\n').map((s,i)=><div key={i}>• {s}</div>):body}</div>}
          {tag.showAuthor !== false && tag.author && <span style={{ left: 15 * z, right: 15 * z, bottom: 11 * z, fontSize: 12 * z }}>{tag.author}</span>}
        </div>}</PaintMask>
      const size = Math.max(27, Math.min(44, width))
      const initial = Array.from(tag.author?.trim() || '')[0]
      return <button key={id} type="button" className="board-comment-pin" data-resolved={!!tag.resolved}
        aria-label={`打开${tag.author || '协作者'}的评论`} title={tag.resolved ? '已解决的评论' : tag.author + '的评论'}
        tabIndex={canPoint ? 0 : -1} style={{ left, top: top + height - size, width: size, height: size,
          pointerEvents: canPoint ? 'auto' : 'none' }}
        onPointerDown={e => {
          if (e.button !== 0) return
          drag.current = { x: e.clientX, y: e.clientY, moved: false }
          delete e.currentTarget.dataset.dragged
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => {
          if (!writable || !drag.current) return
          const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y
          if (Math.hypot(dx, dy) > 4) drag.current.moved = true
          if (drag.current.moved) e.currentTarget.style.translate = `${dx}px ${dy}px`
        }}
        onPointerUp={e => finish(e, id)} onPointerCancel={e => { drag.current = null; e.currentTarget.style.translate = '' }}
        onClick={e => { if (e.currentTarget.dataset.dragged) { delete e.currentTarget.dataset.dragged; return } open(id) }}>
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <path d="M2 17.8C2 9 9 2 17.8 2S34 9 34 17.8 27 33.5 18 33.5H4.5A2.5 2.5 0 0 1 2 31Z" fill="var(--pin-shell)" stroke="white" strokeWidth="2.2"/>
          <circle cx="18" cy="17.6" r="10.6" fill="var(--pin-avatar)"/>
          {tag.resolved ? <path d="m13 18 3.2 3 7-7" fill="none" stroke="var(--pin-shell)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/> :
            initial ? <text x="18" y="18" dy=".33em" textAnchor="middle" fill="var(--pin-shell)" fontSize="12" fontFamily="system-ui,sans-serif" fontWeight="650">{initial}</text> :
            <path d="M12 23c0-6 12-6 12 0m-6-5a3 3 0 1 0 0-6 3 3 0 0 0 0 6" fill="var(--pin-shell)"/>}
        </svg>
      </button>
    })}
    {activeNote && !editor.getAppState().selectedElementsAreBeingDragged && !editor.getSceneElements().find(el=>el.id===activeNote.id)?.locked &&
      <div className="board-note-neighbors" role="group" aria-label="相邻便签"
        style={{left:activeNote.left,top:activeNote.top,width:activeNote.width,height:activeNote.height,transform:`rotate(${activeNote.angle}rad)`}}>
        {(Object.keys(noteDirections) as NoteDirection[]).map(dir=><button key={dir} type="button" data-side={dir}
          aria-label={'向'+noteDirections[dir]+'新增便利贴'} title={'向'+noteDirections[dir]+'新增便利贴'}
          onPointerDown={e=>{if(e.button!==0)return;e.stopPropagation();suppressClick.current=false;quick.current={id:activeNote.id,dir,x:e.clientX,y:e.clientY};e.currentTarget.setPointerCapture(e.pointerId)}}
          onPointerMove={e=>{const g=quick.current,rect=layer.current?.getBoundingClientRect();if(!g||!rect||Math.hypot(e.clientX-g.x,e.clientY-g.y)<5)return;setGhost({left:e.clientX-rect.left-activeNote.width/2,top:e.clientY-rect.top-activeNote.width/2})}}
          onPointerCancel={()=>{quick.current=null;setGhost(null)}}
          onPointerUp={e=>{const g=quick.current;quick.current=null;setGhost(null);if(!g||Math.hypot(e.clientX-g.x,e.clientY-g.y)<5)return;suppressClick.current=true;setHover('');onNeighbor(g.id,g.dir,viewportCoordsToSceneCoords(e,editor.getAppState()))}}
          onClick={e=>{e.stopPropagation();if(suppressClick.current){suppressClick.current=false;return}setHover('');onNeighbor(activeNote.id,dir)}}><span>+</span></button>)}
      </div>}
    {ghost&&activeNote&&<div className="neighbor-ghost" style={{...ghost,width:activeNote.width,height:activeNote.width,background:editor.getSceneElements().find(el=>el.id===activeNote.id)?.backgroundColor}}/>}
  </div>
}
