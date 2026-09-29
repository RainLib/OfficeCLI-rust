import { useEffect } from 'react'
import { useI18n } from './i18n.tsx'
import { localizeDynamic } from './sourceLocale.tsx'

export type MenuAction = { label: string; action: () => void; disabled?: boolean; separated?: boolean }
export type MenuCount = { label: string; value: string; onChange: (value: string) => void }

export function ContextMenu({ x, y, actions, count, onClose }: { x: number; y: number; actions: MenuAction[]; count?: MenuCount; onClose: () => void }) {
  const { locale } = useI18n()
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.hcd-context-menu')) onClose()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('mousedown', dismiss); window.removeEventListener('keydown', escape) }
  }, [onClose])
  return <div className="hcd-context-menu" role="menu" style={{ left: Math.min(x, window.innerWidth - 220), top: Math.max(8, Math.min(y, window.innerHeight - actions.length * 37 - (count ? 55 : 0) - 12)) }}>
    {count && <label className="hcd-context-menu-count">{localizeDynamic(locale, count.label)}<input type="number" min="1" max="100" step="1" value={count.value} onChange={event => count.onChange(event.target.value)} /></label>}
    {actions.map(item => <button key={item.label} role="menuitem" className={item.separated ? 'separated' : ''} disabled={item.disabled} onClick={() => { item.action(); onClose() }}>{localizeDynamic(locale, item.label)}</button>)}
  </div>
}
