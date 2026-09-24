import { useEffect } from 'react'

export type MenuAction = { label: string; action: () => void; disabled?: boolean; separated?: boolean }

export function ContextMenu({ x, y, actions, onClose }: { x: number; y: number; actions: MenuAction[]; onClose: () => void }) {
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.hcd-context-menu')) onClose()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('mousedown', dismiss); window.removeEventListener('keydown', escape) }
  }, [onClose])
  return <div className="hcd-context-menu" role="menu" style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - actions.length * 37 - 12) }}>
    {actions.map(item => <button key={item.label} role="menuitem" className={item.separated ? 'separated' : ''} disabled={item.disabled} onClick={() => { item.action(); onClose() }}>{item.label}</button>)}
  </div>
}
