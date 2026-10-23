import { useEffect, useState } from 'react'
import { docxSourceAllowed, readExportOptions, type ExportOptions } from './exportOptions.ts'
import { api, type Session } from './api.ts'
import { useI18n } from './i18n.tsx'

const formats = ['docx', 'xlsx', 'pptx', 'pdf', 'html', 'md', 'txt'] as const

export function ExportControl({ session, revision, beforeExport }: {
  session: Session
  revision: number | null
  beforeExport?: () => Promise<number | null>
}) {
  const { t } = useI18n()
  const sourceFormat = session.format === 'markdown' ? 'md' : session.format
  const [format, setFormat] = useState<string>(sourceFormat)
  const [preferSource, setPreferSource] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [options, setOptions] = useState<ExportOptions | null>(null)
  const [result, setResult] = useState<{ revision: number; fidelity: string | null } | null>(null)
  const sameFormat = format === sourceFormat
  const docx = sameFormat && sourceFormat === 'docx'
  const currentOptions = options?.revision === revision ? options : null
  const rebuild = docx && currentOptions !== null && !docxSourceAllowed(currentOptions)
  const source = sameFormat && preferSource && !rebuild
  const pdfContentExport = sameFormat && sourceFormat === 'pdf' && !source
  useEffect(() => { setError('') }, [revision, format, preferSource])
  useEffect(() => {
    if (!docx || revision === null) return
    const controller = new AbortController()
    void api(session, `/export-options?revision=${revision}`, { signal: controller.signal })
      .then(response => response.json()).then(value => { if (!controller.signal.aborted) setOptions(readExportOptions(value, revision)) })
      .catch(cause => { if (!controller.signal.aborted) setError(String(cause)) })
    return () => controller.abort()
  }, [docx, revision, session])

  async function download() {
    setBusy(true)
    setError('')
    setResult(null)
    let exportRequested = false
    let requestedSource = false
    try {
      const savedRevision = beforeExport ? await beforeExport() : revision
      if (savedRevision === null) throw new Error(t('revisionUnavailable'))
      let useSource = source
      if (docx && preferSource) {
        const latest = readExportOptions(await (await api(session, `/export-options?revision=${savedRevision}`)).json(), savedRevision)
        setOptions(latest)
        useSource = preferSource && docxSourceAllowed(latest)
      }
      requestedSource = useSource
      exportRequested = true
      const response = await api(session,
        `/export/${format}?revision=${savedRevision}${useSource ? '&source=true' : ''}`)
      const fidelity = response.headers.get('x-hcd-fidelity-level')
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${session.documentId}-r${savedRevision}.${format}`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setResult({ revision: savedRevision, fidelity })
    } catch (cause) { setError(`${String(cause)}${requestedSource && exportRequested ? t('sourceExportFallback') : ''}`) }
    finally { setBusy(false) }
  }

  return <div className="export-control">
    <label>{t('exportFormat')} <select aria-label={t('exportFormat')} value={format} onChange={event => setFormat(event.target.value)}>
      {formats.map(item => <option key={item} value={item}>{item.toUpperCase()}</option>)}
    </select></label>
    {sameFormat && <label>{t('exportMode')} <select aria-label={t('exportMode')} value={source ? 'source' : 'semantic'} onChange={event => setPreferSource(event.target.value === 'source')}>
      <option value="source" disabled={rebuild}>{t('preserveSource')}</option>
      <option value="semantic">{t(sourceFormat === 'pdf' || sourceFormat === 'docx' ? 'currentContent' : 'semanticRebuild')}</option>
    </select></label>}
    <button onClick={() => void download()} disabled={busy}>{busy ? t('exporting') : t('export')}</button>
    {sameFormat && <span className="export-mode-hint" title={source ? t('sourceHint') : pdfContentExport ? t('pdfContentExportHint') : t('semanticHint')}>{source ? t('sourceLayout') : pdfContentExport ? t('currentContent') : t('repaginate')}</span>}
    {rebuild && <span className="export-mode-hint">{t(currentOptions?.sourceAvailable ? 'docxRebuildExport' : 'sourceUnavailableExport')}</span>}
    {result && <span className="export-result" role="status">{t('exported', { revision: result.revision })}{result.fidelity ? ` · ${format === 'pdf' && result.fidelity === 'VISUAL' ? t('pdfVisualExportResult') : format === 'docx' && result.fidelity === 'SEMANTIC' ? t('docxCurrentExportResult') : result.fidelity}` : ''}</span>}
    {error && <span className="export-error" title={error}>{error}</span>}
  </div>
}
