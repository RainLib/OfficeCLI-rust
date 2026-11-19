import { useEffect, useRef, useState } from 'react'
import { ExternalLink, FileText, RefreshCw, Sparkles, Table2 } from 'lucide-react'
import type { Session } from '../api.ts'
import { useResourceWorkspace } from './ResourceWorkspace.tsx'
import { findResourceSession, readResource, type ResourcePreview, type ResourceReference } from './resourceReference.ts'

export function ResourceCard({ reference, owner }: { reference: ResourceReference; owner: Session }) {
  const workspace = useResourceWorkspace(), source = workspace && findResourceSession(reference, workspace.sessions, owner)
  const root = useRef<HTMLElement>(null), [preview, setPreview] = useState<ResourcePreview | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [visible, setVisible] = useState(false)
  const refKey = JSON.stringify(reference)
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
  async function enter(ai = false) {
    try { await workspace?.navigate(reference, owner, ai) }
    catch (cause) { setError(String(cause)) }
  }
  return <article ref={root} className="resource-card" data-resource-document={reference.documentId} aria-label="白板资源引用">
    <header>{reference.anchor.kind === 'sheet-range' ? <Table2 size={18} /> : <FileText size={18} />}<div><strong>{source?.title || (source ? reference.documentId : '受保护的资源')}</strong><small>{preview?.label || (source ? '资源引用' : '需要源文件访问权限')}</small></div><button type="button" aria-label="刷新资源预览" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={14} /></button></header>
    <div className="resource-card-preview">
      {!source ? <p>请先在工作空间打开源文件，验证权限后显示预览。</p> : error ? <p role="status" className="resource-error">{error}</p> : !preview ? <p role="status">正在读取预览…</p> : preview.rows ? <table><thead><tr><th /><>{preview.columns?.map(c => <th key={c}>{c}</th>)}</></tr></thead><tbody>{preview.rows.map((row, r) => <tr key={r}><th>{(preview.firstRow || 1) + r}</th>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody></table> : <p className="resource-document-excerpt">{preview.text || '当前内容暂无文字预览。'}</p>}
    </div>
    <footer><span>{preview ? `跟随原文 · r${preview.revision}` : '引用源文件'}<small>双击卡片可操作</small></span><button type="button" disabled={!preview} onClick={() => void enter()}><ExternalLink size={13} />进入源文件</button>{source?.scope === 'write' && <button type="button" disabled={!preview} aria-label="让 AI 编辑引用" onClick={() => void enter(true)}><Sparkles size={14} /></button>}</footer>
  </article>
}
