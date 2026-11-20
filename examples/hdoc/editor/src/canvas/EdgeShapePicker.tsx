import { useEffect, useLayoutEffect, useRef } from 'react'
import { shapes, extraShapes, outlines, type ShapeKind } from './boardShapes'
import type { NoteDirection } from './sceneGeometry'

export function EdgeShapePicker({ anchor, side, width, height, close, choose }: {
  anchor: { x: number; y: number }; side: NoteDirection; width: number; height: number
  close: () => void; choose: (shape: ShapeKind) => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const dismiss = useRef(close)
  dismiss.current = close
  useLayoutEffect(() => { panel.current?.querySelector('button')?.focus({preventScroll:true}) }, [])
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Element && !panel.current?.contains(e.target)) dismiss.current()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [])
  const x = side === 'left' ? anchor.x - 154 : side === 'right' ? anchor.x + 16 : anchor.x - 70
  const y = side === 'up' ? anchor.y - 120 : side === 'down' ? anchor.y + 12 : anchor.y - 54
  return <div ref={panel} className="board-edge-palette" role="group" aria-label="选择相邻图形"
    style={{left:Math.max(5,Math.min(x,width-145)),top:Math.max(5,Math.min(y,height-114))}}
    onKeyDown={e=>{
      if (e.key === 'Escape') {
        e.stopPropagation()
        panel.current?.parentElement?.querySelector<HTMLButtonElement>('.board-note-neighbors [data-side="'+side+'"]')?.focus()
        close()
      }
    }}>
    {[...shapes,...extraShapes].map(([kind,label])=><button key={kind} type="button" title={label} aria-label={label} onClick={()=>choose(kind)}>
      {outlines[kind] ? <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points={outlines[kind]!.map(([x,y])=>(2+x*20)+','+(2+y*20)).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg> : <i className={'board-shape-icon '+kind}/>}
    </button>)}
  </div>
}
