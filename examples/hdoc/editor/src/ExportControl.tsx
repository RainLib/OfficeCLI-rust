import { useState } from 'react'
import { api, type Session } from './api.ts'

const formats = ['docx', 'xlsx', 'pptx', 'pdf', 'html', 'md', 'txt'] as const

export function ExportControl({ session, revision, beforeExport }: {
  session: Session
  revision: number | null
  beforeExport?: () => Promise<number | null>
}) {
  const [format, setFormat] = useState<string>(session.format === 'markdown' ? 'md' : session.format)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState<{ url: string; filename: string } | null>(null)

  async function prepare() {
    setBusy(true)
    setError('')
    setReady(null)
    try {
      const savedRevision = beforeExport ? await beforeExport() : revision
      if (savedRevision === null) throw new Error('文档修订尚未加载')
      const source = ['pdf', 'pptx', 'xlsx'].includes(session.format) && format === session.format
      const response = await api(session,
        `/downloads/${format}?revision=${savedRevision}${source ? '&source=true' : ''}`, { method: 'POST' })
      const ticket = await response.json() as { url: string; filename: string }
      const base = new URL(session.apiUrl || '/v1/documents', window.location.href)
      setReady({ url: new URL(ticket.url, base.origin).href, filename: ticket.filename })
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  return <div className="export-control">
    <label>导出格式 <select aria-label="导出格式" value={format} onChange={event => { setFormat(event.target.value); setReady(null) }}>
      {formats.map(item => <option key={item} value={item}>{item.toUpperCase()}</option>)}
    </select></label>
    <button onClick={() => void prepare()} disabled={busy}>{busy ? '准备中…' : ready ? '重新准备' : '准备下载'}</button>
    {ready && <a className="download-ready" href={ready.url} download={ready.filename} rel="noreferrer" aria-label={`下载 ${ready.filename}`}>下载文件</a>}
    {error && <span className="export-error" title={error}>{error}</span>}
  </div>
}
