import { useEffect, useRef, useState } from 'react'
import { api, type Session } from './api.ts'
import { ExportControl } from './ExportControl.tsx'
import { FixedTextBoxEditor } from './FixedTextBoxEditor.tsx'

type Manifest = { chunkCount: number; indexPageCount: number; revision: number; source: { format: string } }
type Descriptor = { sequence: number; region: string }
type TextNode = { nodeId: string; nodeHash: string; text: string; editable: boolean }

export function FixedViewer({ session, onClose, embedded }: { session: Session; onClose: () => void; embedded: boolean }) {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [descriptors, setDescriptors] = useState<Descriptor[]>([])
  const [style, setStyle] = useState('')
  const [loadedPages, setLoadedPages] = useState(0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [readOnly, setReadOnly] = useState(session.scope === 'read')
  const [refresh, setRefresh] = useState(0)
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
  async function saveText(node: TextNode, value: string) {
    if (readOnly || !node.editable || saving) return
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/1', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'text.splice', nodeId: node.nodeId, start: 0,
            deleteCount: [...node.text].length, insertText: value,
            precondition: { nodeHash: node.nodeHash } }] }),
      })
      const result = await response.json() as { revision: number }
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      setRefresh(previous => previous + 1)
    } catch (cause) { setError(`${String(cause)}。如文档已被其他人修改，请重新打开。`) }
    finally { setSaving(false) }
  }
  return <div className={`workspace ${embedded ? 'embedded' : ''}`}>
    <header><div><span className="eyebrow">OfficeCLI / HCD / {session.format.toUpperCase()}</span><h1>固定版式编辑器</h1><small>{manifest?.chunkCount ?? '…'} 个分片 · 视口按需加载 · r{manifest?.revision ?? '…'}</small></div><div className="header-actions"><ExportControl session={session} revision={manifest?.revision ?? null} /><button className="ghost" onClick={onClose}>关闭</button></div></header>
    <div className="viewer-controls"><span>{manifest?.source.format.toUpperCase() ?? 'HCD'} · {readOnly ? '只读' : '可编辑文字节点'}{saving ? ' · 保存中…' : ''}</span><span>已索引 {descriptors.length} / {manifest?.chunkCount ?? '…'} 个分片</span>{session.scope === 'write' && <label><input type="checkbox" checked={readOnly} onChange={event => setReadOnly(event.target.checked)} />只读模式</label>}</div>
    <main className="fixed-pages">{descriptors.map(chunk => <LazyChunk key={chunk.sequence} session={session} descriptor={chunk} stylesheet={style} readOnly={readOnly} saving={saving} refresh={refresh} onSave={saveText} />)}<div ref={tail} className="load-tail" /></main>
    {error && <div className="toast error">{error}</div>}
  </div>
}

function LazyChunk({ session, descriptor, stylesheet, readOnly, saving, refresh, onSave }: { session: Session; descriptor: Descriptor; stylesheet: string; readOnly: boolean; saving: boolean; refresh: number; onSave: (node: TextNode, value: string) => Promise<void> }) {
  const [active, setActive] = useState(false)
  const [srcDoc, setSrcDoc] = useState('')
  const [frameHeight, setFrameHeight] = useState(940)
  const [nodes, setNodes] = useState<TextNode[]>([])
  const [selected, setSelected] = useState<TextNode | null>(null)
  const [draft, setDraft] = useState('')
  const marker = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = marker.current
    if (!node) return
    const observer = new IntersectionObserver(entries => setActive(entries[0].isIntersecting), { rootMargin: '1400px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!active) { setSrcDoc(''); setNodes([]); return }
    let live = true
    const render = async () => {
      const chunk = await (await api(session, `/chunks/${descriptor.sequence}`)).json() as { html: string; map: { entries: Array<{ nodeId: string; nodeHash: string; source: { nodeKind: string; editable: boolean } }> } }
      const parsed = new DOMParser().parseFromString(chunk.html, 'text/html')
      const mapped = new Map(Array.from(parsed.querySelectorAll('[data-hcd-id]'), element => [element.getAttribute('data-hcd-id'), element]))
      const textNodes = chunk.map.entries.filter(entry => entry.source.nodeKind !== 'image').map(entry => ({
        nodeId: entry.nodeId, nodeHash: entry.nodeHash,
        text: mapped.get(entry.nodeId)?.textContent || '', editable: entry.source.editable,
      }))
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
        setNodes(textNodes)
        setSelected(null)
        const heightPt = html.match(/height:([0-9.]+)pt/)?.[1]
        if (heightPt) setFrameHeight(Math.max(200, Math.ceil(Number(heightPt) * 4 / 3) + 4))
        setSrcDoc(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}${safeCss}</style></head><body data-hcd-image-hitboxes="off" data-hcd-text-hitboxes="off">${html}</body></html>`)
      }
    }
    void render().catch(cause => { if (live) setSrcDoc(`<p style="padding:24px;color:#b33">${String(cause).replaceAll('<', '&lt;')}</p>`) })
    return () => { live = false }
  }, [active, session, descriptor.sequence, stylesheet, refresh])
  return <div ref={marker} id={`hcd-page-${descriptor.sequence}`} className="fixed-page" style={{ minHeight: srcDoc ? frameHeight : 900 }}>
    {srcDoc ? <iframe sandbox="" title={`HCD 分片 ${descriptor.sequence + 1}`} srcDoc={srcDoc} loading="lazy" referrerPolicy="no-referrer" style={{ height: frameHeight }} />
      : <div className="skeleton">第 {descriptor.sequence + 1} 个分片</div>}
    {!readOnly && nodes.length > 0 && <div className="fixed-text-panel"><strong>第 {descriptor.sequence + 1} 页文字</strong><span>{nodes.filter(node => node.editable).length} 个可编辑节点</span>
      <div className="fixed-text-list">{nodes.filter(node => node.editable).map(node => <button key={node.nodeId} onClick={() => { setSelected(node); setDraft(node.text) }} title={node.nodeId}>{node.text || '（空文字框）'}</button>)}</div>
      {selected && <div className="fixed-text-form"><strong>编辑文字框</strong><FixedTextBoxEditor key={selected.nodeId} text={selected.text} disabled={saving} onChange={setDraft} /><small>使用与 DOCX 相同的 Tiptap 编辑内核；此文字框当前只保存纯文本，最多 10,000 字。</small><div><button disabled={saving || draft === selected.text} onClick={() => void onSave(selected, draft)}>保存文字</button><button onClick={() => setSelected(null)}>取消</button></div></div>}
    </div>}
    {!readOnly && srcDoc && nodes.length === 0 && session.format === 'pdf' && <div className="fixed-text-panel">本页没有可映射的文字节点；扫描图像里的文字需要 OCR 后才能编辑。</div>}
  </div>
}
