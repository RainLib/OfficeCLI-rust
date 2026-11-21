import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ScanText, X } from 'lucide-react'
import { api, type Session } from './api'
import { useI18n } from './i18n'
import { LocalText, localizeSource } from './sourceLocale'
import { getRecognitionImage, startPdfOcr, type PdfOcrLine, type PdfOcrPage } from './pdfOcrEngine'
import './pdf-ocr.css'

type Status = { revision: number; pages: PdfOcrPage[] }
type Run = { total: number; completed: number; lines: number; progress: number; finished: boolean }
type OcrSave = (revision: number, page: number, lines: PdfOcrLine[]) => Promise<{ revision: number; added: number }>

export function PdfOcrDialog({ session, sourcePage, position, close, save }: {
  session: Session; sourcePage: number | null; position: number; close: () => void; save: OcrSave
}) {
  const { locale } = useI18n(), title = useId(), dialog = useRef<HTMLDialogElement>(null)
  const worker = useRef<AbortController | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [scope, setScope] = useState<'page' | 'scans'>('page')
  const [language, setLanguage] = useState('chi_sim+eng')
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = run !== null && !run.finished
  const active = status?.pages.find(page => page.page === sourcePage)
  const scans = status?.pages.filter(page => !page.recognized && !page.hasSourceText) ?? []
  const candidates = scope === 'page' ? (active && !active.recognized ? [active] : []) : scans

  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  useEffect(() => {
    const request = new AbortController()
    void api(session, '/pdf-ocr', { signal: request.signal }).then(response => response.json() as Promise<Status>)
      .then(payload => {
        if (request.signal.aborted) return
        setStatus(payload)
        const current = payload.pages.find(item => item.page === sourcePage)
        if (!current || current.recognized) setScope('scans')
      }).catch(error => { if (!request.signal.aborted) setError(String(error)) })
    return () => request.abort()
  }, [session, sourcePage])
  useEffect(() => () => worker.current?.abort(), [])

  async function recognize() {
    if (!candidates.length || !status || worker.current) return
    const controller = new AbortController()
    worker.current = controller
    setError('')
    setRun({ total: candidates.length, completed: 0, lines: 0, progress: 0, finished: false })
    let revision = status.revision
    let engine: Awaited<ReturnType<typeof startPdfOcr>> | undefined
    try {
      const signal = controller.signal
      engine = await startPdfOcr(language, signal, progress => {
        setRun(old => old && { ...old, progress })
      })
      for (const page of candidates) {
        signal.throwIfAborted()
        setRun(old => old && { ...old, progress: 0 })
        const image = await getRecognitionImage(session, page, signal)
        const lines = await engine.lines(image)
        signal.throwIfAborted()
        let added = 0
        if (lines.length) {
          setSaving(true)
          try {
            const result = await save(revision, page.page, lines)
            revision = result.revision
            added = result.added
          } finally {
            setSaving(false)
          }
        }
        setRun(old => old && { ...old, lines: old.lines + added, completed: old.completed + 1, progress: 0 })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = String(error)
        setError(message.includes('no new scanned text was found') ? localizeSource(locale, '此次识别没有新增文字。') : message)
      }
    } finally {
      await engine?.close()
      worker.current = null
      setRun(old => old && { ...old, finished: true })
    }
  }

  function dismiss() {
    if (saving) return
    if (busy) { worker.current?.abort(); return }
    close()
  }

  return <dialog className="hcd-dialog pdf-ocr-dialog" ref={dialog} aria-labelledby={title}
    onCancel={event => { event.preventDefault(); dismiss() }}>
    <header>
      <h2 id={title}><LocalText source="识别扫描文字" /></h2>
      <button type="button" className="icon-btn" onClick={dismiss} disabled={saving}
        aria-label={localizeSource(locale, '关闭')}><X size={18} /></button>
    </header>
    {run ? <div className="pdf-ocr-progress" aria-live="polite">
      {busy && <progress max={run.total} value={Math.min(run.total, run.completed + run.progress)} />}
      <p><LocalText source={busy ? '正在识别' : '已处理'} /> {run.completed} / {run.total} <LocalText source="页" /></p>
      {run.finished && <p><LocalText source="已保存识别文字" /> {run.lines} <LocalText source="行" /></p>}
      {run.finished && run.lines > 0 && <p><LocalText source="拖选文字可复制，双击可校对。导出 PDF 后也可搜索。" /></p>}
      {run.finished && run.lines === 0 && !error && <p><LocalText source="此次识别没有新增文字。" /></p>}
    </div> : <div className="pdf-ocr-options">
      <label><LocalText source="识别范围" />
        <select aria-label={localizeSource(locale, '识别范围')} value={scope} disabled={!status} onChange={event => setScope(event.currentTarget.value as typeof scope)}>
          <option value="page" disabled={!active || active.recognized}>{localizeSource(locale, '当前页')} {position}</option>
          <option value="scans" disabled={!scans.length}>{localizeSource(locale, '所有未识别扫描页')} ({scans.length})</option>
        </select>
      </label>
      <label><LocalText source="识别语言" />
        <select aria-label={localizeSource(locale, '识别语言')} value={language} onChange={event => setLanguage(event.currentTarget.value)}>
          <option value="chi_sim+eng">{localizeSource(locale, '简体中文和英语')}</option>
          <option value="chi_tra+eng">{localizeSource(locale, '繁体中文和英语')}</option>
          <option value="eng">{localizeSource(locale, '英语')}</option>
        </select>
      </label>
      {status && !candidates.length && <p><LocalText source="当前范围没有待识别的扫描页。" /></p>}
    </div>}
    {error && <p role="alert">{error}</p>}
    <footer>
      {busy ? <button type="button" onClick={dismiss} disabled={saving}><LocalText source="停止识别" /></button>
        : run ? <button type="button" className="primary" onClick={close}><LocalText source="完成" /></button>
          : <button type="button" className="primary" disabled={!candidates.length}
            onClick={() => void recognize()}><ScanText size={16} /><LocalText source="开始识别" /></button>}
    </footer>
  </dialog>
}
