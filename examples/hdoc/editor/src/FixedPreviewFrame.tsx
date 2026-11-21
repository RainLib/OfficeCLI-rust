import { useLayoutEffect, useRef, type RefObject } from 'react'
import { patchPreviewDom } from './patchPreviewDom.ts'

/** Fixed previews need a stable Document for editor portals and Agent anchors.
 * Install the first sandboxed page normally; later revisions swap prepared
 * content in place, without navigating the iframe through a blank document. */
export function FixedPreviewFrame({ source, frame, title, sandbox, height, width, onReady }: {
  source: string; frame: RefObject<HTMLIFrameElement | null>; title: string; sandbox: string
  height: number; width?: string; onReady: () => void
}) {
  const initial = useRef(source), installed = useRef(source), loaded = useRef(false)
  const latest = useRef({ source, onReady })
  latest.current = { source, onReady }
  const update = () => {
    const document = frame.current?.contentDocument
    if (!loaded.current || !document?.body || installed.current === latest.current.source) return
    const next = new DOMParser().parseFromString(latest.current.source, 'text/html')
    patchPreviewDom(document.head, next.head)
    patchPreviewDom(document.body, next.body)
    installed.current = latest.current.source
    latest.current.onReady()
  }
  useLayoutEffect(update, [source])
  return <iframe ref={frame} title={title} sandbox={sandbox} srcDoc={initial.current} loading="lazy" referrerPolicy="no-referrer" style={{ height, width }} onLoad={() => {
    loaded.current = true; update(); latest.current.onReady()
  }} />
}
