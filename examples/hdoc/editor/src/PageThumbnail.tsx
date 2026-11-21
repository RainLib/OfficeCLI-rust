import { useEffect, useRef, useState } from 'react'
import { LocalText } from './sourceLocale.tsx'

export type PagePreview = { html: string; width: number; height: number }

/** Reuse the canonical page already rendered in the viewport; never recreate its layout. */
export function PageThumbnail({ preview, format, onFrameReady }: {
  preview?: PagePreview; format: string; onFrameReady?: (doc: Document) => void
}) {
  const container = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(140)
  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  return <span className="page-thumbnail" ref={container} style={{ aspectRatio: preview ? `${preview.width} / ${preview.height}` : format === 'pptx' ? '16 / 9' : '3 / 4' }} aria-hidden="true">
    {preview ? <iframe data-hcd-thumbnail srcDoc={preview.html} title="" sandbox={onFrameReady ? 'allow-same-origin' : ''} tabIndex={-1} inert
      onLoad={onFrameReady && (event => {
        const doc = event.currentTarget.contentDocument
        if (doc?.querySelector('.hcd-slide')) onFrameReady(doc)
      })}
      width={preview.width} height={preview.height} style={{ width: preview.width, height: preview.height, transform: `scale(${width / preview.width})` }} /> : <span><LocalText source="滚动到页面后显示缩略图" /></span>}
  </span>
}
