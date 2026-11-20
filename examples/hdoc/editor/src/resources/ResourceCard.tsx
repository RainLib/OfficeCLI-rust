import { useEffect, useRef, useState } from 'react'
import type { Session } from '../api.ts'
import { useResourceWorkspace } from './ResourceWorkspace.tsx'
import { ResourceSheetChart } from './ResourceSheetChart'
import { findResourceSession, readResource, type ResourcePreview, type ResourceReference } from './resourceReference.ts'

export function ResourceCard({ reference, owner, elementId, onFit }: {
  reference: ResourceReference; owner: Session; elementId: string
  onFit: (id: string, referenceKey: string, width: number, height: number) => void
}) {
  const workspace = useResourceWorkspace(), mounted = workspace && findResourceSession(reference, workspace.sessions, owner)
  const root = useRef<HTMLElement>(null), [preview, setPreview] = useState<ResourcePreview | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [visible, setVisible] = useState(false)
  const [resolved, setResolved] = useState<Session | null>(null)
  const source = mounted || resolved
  const refKey = JSON.stringify(reference)
  const ready = !!preview && !error
  useEffect(() => {
    const card = root.current, outer = card?.parentElement
    if (!ready || !card || !outer) return
    const measure = () => {
      if (!card.offsetHeight || !outer.offsetWidth) return
      // offset dimensions are in scene units even while the canvas is zoomed.
      const style = getComputedStyle(outer)
      onFit(elementId, refKey, outer.offsetWidth, Math.ceil(card.offsetHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(card, { box: 'border-box' })
    return () => observer.disconnect()
  }, [elementId, refKey, ready, onFit])
  const resolve = workspace?.resolve
  useEffect(() => {
    setResolved(null)
    if (mounted || !resolve || !visible || workspace?.activeDocument !== owner.documentId) return
    let alive = true
    void resolve(reference.documentId).then(item => {
      if (alive) setResolved(findResourceSession(reference, [item], owner) || null)
    }).catch(cause => { if (alive) setError(String(cause)) })
    return () => { alive = false }
  }, [mounted, resolve, visible, refKey, owner, workspace?.activeDocument, refresh])
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)))
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    setPreview(null); setError('')
    if (!source || !visible || workspace?.activeDocument !== owner.documentId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const data = await readResource(source, reference, controller.signal); if (!controller.signal.aborted) { setPreview(data); setError('') } }
      catch (cause) { if (!controller.signal.aborted) { setPreview(null); setError(String(cause)) } }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [source, refKey, visible, refresh, workspace?.activeDocument, owner.documentId])
  useEffect(() => {
    const card = root.current
    const reload = () => setRefresh(n => n + 1)
    card?.addEventListener('refresh-resource', reload)
    return () => card?.removeEventListener('refresh-resource', reload)
  }, [])
  const label = ['白板资源引用', source?.title || source?.documentId, preview?.label].filter(Boolean).join(' · ')
  return <article ref={root} className="resource-card" data-resource-element={elementId}
    data-resource-document={reference.documentId} data-ready={!!preview && !error}
    data-ai={source?.scope === 'write' && (!workspace?.mayAsk || workspace.mayAsk(reference))} aria-label={label}>
    <div className="resource-card-preview">
      {error ? <p role="status" className="resource-error">{error}</p> :
        !source && !resolve ? <p>请先在工作空间打开源文件，验证权限后显示预览。</p> :
        !preview ? <p role="status">正在读取预览…</p> :
        reference.presentation && reference.presentation !== 'table' ? <ResourceSheetChart preview={preview} type={reference.presentation} /> :
        preview.rows ? <table><thead><tr><th />{preview.columns?.map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{preview.rows.map((row, r) =>
          <tr key={r}><th>{(preview.firstRow || 1) + r}</th>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody></table> :
        <p className="resource-document-excerpt">{preview.text || '当前内容暂无文字预览。'}</p>}
    </div>
  </article>
}
