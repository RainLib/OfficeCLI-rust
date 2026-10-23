import { useEffect, useRef } from 'react'

/** The frame cannot execute scripts or navigate the parent. Same-origin access
 * is used only to measure this already validated HCD chunk and select its nodes. */
export function FlowCanvas({ srcDoc, width, height, scale, selected, onSelect, onHeight, title }: {
  srcDoc: string; width: number; height: number; scale: number; selected: string
  onSelect: (nodeId: string) => void; onHeight: (height: number) => void; title: string
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const cleanup = useRef<() => void>(() => {})
  const selection = useRef(selected)
  const select = useRef(onSelect)
  selection.current = selected
  select.current = onSelect
  const highlight = () => {
    for (const node of frame.current?.contentDocument?.querySelectorAll<HTMLElement>('[data-hcd-node-hash]') || []) {
      node.style.outline = node.getAttribute('data-hcd-id') === selection.current ? '1px dashed #5b8ae4' : ''
      node.style.outlineOffset = '2px'
    }
  }
  useEffect(() => { highlight() }, [selected])
  useEffect(() => () => cleanup.current(), [])
  return <iframe ref={frame} sandbox="allow-same-origin" title={title} srcDoc={srcDoc} referrerPolicy="no-referrer" style={{ width, height, transform: `scale(${scale})` }} onLoad={() => {
    cleanup.current()
    const document = frame.current?.contentDocument
    if (!document?.body) return
    document.body.style.cssText = `margin:0;padding:36px 48px;box-sizing:border-box;width:${width}px;overflow:hidden;background:white`
    const measure = () => onHeight(Math.max(200, Math.ceil(document.body.scrollHeight)))
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    const click = (event: MouseEvent) => {
      event.preventDefault()
      const target = event.target as Element | null
      const node = target?.closest('[data-hcd-node-hash]')
      const id = node?.getAttribute('data-hcd-id')
      select.current(id || '')
    }
    document.addEventListener('click', click)
    highlight()
    measure()
    cleanup.current = () => { observer.disconnect(); document.removeEventListener('click', click) }
  }} />
}
