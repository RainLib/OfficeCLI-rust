import { useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import { useEffect, useState } from 'react'
import { api, type Session } from './api.ts'

const formats = ['docx', 'xlsx', 'pptx', 'pdf', 'html', 'md', 'txt', 'hcd'] as const
const spreadsheetFormats = ['xlsx', 'csv', 'tsv']
type SourceCapability = { available: boolean; reason: string | null }

export function ExportControl({ session, revision, beforeExport, activeSheetName }: {
  session: Session
  revision: number | null
  beforeExport?: () => Promise<number | null>
  activeSheetName?: string
}) {
  const { locale } = useI18n()
  const [format, setFormat] = useState<string>(session.format === 'markdown' ? 'md' : session.format)
  const [pdfMode, setPdfMode] = useState<'visual' | 'source'>('visual')
  const [docxMode, setDocxMode] = useState<'semantic' | 'source'>('semantic')
  const [pdfPages, setPdfPages] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [checked, setChecked] = useState<{ key: string; source?: SourceCapability; error?: string }>()
  const [ticket, setTicket] = useState<{ url: string; filename: string; revision: number; previewUrl?: string; sheet?: string } | null>(null)
  const showPdfPages = session.format === 'pdf' && format === 'pdf'
  const showDocxMode = session.format === 'docx' && format === 'docx'
  const showSourceMode = showPdfPages || showDocxMode
  const source = (showDocxMode && docxMode === 'source') || (showPdfPages && pdfMode === 'source')
    || (format === session.format && ['xlsx', 'pptx'].includes(format))
  const delimited = format === 'csv' || format === 'tsv'
  const sheet = delimited ? activeSheetName : undefined
  const ready = ticket && ticket.sheet === sheet && ticket.revision === revision ? ticket : null
  const availableFormats = spreadsheetFormats.includes(session.format) ? [...formats, 'csv', 'tsv'] : formats
  const pageSelection = showPdfPages ? pdfPages.trim() : ''
  const checkKey = `${session.documentId}:${revision}:${format}:${pageSelection}`
  const capability = checked?.key === checkKey ? checked : undefined
  const sourceDisabled = capability?.source?.available === false

  useEffect(() => {
    if (!showSourceMode || revision === null) return
    const controller = new AbortController()
    const parameters = new URLSearchParams({ revision: String(revision) })
    if (pageSelection) parameters.set('pdfPages', pageSelection)
    const timer = window.setTimeout(() => {
      void api(session, `/export-capabilities/${format}?${parameters}`, { signal: controller.signal })
        .then(response => response.json() as Promise<{ source: SourceCapability }>)
        .then(result => { if (!controller.signal.aborted) setChecked({ key: checkKey, source: result.source }) })
        .catch(reason => { if (!controller.signal.aborted) setChecked({ key: checkKey, error: String(reason) }) })
    }, pageSelection ? 220 : 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [session, revision, format, pageSelection, showSourceMode, checkKey])

  async function prepare() {
    setBusy(true)
    setError('')
    setTicket(null)
    try {
      const savedRevision = beforeExport ? await beforeExport() : revision
      if (savedRevision === null) throw new Error('文档修订尚未加载')
      const parameters = new URLSearchParams({ revision: String(savedRevision) })
      if (source) parameters.set('source', 'true')
      if (showPdfPages && pdfPages.trim()) parameters.set('pdfPages', pdfPages.trim())
      if (sheet !== undefined) parameters.set('sheet', sheet)
      const response = await api(session,
        `/downloads/${format}?${parameters}`, { method: 'POST' })
      const ticket = await response.json() as { url: string; filename: string }
      const base = new URL(session.apiUrl || '/v1/documents', window.location.href)
      const url = new URL(ticket.url, base.origin).href
      const previewUrl = new URL(window.location.href)
      previewUrl.searchParams.set('pdfPreview', `${new URL(url).pathname}/preview`)
      setTicket({ url, filename: ticket.filename, revision: savedRevision, previewUrl: format === 'pdf' ? previewUrl.href : undefined, sheet })
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  return <div className="export-control">
    <label><LocalText source={"导出格式 "} /><select aria-label={localizeSource(locale, "导出格式")} value={format} disabled={busy} onChange={event => { setFormat(event.target.value); setTicket(null) }}>
      {availableFormats.map(item => <option key={item} value={item}>{item.toUpperCase()}</option>)}
    </select></label>
    {showDocxMode && <label className="export-mode"><LocalText source="DOCX 内容 " /><select aria-label={localizeSource(locale, 'DOCX 内容')} value={docxMode} disabled={busy} onChange={event => { setDocxMode(event.target.value as 'semantic' | 'source'); setTicket(null) }}>
      <option value="semantic"><LocalText source="重建可编辑 DOCX" /></option>
      <option value="source" disabled={sourceDisabled}><LocalText source="保留源 DOCX" /></option>
    </select></label>}
    {showPdfPages && <label className="export-mode"><LocalText source={"PDF 内容\n      "} /><select aria-label={localizeSource(locale, "PDF 内容")} title={pdfMode === 'source' ? localizeSource(locale, '保留源 PDF（修订位置近似）') : undefined} value={pdfMode} disabled={busy} onChange={event => { setPdfMode(event.target.value as 'visual' | 'source'); setTicket(null) }}>
        <option value="visual"><LocalText source={"当前修订的页面视觉"} /></option>
        <option value="source" disabled={sourceDisabled}><LocalText source={"保留源 PDF"} /></option>
      </select>
    </label>}
    {showPdfPages && <input className="pdf-page-range" type="text" maxLength={23} value={pdfPages} disabled={busy} onChange={event => { setPdfPages(event.target.value); setTicket(null) }} aria-label={localizeSource(locale, 'PDF 页码范围')} placeholder={localizeSource(locale, '全部页')} title={localizeSource(locale, '可输入单页 2 或连续页 2-5')} />}
    <button onClick={() => void prepare()} disabled={busy || (delimited && !sheet) || (source && sourceDisabled)} title={sheet ? `${localizeSource(locale, '导出工作表')} ${sheet}` : undefined}>{localizeDynamic(locale, busy ? '准备中…' : ready ? '重新准备' : '准备下载')}</button>
    {ready?.previewUrl && <a className="export-preview" href={ready.previewUrl}><LocalText source={"预览导出 PDF"} /></a>}
    {ready && <a className="download-ready" href={ready.url} download={ready.filename} rel="noreferrer" aria-label={localizeDynamic(locale, `下载 ${ready.filename}`)}><LocalText source={"下载文件"} /></a>}
    {error && <span className="export-error" title={localizeDynamic(locale, error)}>{localizeDynamic(locale, error)}</span>}
    {showSourceMode && <span className="export-capability" role="status" title={capability?.source?.reason ?? capability?.error}>
      {capability?.source?.reason ? <><LocalText source="当前修订无法保留源文件" /> · {capability.source.reason}</>
        : capability?.error ? <LocalText source="下载选项检查未完成" />
        : !capability ? <LocalText source="正在检查当前修订的下载选项" />
        : showPdfPages ? <LocalText source={source ? '沿用原 PDF 的文字层和矢量内容' : '视觉版将原页作为图像输出'} />
        : <LocalText source={source ? '保留源包中的版式与部件' : '当前修订也可保留源文件'} />}
    </span>}
  </div>
}
