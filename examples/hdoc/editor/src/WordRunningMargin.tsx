import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { api, type Session } from './api.ts'
import { FixedPreviewFrame } from './FixedPreviewFrame.tsx'
import { wordRunningContent, type WordRunningContent } from './wordPresentation.ts'
import { useI18n } from './i18n.tsx'
import { localizeSource } from './sourceLocale.tsx'
import { layoutWordRunningImages } from './wordRunningLayout.ts'

/** Running content is presentation outside the editable CRDT body. Continuous
 * editing shows its first header and final section's default footer; the paged
 * preview remains authoritative for first/even variants and page-number fields. */
export function WordRunningMargin({ editor, session, kind }: { editor: Editor; session: Session; kind: 'header' | 'footer' }) {
  const { locale } = useI18n()
  const [content, setContent] = useState<WordRunningContent | null>(()=>wordRunningContent(editor))
  const [source, setSource] = useState(''), [error, setError] = useState('')
  const frame = useRef<HTMLIFrameElement>(null), observer = useRef<ResizeObserver | null>(null)
  const assets = useRef(new Map<string, Promise<string>>()), urls = useRef<string[]>([])
  const alive = useRef(true)
  useEffect(() => {
    const update = () => setContent(wordRunningContent(editor))
    editor.on('transaction', update); update()
    return () => { editor.off('transaction', update) }
  }, [editor])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; observer.current?.disconnect(); urls.current.forEach(url=>URL.revokeObjectURL(url)); assets.current.clear() }
  }, [])
  const html = content?.[kind] || '', styles = content?.styles || ''
  useEffect(() => {
    if (!html) return
    let active = true
    const prepare = async () => {
      const document = new DOMParser().parseFromString(html, 'text/html')
      // Cached Word field results are not page numbers for a continuous view.
      document.querySelectorAll('[data-hcd-field]').forEach(field=>{ field.textContent = '…' })
      let markup = document.body.innerHTML
      const hashes = [...new Set([...markup.matchAll(/asset:\/\/sha256\/([0-9a-f]{64})/g)].map(match=>match[1]))]
      if (hashes.length > 64) throw new Error('页眉页脚图片过多')
      const resolved = await Promise.all(hashes.map(hash=>{
        let resource = assets.current.get(hash)
        if (!resource) {
          resource = api(session, `/assets/${hash}`).then(response=>response.blob()).then(blob=>{
            if (blob.size > 64 * 1024 * 1024) throw new Error('页眉页脚图片过大')
            if (!alive.current) throw new DOMException('Aborted', 'AbortError')
            const url = URL.createObjectURL(blob); urls.current.push(url); return url
          })
          assets.current.set(hash, resource); void resource.catch(()=>assets.current.delete(hash))
        }
        return resource.then(url=>[hash, url] as const)
      }))
      if (!active) return
      for (const [hash, url] of resolved) markup = markup.replaceAll(`asset://sha256/${hash}`, url)
      setSource(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src blob: data:; base-uri 'none'; form-action 'none'"><style>${styles.replace(/<\/style/gi, '<\\/style')}</style><style>html{margin:0;padding:0;background:transparent}body{margin:0!important;padding:0!important;width:100%!important;min-width:0!important;max-width:none!important;min-height:0!important;height:auto!important;background:transparent!important;box-shadow:none!important;font:12pt 'Times New Roman',serif}.word-running-content{display:flow-root!important;content-visibility:visible!important;contain:none!important}</style></head><body data-hcd-source-format="docx" data-hcd-profile="semantic-flow">${markup}</body></html>`)
      setError('')
    }
    void prepare().catch(cause=>{ if (active) setError(String(cause)) })
    return () => { active = false }
  }, [html, styles, session])
  if (!html) return null
  const ready = () => {
    observer.current?.disconnect()
    const element = frame.current, content = element?.contentDocument?.querySelector('.word-running-page')
    if (!element || !content) return
    element.inert = true; element.tabIndex = -1
    const measure = () => { element.style.height = `${Math.ceil(content.getBoundingClientRect().height)}px` }
    element.style.visibility = 'hidden'
    void element.contentDocument!.fonts.ready.then(()=>{
      if (!alive.current || !content.isConnected) return
      layoutWordRunningImages(element.contentDocument!,kind)
      observer.current = new ResizeObserver(measure); observer.current.observe(content); measure()
      element.style.visibility = ''
    })
  }
  const label = localizeSource(locale, kind === 'header' ? '页眉' : '页脚')
  return <section className={`word-running-margin word-running-${kind}`} aria-label={label} contentEditable={false}>
    {source && <FixedPreviewFrame frame={frame} source={source} sandbox="allow-same-origin" height={0} title={label} onReady={ready} />}
    {error && <p role="alert">{error}</p>}
  </section>
}
