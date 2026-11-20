import { useEffect, useRef, useState, type RefObject } from 'react'
import { api, type Session } from './api'

export const ocrTextSelector = '.hcd-pdf-text:is([data-hcd-mapping="ocr"], [data-hcd-mapping="source-ocr"])'
export const ocrSelectionCss = `
  ${ocrTextSelector} { min-width:0; color:transparent!important; text-shadow:none!important; user-select:text; }
  :is(${ocrTextSelector}) > [data-hcd-id] { display:inline-block; transform-origin:left center; }
  :is(${ocrTextSelector}) ::selection { color:transparent; background:#2478df55; }
`

export function fitOcrSelection(doc: Document) {
  for (const line of doc.querySelectorAll<HTMLElement>(ocrTextSelector)) {
    const text = line.querySelector<HTMLElement>(':scope > [data-hcd-id]')
    if (!text?.offsetWidth || !line.clientWidth) continue
    text.style.transform = `scaleX(${line.clientWidth / text.offsetWidth})`
  }
}

type DetailRaster = { image: HTMLImageElement; original: string; url: string; dpi: number }

/** Keep a low-resolution image ready at all times, and decode the higher
 * resolution rendition offscreen before swapping the visible pixels. */
export function usePdfRaster(
  session: Session,
  marker: RefObject<HTMLDivElement | null>,
  image: HTMLImageElement | null,
  page: number,
  zoom: number,
  contentKey: string,
  enabled: boolean,
) {
  const [visible, setVisible] = useState(false)
  const installed = useRef<DetailRaster | null>(null)
  useEffect(() => {
    if (!enabled || !marker.current || !image) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '45px' })
    observer.observe(marker.current)
    return () => observer.disconnect()
  }, [enabled, image, marker])
  useEffect(() => () => {
    if (installed.current) URL.revokeObjectURL(installed.current.url)
  }, [])

  const demand = zoom * Math.max(1, window.devicePixelRatio || 1)
  const dpi = demand > 3 ? 384 : demand > 2 ? 288 : demand > 1.12 ? 192 : 96
  useEffect(() => {
    function restore() {
      const previous = installed.current
      if (!previous) return
      if (previous.image.getAttribute('src') === previous.url) previous.image.src = previous.original
      previous.image.removeAttribute('data-hcd-detail-dpi')
      URL.revokeObjectURL(previous.url)
      installed.current = null
    }
    if (!enabled || !visible || !image || !page || dpi === 96) {
      restore()
      return
    }
    const previous = installed.current
    const current = image.getAttribute('src')
    if (!current) return
    if (previous?.image === image && current === previous.url && previous.dpi >= dpi) return
    const original = previous?.image === image && current === previous.url ? previous.original : current
    const request = new AbortController()
    const timer = window.setTimeout(() => {
      void api(session, '/pdf-render/' + page + '?dpi=' + dpi, { signal: request.signal })
        .then(response => response.blob())
        .then(async blob => {
          if (request.signal.aborted || !image.isConnected) return
          const url = URL.createObjectURL(blob)
          try {
            const decoded = new Image()
            decoded.src = url
            await decoded.decode()
            if (request.signal.aborted || !image.isConnected || decoded.naturalWidth <= image.naturalWidth && decoded.naturalHeight <= image.naturalHeight) {
              URL.revokeObjectURL(url)
              return
            }
            const old = installed.current
            image.src = url
            image.dataset.hcdDetailDpi = String(dpi)
            installed.current = { image, original, url, dpi }
            if (old) URL.revokeObjectURL(old.url)
          } catch {
            URL.revokeObjectURL(url)
          }
        })
        .catch(() => { /* The canonical raster remains visible. */ })
    }, 180)
    return () => { request.abort(); window.clearTimeout(timer) }
  }, [session, image, page, dpi, enabled, visible, contentKey])
}
