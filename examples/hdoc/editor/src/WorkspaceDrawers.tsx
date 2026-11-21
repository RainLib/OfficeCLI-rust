import { useEffect, useRef, useState } from 'react'

/** Shared keyboard dismissal. Narrow screens show one docked pane at a time. */
export function WorkspaceDrawers({ leftOpen, rightOpen, onCloseLeft, onCloseRight }: {
  leftOpen: boolean; rightOpen: boolean; onCloseLeft: () => void; onCloseRight: () => void
}) {
  const root = useRef<HTMLSpanElement>(null)
  const previous = useRef({ leftOpen, rightOpen })
  const callbacks = useRef({ onCloseLeft, onCloseRight })
  callbacks.current = { onCloseLeft, onCloseRight }
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
    if (mobile && leftOpen && rightOpen) {
      if (!last.leftOpen) callbacks.current.onCloseRight()
      else callbacks.current.onCloseLeft()
      return
    }
    const host = root.current?.closest<HTMLElement>('.workspace, .image-workspace')
    if (!host) return
    const side = leftOpen ? 'left' : rightOpen ? 'right' : null
    const drawer = host.querySelector<HTMLElement>(side === 'left' ? '.outline-panel:not([hidden])' : '.workspace-sidebar:not([hidden])')
    if (!side) {
      if (mobile && (last.leftOpen || last.rightOpen)) host.querySelector<HTMLButtonElement>(last.leftOpen ? '.left-sidebar-toggle' : '.right-sidebar-toggle')?.focus({ preventScroll: true })
      return
    }
    if (mobile) drawer?.querySelector<HTMLButtonElement>('.panel-close, .image-drawer-head button')?.focus({ preventScroll: true })
    const keydown = (event: KeyboardEvent) => {
      if (!host.getClientRects().length || host.closest(".document-tab-panel[hidden]")) return
      if (event.key === 'Escape') {
        if (document.querySelector('.hcd-context-menu, [role="dialog"], dialog[open]')) return
        const active = document.activeElement?.closest<HTMLElement>('.workspace-panel')?.dataset.panelSide
        const selectedSide = active || (mobile ? side : null)
        if (!selectedSide) return
        event.preventDefault(); event.stopPropagation()
        if (selectedSide === 'left') callbacks.current.onCloseLeft(); else callbacks.current.onCloseRight()
        host.querySelector<HTMLButtonElement>(selectedSide === 'left' ? '.left-sidebar-toggle' : '.right-sidebar-toggle')?.focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [leftOpen, rightOpen, mobile])
  return <span ref={root} hidden aria-hidden="true" />
}
