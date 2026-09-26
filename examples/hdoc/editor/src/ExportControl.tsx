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

  async function download() {
    setBusy(true)
    setError('')
    try {
      const savedRevision = beforeExport ? await beforeExport() : revision
      if (savedRevision === null) throw new Error('文档修订尚未加载')
      const source = ['pdf', 'pptx', 'xlsx'].includes(session.format) && format === session.format
      const response = await api(session,
        `/export/${format}?revision=${savedRevision}${source ? '&source=true' : ''}`)
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${session.documentId}-r${savedRevision}.${format}`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  return <div className="export-control">
    <label>导出格式 <select aria-label="导出格式" value={format} onChange={event => setFormat(event.target.value)}>
      {formats.map(item => <option key={item} value={item}>{item.toUpperCase()}</option>)}
    </select></label>
    <button onClick={() => void download()} disabled={busy}>{busy ? '导出中…' : '导出'}</button>
    {error && <span className="export-error" title={error}>{error}</span>}
  </div>
}
