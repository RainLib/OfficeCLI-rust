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
  const clear = () => { moving.current = null; dropRef.current = null; setDragging(null); setDrop(null) }
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
    const next = { chunkId: element.dataset.slideId!, after: clientY > bounds.y + bounds.height / 2 }
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
  const touchMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch' || !moving.current) return
    const card = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-slide-id]')
    if (card && nav.current?.contains(card)) identify(card, event.clientY)
  }
  return <LeftPanelShell session={session} hidden={hidden} className={`page-navigator ${pptx ? 'slide-navigator' : ''}`} label={pptx ? '幻灯片目录' : '页面目录'} onClose={onClose} onSearch={onSearch} onWorkspace={onWorkspace} onSettings={onSettings}>
    <div className="panel-head"><h2><LocalText source={pptx ? '幻灯片' : '页面'} /></h2></div>
    <nav ref={nav} aria-label={localizeSource(locale, pptx ? '幻灯片列表' : '页面列表')}>
      {pages.map((page, index) => <div key={page.chunkId} data-slide-id={page.chunkId} className={`slide-card${activeId === page.chunkId ? ' is-active' : ''}${dragging === page.chunkId ? ' is-dragging' : ''}${drop?.chunkId === page.chunkId ? drop.after ? ' drop-after' : ' drop-before' : ''}`}
        draggable={editable} onDragStart={event => {
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
          <button className="slide-drag-handle" aria-label={localizeDynamic(locale, `拖动幻灯片 ${index + 1} 排序`)} title={localizeSource(locale, '拖动排序 · Alt + ↑ / ↓')} disabled={busy} onPointerDown={event => {
            if (event.pointerType !== 'touch' || !editable) return
            moving.current = page.chunkId; setDragging(page.chunkId); event.currentTarget.setPointerCapture(event.pointerId)
          }} onPointerMove={touchMove} onPointerUp={event => { if (event.pointerType === 'touch') { const target = document.elementFromPoint(event.clientX, event.clientY); if (target && nav.current?.contains(target)) commit(); else clear() } }} onPointerCancel={clear}><GripVertical size={14} /></button>
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
