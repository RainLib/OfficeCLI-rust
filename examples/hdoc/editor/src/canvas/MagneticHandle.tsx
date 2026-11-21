import { useEffect, useRef, type ButtonHTMLAttributes } from 'react'

/** The hit target is stationary. Its face follows the pointer and springs back on leave. */
export function MagneticHandle({
  children,
  onPointerMove,
  onPointerLeave,
  onPointerCancel,
  ...button
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const face = useRef<HTMLSpanElement>(null)
  const motion = useRef({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, frame: 0, last: 0 })
  useEffect(() => {
    const state = motion.current
    return () => cancelAnimationFrame(state.frame)
  }, [])
  function attract(x: number, y: number) {
    const m = motion.current
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cancelAnimationFrame(m.frame)
      Object.assign(m, { x: 0, y: 0, vx: 0, vy: 0, frame: 0 })
      face.current?.style.removeProperty('transform')
      return
    }
    m.tx = x
    m.ty = y
    if (m.frame) return
    m.last = performance.now()
    function tick(now: number) {
      const dt = Math.min(0.032, (now - m.last) / 1000)
      m.last = now
      // Two small integration steps keep the return consistent at 30–144 Hz.
      for (let step = 0; step < 2; step++) {
        const h = dt / 2
        m.vx += ((m.tx - m.x) * 530 - m.vx * 29) * h
        m.vy += ((m.ty - m.y) * 530 - m.vy * 29) * h
        m.x += m.vx * h
        m.y += m.vy * h
      }
      const settled = Math.hypot(m.tx - m.x, m.ty - m.y) < 0.025 && Math.hypot(m.vx, m.vy) < 0.25
      if (settled) {
        m.x = m.tx
        m.y = m.ty
        m.vx = 0
        m.vy = 0
      }
      if (face.current) face.current.style.transform = `translate3d(${m.x}px,${m.y}px,0)`
      m.frame = settled ? 0 : requestAnimationFrame(tick)
    }
    m.frame = requestAnimationFrame(tick)
  }
  return (
    <button
      type="button"
      {...button}
      onPointerMove={(e) => {
        onPointerMove?.(e)
        if (e.pointerType === 'touch' || e.buttons) return
        const rect = e.currentTarget.getBoundingClientRect()
        attract(
          (e.clientX - rect.left - rect.width / 2) * 0.36,
          (e.clientY - rect.top - rect.height / 2) * 0.36,
        )
      }}
      onPointerLeave={(e) => {
        attract(0, 0)
        onPointerLeave?.(e)
      }}
      onPointerCancel={(e) => {
        attract(0, 0)
        onPointerCancel?.(e)
      }}
    >
      <span className="mind-handle-motion" ref={face}>
        <span className="mind-handle-face">{children}</span>
      </span>
    </button>
  )
}
