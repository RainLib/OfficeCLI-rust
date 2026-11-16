import { ArrowDown, ArrowUp, Bold, ChevronDown, ClipboardPaste, Copy, Heading2, Italic, Link, List, Pencil, Plus, Redo2, Rows3, Sparkles, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic } from './sourceLocale.tsx'
import { FloatingLayer } from './FloatingLayer.tsx'
import { useHostPolicy } from './HostIntegration.tsx'

export type MenuAction = { label: string; action: () => void; disabled?: boolean; separated?: boolean; icon?: ReactNode; accent?: boolean; shortcut?: string; secondary?: boolean }
export function actionIcon(label: string) {
  const Icon = /Agent|AI/.test(label) ? Sparkles : /复制/.test(label) ? Copy : /粘贴/.test(label) ? ClipboardPaste : /删除|移除/.test(label) ? Trash2 : /上移/.test(label) ? ArrowUp : /下移/.test(label) ? ArrowDown : /撤销/.test(label) ? Undo2 : /重做/.test(label) ? Redo2 : /加粗/.test(label) ? Bold : /斜体/.test(label) ? Italic : /链接/.test(label) ? Link : /标题/.test(label) ? Heading2 : /列表|项目符号/.test(label) ? List : /新增|插入/.test(label) ? Plus : /单元格|选中/.test(label) ? Rows3 : Pencil
  return <Icon size={16} />
}
export type MenuCount = { label: string; value: string; onChange: (value: string) => void }

export function ContextMenu({ x, y, actions, count, title = '内容操作', onClose }: { x: number; y: number; actions: MenuAction[]; count?: MenuCount; title?: string; onClose: () => void }) {
  const host = useHostPolicy()
  actions = actions.filter(action => (!/Agent|AI/.test(action.label) || host.permits('ai.read')) && (!/复制/.test(action.label) || host.permits('document.copy')))
  const { locale } = useI18n()
  const root = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const previousFocus = useRef<Element | null>(document.activeElement)
  const close = useRef(onClose); close.current = onClose
  const [position, setPosition] = useState({ left: Math.max(8, x), top: Math.max(8, y) })
  useLayoutEffect(() => {
    const reposition = () => {
      const bounds = root.current?.getBoundingClientRect()
      if (bounds) setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) })
    }
    reposition()
    const observer = new ResizeObserver(reposition)
    if (root.current) observer.observe(root.current)
    window.addEventListener('resize', reposition)
    root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    return () => { observer.disconnect(); window.removeEventListener('resize', reposition) }
  }, [x, y])
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close.current() }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
      close.current()
      if (previousFocus.current instanceof HTMLElement && previousFocus.current.isConnected) previousFocus.current.focus({ preventScroll: true })
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape) }
  }, [])
  return <FloatingLayer><div ref={root} className="hcd-context-menu" role="menu" aria-label={localizeDynamic(locale, title)} style={position} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target instanceof HTMLInputElement) return
    event.preventDefault()
    const buttons = [...root.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }}>
    <div className="context-menu-heading"><LocalText source={title} /><span>OfficeCLI</span></div>
    {count && <label className="hcd-context-menu-count">{localizeDynamic(locale, count.label)}<input type="number" min="1" max="100" step="1" value={count.value} onChange={event => count.onChange(event.target.value)} /></label>}
    <div className="context-menu-actions">{actions.filter(item => expanded || !item.secondary).map(item => <button key={item.label} role="menuitem" className={`${item.separated ? 'separated' : ''} ${item.accent ? 'menu-accent' : ''}`} disabled={item.disabled} onClick={() => { item.action(); onClose() }}><span className="menu-icon" aria-hidden="true">{item.icon ?? actionIcon(item.label)}</span><span className="menu-label">{localizeDynamic(locale, item.label)}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}
      {actions.some(item => item.secondary) && <button role="menuitem" className="separated" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span className="menu-icon"><Pencil size={16} /></span><span className="menu-label"><LocalText source={expanded ? '收起编辑操作' : '更多编辑操作'} /></span><ChevronDown size={13} style={{ transform: expanded ? 'rotate(180deg)' : undefined }} /></button>}
    </div>
    <div className="context-menu-footer" aria-hidden="true"><LocalText source="↑ ↓ 选择" /><span><LocalText source="↵ 执行" /></span><LocalText source="Esc 关闭" /></div>
  </div></FloatingLayer>
}
