import { useEffect, useRef, useState } from 'react'
import { useI18n } from './i18n.tsx'

/** Mobile drawers share one dismissal layer; desktop canvases stay mounted. */
export function WorkspaceDrawers({ leftOpen, rightOpen, onCloseLeft, onCloseRight }: {
  leftOpen: boolean; rightOpen: boolean; onCloseLeft: () => void; onCloseRight: () => void
}) {
  const root = useRef<HTMLButtonElement>(null)
  const previous = useRef({ leftOpen, rightOpen })
  const callbacks = useRef({ onCloseLeft, onCloseRight })
  callbacks.current = { onCloseLeft, onCloseRight }
  const { locale } = useI18n()
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 900px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)')
    const change = () => setMobile(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    const last = previous.current
    previous.current = { leftOpen, rightOpen }
    if (!mobile) return
    if (leftOpen && rightOpen) {
      if (!last.leftOpen) callbacks.current.onCloseRight()
      else callbacks.current.onCloseLeft()
      return
    }
    const host = root.current?.closest<HTMLElement>('.workspace')
    if (!host) return
    const side = leftOpen ? 'left' : rightOpen ? 'right' : null
    const drawer = host.querySelector<HTMLElement>(side === 'left' ? '.outline-panel:not([hidden])' : '.workspace-sidebar:not([hidden])')
    if (!side) {
      if (last.leftOpen || last.rightOpen) host.querySelector<HTMLButtonElement>(last.leftOpen ? '.left-sidebar-toggle' : '.right-sidebar-toggle')?.focus({ preventScroll: true })
      return
    }
    drawer?.querySelector<HTMLButtonElement>('.panel-close')?.focus({ preventScroll: true })
    const keydown = (event: KeyboardEvent) => {
      if (!window.matchMedia('(max-width: 900px)').matches || !host.getClientRects().length) return
      if (event.key === 'Escape') {
        if (document.querySelector('.hcd-context-menu, [role="dialog"]')) return
        event.preventDefault(); event.stopPropagation()
        if (side === 'left') callbacks.current.onCloseLeft(); else callbacks.current.onCloseRight()
      }
      if (event.key === 'Tab' && drawer) {
        const stops = [...drawer.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"],a[href]')].filter(item => item.getClientRects().length)
        const first = stops[0], lastStop = stops.at(-1)
        if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) { event.preventDefault(); lastStop?.focus() }
        else if (!event.shiftKey && (document.activeElement === lastStop || !drawer.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [leftOpen, rightOpen, mobile])
  return <button ref={root} className="workspace-drawer-scrim" hidden={!leftOpen && !rightOpen} tabIndex={-1} aria-label={locale.startsWith('zh') ? '关闭侧栏' : 'Close side panel'} onClick={() => { onCloseLeft(); onCloseRight() }} />
}
