import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react'
import { Copy, GripVertical, Plus, Trash2 } from 'lucide-react'
import { PageThumbnail, type PagePreview } from './PageThumbnail.tsx'
import { LeftPanelShell } from './LeftPanelShell.tsx'
import type { Session } from './api.ts'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import { useI18n } from './i18n.tsx'

export type NavigationPage = { chunkId: string; sequence: number }
type Drop = { chunkId: string; after: boolean }

export function SlideNavigator({ session, pages, previews, format, hidden, busy, writable, revision, activeId, hasMore, onMore, onClose, onSearch, onWorkspace, onSettings, onSelect, onMove, onCopy, onDelete, onAdd, onVisible }: {
  session: Session; onSearch: () => void; onWorkspace: () => void; onSettings: () => void
  pages: NavigationPage[]; previews: Record<number, PagePreview>; format: string; hidden: boolean; busy: boolean; writable: boolean
  revision: number | null; activeId: string | null; hasMore: boolean; onMore: () => void; onClose: () => void
  onSelect: (page: NavigationPage) => void; onMove: (chunkId: string, targetIndex: number) => void
  onCopy: (chunkId: string) => void; onDelete: (chunkId: string) => void; onAdd: () => void
  onVisible: (chunkId: string) => void
}) {
  const { locale } = useI18n()
  const pptx = format === 'pptx', editable = pptx && writable && !busy
  const nav = useRef<HTMLElement>(null), moving = useRef<string | null>(null), dropRef = useRef<Drop | null>(null)
  const [dragging, setDragging] = useState<string | null>(null), [drop, setDrop] = useState<Drop | null>(null)
  const pointer = useRef<{id:number; chunk:string; x:number; y:number} | null>(null)
  const skipClick = useRef(false)
  const clear = () => { pointer.current = null; moving.current = null; dropRef.current = null; setDragging(null); setDrop(null) }
  useEffect(clear, [revision, hidden, writable])
  useEffect(() => {
    if (!nav.current || hidden) return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) onVisible((entry.target as HTMLElement).dataset.slideId!)
    }, { root: nav.current, rootMargin: '160px' })
    nav.current.querySelectorAll('[data-slide-id]').forEach(card => observer.observe(card))
    return () => observer.disconnect()
  }, [pages, hidden, onVisible])
  const identify = (element: HTMLElement, clientY: number) => {
    const bounds = element.getBoundingClientRect()
    const chunkId = element.dataset.slideId!
    const fraction = (clientY - bounds.top) / bounds.height
    // Dropping in the middle of an adjacent thumbnail swaps the two slides.
    const after = fraction >= .65 || fraction > .35 && pages.findIndex(p => p.chunkId === chunkId) > pages.findIndex(p => p.chunkId === moving.current)
    const next = { chunkId, after }
    dropRef.current = next
    setDrop(previous => previous?.chunkId === next.chunkId && previous.after === next.after ? previous : next)
    const list = nav.current, viewport = list?.getBoundingClientRect()
    if (list && viewport) {
      if (clientY < viewport.top + 40) list.scrollTop -= 18
      else if (clientY > viewport.bottom - 40) list.scrollTop += 18
    }
  }
  const commit = () => {
    const source = moving.current, target = dropRef.current
    const from = pages.findIndex(page => page.chunkId === source), to = pages.findIndex(page => page.chunkId === target?.chunkId)
    clear()
    if (!editable || from < 0 || to < 0 || !source || !target) return
    const insertion = to + (target.after ? 1 : 0), destination = insertion > from ? insertion - 1 : insertion
    if (destination !== from) onMove(source, destination)
  }
  const dragOver = (event: DragEvent<HTMLElement>) => {
    if (!editable || !moving.current) return
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; identify(event.currentTarget, event.clientY)
  }
  function locate(x:number,y:number) {
    const list = nav.current, bounds = list?.getBoundingClientRect()
    if (!list || !bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return false
    const cards = Array.from(list.querySelectorAll<HTMLElement>('[data-slide-id]'))
    const target = cards.find(card => y <= card.getBoundingClientRect().bottom) ?? cards.at(-1)
    if (!target) return false
    identify(target, y)
    return true
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>, chunk: string) {
    const hit=event.target as Element
    if (!editable || !event.isPrimary || event.button !== 0) return
    skipClick.current = false
    if (hit.closest('.slide-actions button:not(.slide-drag-handle)')) return
    // On touch the grip reorders. The thumbnail body stays available for scrolling.
    if (event.pointerType === 'touch' && !hit.closest('.slide-drag-handle')) return
    pointer.current = {id:event.pointerId,chunk,x:event.clientX,y:event.clientY}
    const button = hit.closest('button') || event.currentTarget
    button.setPointerCapture(event.pointerId)
  }
  function pointerMove(event: PointerEvent<HTMLElement>) {
    const press = pointer.current
    if (!press || event.pointerId !== press.id) return
    if (!moving.current) {
      if (Math.hypot(event.clientX-press.x,event.clientY-press.y) < 5) return
      moving.current = press.chunk
      setDragging(press.chunk)
      skipClick.current = true
    }
    if (!locate(event.clientX,event.clientY)) { dropRef.current=null;setDrop(null) }
  }
  return <LeftPanelShell session={session} hidden={hidden} className={`page-navigator ${pptx ? 'slide-navigator' : ''}`} label={pptx ? '幻灯片目录' : '页面目录'} onClose={onClose} onSearch={onSearch} onWorkspace={onWorkspace} onSettings={onSettings}>
    <div className="panel-head"><h2><LocalText source={pptx ? '幻灯片' : '页面'} /></h2></div>
    <nav ref={nav} onPointerMove={pointerMove} onPointerUp={e=>{
      if (pointer.current?.id !== e.pointerId) return
      if (moving.current && locate(e.clientX,e.clientY)) commit(); else clear()
    }} onPointerCancel={clear} onLostPointerCapture={()=>{if(pointer.current)clear()}}
      onClickCapture={e=>{if(skipClick.current && e.detail){e.preventDefault();e.stopPropagation();skipClick.current=false}}}
      onKeyDown={e=>{if(e.key==='Escape' && pointer.current)clear()}} aria-label={localizeSource(locale, pptx ? '幻灯片列表' : '页面列表')}>
      {pages.map((page, index) => <div key={page.chunkId} data-slide-id={page.chunkId} className={`slide-card${activeId === page.chunkId ? ' is-active' : ''}${dragging === page.chunkId ? ' is-dragging' : ''}${drop?.chunkId === page.chunkId ? drop.after ? ' drop-after' : ' drop-before' : ''}`}
        onPointerDown={e=>pointerDown(e,page.chunkId)} draggable={editable} onDragStart={event => {
          if (pointer.current) {event.preventDefault();return}
          if (!editable || (event.target as Element).closest('.slide-actions button:not(.slide-drag-handle)')) { event.preventDefault(); return }
          moving.current = page.chunkId; setDragging(page.chunkId); event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('application/x-officecli-slide', page.chunkId)
        }} onDragOver={dragOver} onDrop={event => { if (moving.current) { event.preventDefault(); event.stopPropagation(); commit() } }} onDragEnd={clear}>
        <button className="slide-thumbnail-button" aria-label={localizeDynamic(locale, pptx ? `幻灯片 ${index + 1}` : `第 ${index + 1} 页`)} aria-current={activeId === page.chunkId ? 'page' : undefined}
          aria-keyshortcuts={editable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined} onClick={() => onSelect(page)} onKeyDown={event => {
            if (!editable || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
            event.preventDefault()
            const destination = index + (event.key === 'ArrowUp' ? -1 : 1)
            if (destination >= 0 && destination < pages.length) onMove(page.chunkId, destination)
          }}><PageThumbnail preview={previews[page.sequence]} format={format} /><span className="slide-number">{String(index + 1).padStart(2, '0')}</span></button>
        {pptx && writable && <div className="slide-actions">
          <button className="slide-drag-handle" aria-label={localizeDynamic(locale, `拖动幻灯片 ${index + 1} 排序`)} title={localizeSource(locale, '拖动排序 · Alt + ↑ / ↓')} disabled={busy}><GripVertical size={14} /></button>
          <button aria-label={localizeDynamic(locale, `复制幻灯片 ${index + 1}`)} title={localizeSource(locale, '复制幻灯片')} disabled={busy} onClick={() => onCopy(page.chunkId)}><Copy size={13} /></button>
          <button className="slide-delete" aria-label={localizeDynamic(locale, `删除幻灯片 ${index + 1}`)} title={localizeSource(locale, '删除幻灯片')} disabled={busy || pages.length < 2 && !hasMore} onClick={() => onDelete(page.chunkId)}><Trash2 size={13} /></button>
        </div>}
      </div>)}
      {hasMore && <button className="load-more-pages" disabled={busy} onClick={onMore}><LocalText source="加载更多页面" /></button>}
      {pptx && writable && <button className="add-slide" disabled={busy} onClick={onAdd}><Plus size={14} /><LocalText source="新建幻灯片" /></button>}
    </nav>
    <span className="sr-only" role="status">{dragging ? localizeSource(locale, '正在拖动幻灯片') : ''}</span>
  </LeftPanelShell>
}
