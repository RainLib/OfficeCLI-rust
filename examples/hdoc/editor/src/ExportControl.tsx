import { useState } from 'react'
import { api, type Session } from './api.ts'

const formats = ['docx', 'xlsx', 'pptx', 'pdf', 'html', 'md', 'txt'] as const

export function ExportControl({ session, revision, beforeExport }: {
  session: Session
  revision: number | null
  beforeExport?: () => Promise<number | null>
}) {
  const [format, setFormat] = useState<string>(session.format === 'markdown' ? 'md' : session.format)
  const [pdfMode, setPdfMode] = useState<'visual' | 'source'>('visual')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState<{ url: string; filename: string; previewUrl?: string } | null>(null)

  async function prepare() {
    setBusy(true)
    setError('')
    setReady(null)
    try {
      const savedRevision = beforeExport ? await beforeExport() : revision
      if (savedRevision === null) throw new Error('文档修订尚未加载')
      if (session.format === 'pdf' && format === 'pdf' && pdfMode === 'visual' && savedRevision !== 0) {
        throw new Error('修改后的 PDF 无法用原始页面图像完整导出；请选择“保留源 PDF”并检查保真报告')
      }
      const source = format === session.format && (
        ['pptx', 'xlsx'].includes(session.format) || (session.format === 'pdf' && pdfMode === 'source'))
      const response = await api(session,
        `/downloads/${format}?revision=${savedRevision}${source ? '&source=true' : ''}`, { method: 'POST' })
      const ticket = await response.json() as { url: string; filename: string }
      const base = new URL(session.apiUrl || '/v1/documents', window.location.href)
      const url = new URL(ticket.url, base.origin).href
      const previewUrl = new URL(window.location.href)
      previewUrl.searchParams.set('pdfPreview', `${new URL(url).pathname}/preview`)
      setReady({ url, filename: ticket.filename, previewUrl: format === 'pdf' ? previewUrl.href : undefined })
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  return <div className="export-control">
    <label>导出格式 <select aria-label="导出格式" value={format} onChange={event => { setFormat(event.target.value); setReady(null) }}>
      {formats.map(item => <option key={item} value={item}>{item.toUpperCase()}</option>)}
    </select></label>
    {session.format === 'pdf' && format === 'pdf' && <label>PDF 内容
      <select aria-label="PDF 内容" value={pdfMode} onChange={event => { setPdfMode(event.target.value as 'visual' | 'source'); setReady(null) }}>
        <option value="visual">与原始预览一致（页面图像）</option>
        <option value="source">保留源 PDF（可选文本）</option>
      </select>
    </label>}
    <button onClick={() => void prepare()} disabled={busy}>{busy ? '准备中…' : ready ? '重新准备' : '准备下载'}</button>
    {ready?.previewUrl && <a className="export-preview" href={ready.previewUrl} target="_blank" rel="noopener noreferrer">预览导出 PDF</a>}
    {ready && <a className="download-ready" href={ready.url} download={ready.filename} rel="noreferrer" aria-label={`下载 ${ready.filename}`}>下载文件</a>}
    {error && <span className="export-error" title={error}>{error}</span>}
  </div>
}
