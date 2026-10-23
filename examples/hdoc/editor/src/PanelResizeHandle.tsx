import { useRef } from 'react'

export function PanelResizeHandle({ side, width, onResize, label, hidden = false }: {
  side: 'left' | 'right'; width: number; onResize: (width: number) => void; label: string; hidden?: boolean
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null)
  const adjust = (value: number) => onResize(Math.round(Math.max(side === 'left' ? 120 : 220, Math.min(side === 'left' ? 340 : 440, value))))
  return <div className="editor-panel-resizer" hidden={hidden} role="separator" aria-label={label} aria-orientation="vertical" aria-valuenow={width} aria-valuemin={side === 'left' ? 120 : 220} aria-valuemax={side === 'left' ? 340 : 440} tabIndex={0}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointerId: event.pointerId, x: event.clientX, width } }}
    onPointerMove={event => { const start = drag.current; if (start?.pointerId === event.pointerId) adjust(start.width + (event.clientX - start.x) * (side === 'left' ? 1 : -1)) }}
    onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); adjust(width + (event.key === 'ArrowRight' ? 10 : -10) * (side === 'left' ? 1 : -1)) } }} />
}
