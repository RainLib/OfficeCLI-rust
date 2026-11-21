import { extensibleShape, shapeBox } from './boardShapes'
import { EdgeShapePicker } from './EdgeShapePicker'
import { commentTime } from './BoardBlockEditor'
import { MentionText, type BoardMention } from './BoardMentions'
import { BoardEdgeHandles } from './BoardEdgeHandles'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { CaptureUpdateAction, newElementWith, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { pointOnSide, type NoteDirection } from './sceneGeometry'
import { PaintMask,usePaintStack } from './paintStack'
import { noteTextStyle } from './StickyToolbar'
import { boardTag, connectNotes, stickyLabel } from './boardObjects'

function containsPoint(el: Parameters<typeof shapeBox>[0], point: {x:number; y:number}) {
  const box = shapeBox(el), dx = point.x - box.x - box.width/2, dy = point.y - box.y - box.height/2
  const c = Math.cos(box.angle), s = Math.sin(box.angle)
  return Math.abs(dx*c + dy*s) <= box.width/2 && Math.abs(dy*c - dx*s) <= box.height/2
}
function paperViews(editor: ExcalidrawImperativeAPI) {
  const { scrollX, scrollY, zoom: { value: z } } = editor.getAppState()
  const elements = editor.getSceneElements()
  return elements.flatMap(el => {
    const tag = boardTag(el)
    if (!tag || !(el.type === 'rectangle' && tag.kind === 'sticky' || el.type === 'ellipse' && tag.kind === 'comment')) return []
    const label = tag.noteFormat && stickyLabel(elements,el.id)
    const comment = tag.kind === 'comment' ? {text:String(el.customData?.officeComment||''), time:el.customData?.createdAt ?? el.updated,
      mentions:el.customData?.mentions as BoardMention[]|undefined, image:!!el.customData?.imageFileId,
      recipients:elements.filter(item=>item.id===el.id || boardTag(item)?.root===el.id && boardTag(item)?.part==='reply')
        .flatMap(item=>Array.isArray(item.customData?.mentions)?item.customData.mentions.map((m:BoardMention)=>m?.id):[])}:undefined
    return [{ id: el.id, tag, comment, body: label?.originalText, fontSize: label?.fontSize ?? 20, left: (el.x + scrollX) * z, top: (el.y + scrollY) * z,
      width: el.width * z, height: el.height * z, angle: el.angle, z, opacity: el.opacity / 100 }]
  })
}

export function BoardPaperLayer({ editor, editing, canPoint, writable, open, onNeighbor, selected, personId, peekComments, onPinDrop }: {
  peekComments:boolean
  personId?:string
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
  const [picker, setPicker] = useState<{id: string; side: NoteDirection} | null>(null)
  useEffect(() => { if (!canPoint || !writable) setPicker(null) }, [canPoint, writable])
  const [selectedShape,setSelectedShape]=useState('')
  useEffect(()=>{
    const sync=()=>{const selected=editor.getAppState().selectedElementIds; const ids=editor.getSceneElements().filter(el=>selected[el.id] && !el.customData?.officeShapeAnchor).map(el=>el.id);setSelectedShape(ids.length===1?ids[0]:'')}
    sync();return editor.onChange(sync)
  },[editor])
  useEffect(() => {
    const surface = layer.current?.closest('.canvas-surface')
    if (!surface || !canPoint || !writable) { setHover(''); return }
    const move = (event: Event) => {
      const e = event as globalThis.PointerEvent
      if (e.buttons) return
      const target = e.target as Element
      if (target.closest('.board-note-neighbors, .board-edge-palette')) return
      if (!(target instanceof HTMLCanvasElement)) { setHover(''); return }
      const app = editor.getAppState()
      const pos = viewportCoordsToSceneCoords(e, app)
      const all = editor.getSceneElements()
      const hit = [...all].reverse().find(el => el.opacity && el.type !== 'freedraw' && (el.type !== 'line' || extensibleShape(el)) && el.type !== 'arrow' && containsPoint(el, pos))
      const root = hit?.type === 'text' && hit.containerId ? all.find(el => el.id === hit.containerId) : hit
      if (root && (boardTag(root)?.kind === 'sticky' || extensibleShape(root)) && !root.locked) { setHover(root.id); return }
      setHover(old => {
        const nearby = all.find(el => el.id === old), margin = 46/app.zoom.value
        return nearby && !hit && pos.x >= nearby.x-margin && pos.x <= nearby.x+nearby.width+margin &&
          pos.y >= nearby.y-margin && pos.y <= nearby.y+nearby.height+margin ? old : ''
      })
    }
    const leave = () => setHover('')
    surface.addEventListener('pointermove', move)
    surface.addEventListener('pointerleave', leave)
    return () => { surface.removeEventListener('pointermove', move); surface.removeEventListener('pointerleave', leave) }
  }, [editor, canPoint, writable])
  const activeNote = canPoint && writable && !picker && views.find(v => v.tag.kind === 'sticky' && v.id === (hover || selected))
  const app=editor.getAppState(), z=app.zoom.value
  const ordinary=canPoint && writable && editor.getSceneElements().find(el=>el.id===(picker?.id || hover || selectedShape) && extensibleShape(el) && !el.locked)
  const bounds=ordinary && shapeBox(ordinary)
  const active=activeNote || (ordinary && bounds && {id:ordinary.id,left:(bounds.x+app.scrollX)*z,top:(bounds.y+app.scrollY)*z,width:bounds.width*z,height:bounds.height*z,angle:bounds.angle})
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
    {views.map(({ id, tag, comment, body, fontSize, left, top, width, height, angle, z, opacity }) => {
      if (tag.kind === 'sticky') return editing === id ? null :
        <PaintMask key={id} api={editor} scene={stack} id={id} x={left/z-editor.getAppState().scrollX} y={top/z-editor.getAppState().scrollY} width={width/z} height={height/z} angle={angle} scale={z}>{maskImage=>
        <div className="board-paper-shadow" data-note-id={id} style={{ maskImage,left, top, width, height, opacity, transform: `rotate(${angle}rad)` }}>
          {body && tag.noteFormat && Object.keys(tag.noteFormat).length>0 && <div className="note-formatted-body" style={{...noteTextStyle(tag.noteFormat,fontSize),left:15*z,top:15*z,width:Math.max(1,width/z-30),transform:`scale(${z})`}}>{tag.noteFormat.list?body.split('\n').map((s,i)=><div key={i}>• {s}</div>):body}</div>}
        </div>}</PaintMask>
      const size = Math.max(27, Math.min(44, width))
      const initial = Array.from(tag.author?.trim() || '')[0]
      const pinTop = top + height - size
      const opensLeft = app.width - left < 240 && left > app.width - left - size
      const opensUp = app.height - pinTop < 100 && pinTop > app.height - pinTop - size
      return <button key={id} type="button" className="board-comment-pin" data-resolved={!!tag.resolved} data-mentioned={!!personId && comment?.recipients.includes(personId)}
        data-opens-left={opensLeft} data-opens-up={opensUp}
        aria-label={`打开${tag.author || '协作者'}的评论`}
        aria-describedby={comment ? 'comment-peek-' + id : undefined}
        tabIndex={canPoint ? 0 : -1} style={{ left, top: pinTop, width: size, height: size,
          '--pin-size': size + 'px', '--pin-room': Math.max(size, (opensLeft ? left + size : app.width - left) - 6) + 'px',
          pointerEvents: canPoint || peekComments ? 'auto' : 'none' } as CSSProperties}
        onPointerDown={e => {
          if (e.button !== 0 || !canPoint) return
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
        onClick={e => { if (e.currentTarget.dataset.dragged) { delete e.currentTarget.dataset.dragged; return } if(canPoint)open(id) }}>
        <span className="board-comment-surface">
          {comment && <span id={'comment-peek-' + id} className="board-comment-peek" role="tooltip">
            <b>{tag.author || '协作者'}</b> <time>{commentTime(comment.time)}</time>
            <span className="board-peek-text"><MentionText text={comment.text || (comment.image?'图片':'')} mentions={comment.mentions}/></span>
          </span>}
        </span>
        <svg className="board-comment-avatar" viewBox="0 0 36 36" aria-hidden="true">
          <circle cx="18" cy="18" r="13" fill="var(--pin-avatar)"/>
          {tag.resolved ? <path d="m13 18 3.2 3 7-7" fill="none" stroke="var(--pin-shell)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/> :
            initial ? <text x="18" y="18" dy=".33em" textAnchor="middle" fill="var(--pin-shell)" fontSize="12" fontFamily="system-ui,sans-serif" fontWeight="650">{initial}</text> :
            <path d="M12 23c0-6 12-6 12 0m-6-5a3 3 0 1 0 0-6 3 3 0 0 0 0 6" fill="var(--pin-shell)"/>}
        </svg>
      </button>
    })}
    {active && !app.selectedElementsAreBeingDragged && <BoardEdgeHandles key={active.id} editor={editor} box={active} note={!!activeNote} act={(id,side,drop)=>{
      if(activeNote){onNeighbor(id,side,drop);return}
      if(!ordinary)return
      if (!drop) { setPicker({id, side}); return }
      const target=[...editor.getSceneElements()].reverse().find(el=>el.id!==id && !el.locked && (extensibleShape(el) || boardTag(el)?.kind==='sticky') && containsPoint(el, drop))
      connectNotes(editor,id,side,target?.id || drop)
    }}/>}
    {picker && ordinary && active && <EdgeShapePicker key={picker.id + picker.side} side={picker.side}
      anchor={pointOnSide({x:active.left,y:active.top,width:active.width,height:active.height,angle:active.angle},picker.side,25)}
      width={app.width} height={app.height} close={()=>setPicker(null)}
      choose={shape=>{connectNotes(editor,ordinary.id,picker.side,{shape});setHover('');setPicker(null)}}/>}
  </div>
}
