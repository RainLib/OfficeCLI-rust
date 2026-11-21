import { useLayoutEffect, useRef, useState } from 'react'
import type { BoardTool } from './BoardToolGlyph'

/** Position in the canvas's coordinates so embedded boards and scrollable docks work too. */
export function useDockPopover<E extends HTMLElement>(open: BoardTool | null, minimized = false) {
  const ref = useRef<E>(null)
  const [lastOpen, setLastOpen] = useState(open)
  const displayed = open ?? lastOpen

  useLayoutEffect(() => {
    if (open) {
      setLastOpen(open)
      return
    }
    const exit = ref.current?.getAnimations().find(
      animation => animation instanceof CSSAnimation && animation.animationName === 'board-popover-close',
    )
    if (!exit) {
      setLastOpen(null)
      return
    }
    let current = true
    const finish = () => { if (current) setLastOpen(null) }
    void exit.finished.then(finish, finish)
    return () => { current = false }
  }, [open])

  useLayoutEffect(() => {
    const panel = ref.current
    const dock = panel?.closest<HTMLElement>('.board-dock-shell')
    const surface = dock?.closest<HTMLElement>('.canvas-surface')
    const strip = dock?.querySelector('.board-dock-strip')
    const trigger = dock?.querySelector<HTMLElement>(
      minimized ? '.board-restore-dock' : `button[data-tool="${displayed}"]`,
    )
    if (!panel || !dock || !surface || !strip || !trigger) return

    const position = () => {
      const bounds = surface.getBoundingClientRect()
      const dockBounds = dock.getBoundingClientRect()
      const button = trigger.getBoundingClientRect()
      const center = button.left + button.width / 2
      const width = panel.offsetWidth
      // The drawing rack slides out of the pen slot. Other pickers center on their trigger.
      const firstBrush = panel.querySelector<HTMLElement>('.board-brush-rack > button')
      const origin = firstBrush ? panel.clientLeft + firstBrush.offsetLeft + firstBrush.offsetWidth / 2 : width / 2
      const left = Math.max(bounds.left + 8, Math.min(center - origin, bounds.right - width - 8))
      panel.style.left = (left - dockBounds.left) + 'px'
      panel.style.transformOrigin = Math.max(0, Math.min(center - left, width)) + 'px bottom'
      panel.style.setProperty('--dock-panel-room', Math.max(0, dockBounds.top - bounds.top - 17) + 'px')
    }
    position()
    const resize = new ResizeObserver(position)
    for (const element of [panel, dock, surface, trigger]) resize.observe(element)
    strip.addEventListener('scroll', position, { passive: true })
    return () => {
      resize.disconnect()
      strip.removeEventListener('scroll', position)
    }
  }, [displayed, minimized])

  return { ref, displayed, closing: !open }
}
