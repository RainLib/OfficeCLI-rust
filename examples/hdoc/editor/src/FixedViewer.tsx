import { useEffect, useRef, useState } from 'react'
import { api, type Session } from './api.ts'
import { ExportControl } from './ExportControl.tsx'

type Manifest = { chunkCount: number; indexPageCount: number; revision: number; source: { format: string } }
type Descriptor = { sequence: number; region: string }

export function FixedViewer({ session, onClose, embedded }: { session: Session; onClose: () => void; embedded: boolean }) {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [descriptors, setDescriptors] = useState<Descriptor[]>([])
  const [style, setStyle] = useState('')
  const [loadedPages, setLoadedPages] = useState(0)
  const [error, setError] = useState('')
  const tail = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    Promise.all([api(session, '').then(response => response.json()), api(session, '/styles').then(response => response.text())])
      .then(([info, css]) => { if (live) { setManifest(info as Manifest); setStyle(css) } })
      .catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [session])
  useEffect(() => {
    if (!manifest || loadedPages >= manifest.indexPageCount) return
    const marker = tail.current
    if (!marker) return
    const observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return
      observer.disconnect()
      const page = loadedPages
      void api(session, `/index/${page}`).then(response => response.json())
        .then((index: { chunks: Descriptor[] }) => {
          setDescriptors(previous => [...previous, ...index.chunks])
          setLoadedPages(page + 1)
        }).catch(cause => setError(String(cause)))
    }, { rootMargin: '1600px' })
    observer.observe(marker)
    return () => observer.disconnect()
  }, [session, manifest, loadedPages, descriptors])
  return <div className={`workspace ${embedded ? 'embedded' : ''}`}>
    <header><div><span className="eyebrow">OfficeCLI / HCD / {session.format.toUpperCase()}</span><h1>{session.format === 'xlsx' ? '工作簿预览' : '固定版式预览'}</h1><small>{manifest?.chunkCount ?? '…'} 个分片 · 视口按需加载</small></div><div className="header-actions"><ExportControl session={session} revision={manifest?.revision ?? null} /><button className="ghost" onClick={onClose}>关闭</button></div></header>
    <div className="viewer-controls"><span>{manifest?.source.format.toUpperCase() ?? 'HCD'} · 只读</span><span>已索引 {descriptors.length} / {manifest?.chunkCount ?? '…'} 个分片</span></div>
    <main className="fixed-pages">{descriptors.map(chunk => <LazyChunk key={chunk.sequence} session={session} descriptor={chunk} stylesheet={style} />)}<div ref={tail} className="load-tail" /></main>
    {error && <div className="toast error">{error}</div>}
  </div>
}

function LazyChunk({ session, descriptor, stylesheet }: { session: Session; descriptor: Descriptor; stylesheet: string }) {
  const [active, setActive] = useState(false)
  const [srcDoc, setSrcDoc] = useState('')
  const [frameHeight, setFrameHeight] = useState(940)
  const marker = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = marker.current
    if (!node) return
    const observer = new IntersectionObserver(entries => setActive(entries[0].isIntersecting), { rootMargin: '1400px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!active) { setSrcDoc(''); return }
    let live = true
    const render = async () => {
      const chunk = await (await api(session, `/chunks/${descriptor.sequence}`)).json() as { html: string }
      const hashes = Array.from(new Set(Array.from(chunk.html.matchAll(/asset:\/\/sha256\/([0-9a-f]{64})/g), match => match[1])))
      if (hashes.length > 64) throw new Error(`分片 ${descriptor.sequence} 引用过多资产`)
      const assets = await Promise.all(hashes.map(async hash => {
        const blob = await (await api(session, `/assets/${hash}`)).blob()
        if (blob.size > 64 * 1024 * 1024) throw new Error('预览资产超过 64 MiB')
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
        return [hash, dataUrl] as const
      }))
      const replacements = new Map(assets)
      const html = chunk.html.replace(/asset:\/\/sha256\/([0-9a-f]{64})/g, (_, hash: string) => replacements.get(hash) || '')
      const safeCss = stylesheet.replace(/<\/style/gi, '<\\/style')
      if (live) {
        const heightPt = html.match(/height:([0-9.]+)pt/)?.[1]
        if (heightPt) setFrameHeight(Math.max(200, Math.ceil(Number(heightPt) * 4 / 3) + 4))
        setSrcDoc(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}${safeCss}</style></head><body data-hcd-image-hitboxes="off" data-hcd-text-hitboxes="off">${html}</body></html>`)
      }
    }
    void render().catch(cause => { if (live) setSrcDoc(`<p style="padding:24px;color:#b33">${String(cause).replaceAll('<', '&lt;')}</p>`) })
    return () => { live = false }
  }, [active, session, descriptor.sequence, stylesheet])
  return <div ref={marker} id={`hcd-page-${descriptor.sequence}`} className="fixed-page" style={{ minHeight: srcDoc ? frameHeight : 900 }}>
    {srcDoc ? <iframe sandbox="" title={`HCD 分片 ${descriptor.sequence + 1}`} srcDoc={srcDoc} loading="lazy" referrerPolicy="no-referrer" style={{ height: frameHeight }} />
      : <div className="skeleton">第 {descriptor.sequence + 1} 个分片</div>}
  </div>
}
