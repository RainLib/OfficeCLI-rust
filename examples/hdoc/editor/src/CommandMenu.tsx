import { FloatingLayer } from './FloatingLayer.tsx'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { actionIcon, type MenuAction } from './ContextMenu.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { useI18n } from './i18n.tsx'
import { useHostPolicy } from './HostIntegration.tsx'

export function CommandMenu({ x, y, actions, onClose }: { x: number; y: number; actions: MenuAction[]; onClose: () => void }) {
  const host = useHostPolicy()
  actions = actions.filter(action => (!/Agent|AI/.test(action.label) || host.permits('ai.read')) && (!/复制/.test(action.label) || host.permits('document.copy')))
  const { locale } = useI18n()
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0)
  const [position, setPosition] = useState({ left: x, top: y })
  const filtered = actions.filter(action => localizeSource(locale, action.label).toLowerCase().includes(query.toLowerCase()))
  const chosen = Math.min(index, Math.max(0, filtered.length - 1))
  const execute = (action?: MenuAction) => { if (action && !action.disabled) { action.action(); onClose() } }
  useLayoutEffect(() => {
    const bounds = root.current?.getBoundingClientRect()
    if (bounds) setPosition({ left: Math.max(8, Math.min(x, innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(y, innerHeight - bounds.height - 8)) })
  }, [x, y, query])
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) onClose() }
    window.addEventListener('mousedown', outside)
    return () => window.removeEventListener('mousedown', outside)
  }, [onClose])
  return <FloatingLayer><div ref={root} className="hcd-context-menu command-menu" role="dialog" aria-label={localizeSource(locale, '斜杠命令')} style={{ ...position, maxHeight: 'calc(100vh - 16px)' }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex((chosen + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % Math.max(1, filtered.length)) }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); execute(filtered[chosen]) }
  }}>
    <input ref={input} className="command-search" aria-label={localizeSource(locale, '搜索命令')} placeholder={localizeSource(locale, '搜索命令或 Agent 操作…')} value={query} onChange={event => { setQuery(event.target.value); setIndex(0) }} />
    <div role="menu">{filtered.map((action, i) => <button key={action.label} role="menuitem" disabled={action.disabled} className={i === chosen || action.accent ? 'menu-accent' : ''} onMouseEnter={() => setIndex(i)} onClick={() => execute(action)}><span className="menu-icon" aria-hidden="true">{action.icon ?? actionIcon(action.label)}</span><span className="menu-label"><LocalText source={action.label} /></span></button>)}</div>
    {!filtered.length && <p className="command-footer"><LocalText source="没有匹配的命令" /></p>}
    <p className="command-footer"><LocalText source="↑ ↓ 选择 · Enter 执行 · Esc 关闭" /></p>
  </div></FloatingLayer>
}
