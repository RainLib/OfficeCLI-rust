import { useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Download } from 'lucide-react'
import { api, type Session } from './api.ts'

type ExportMode = {
  id: string; source: boolean; available: boolean; reasonCode: string | null; reason: string | null
  warnings: string[]; fontWarnings: string[]
}
type FormatCapability = { format: string; available: boolean; recommendedMode: string; modes: ExportMode[] }
type ExportCapabilities = { documentId: string; sourceFormat: string; revision: number; headRevision: number; defaultFormat: string; formats: FormatCapability[] }
type Selection = { format: string; mode: string }
const modeLabels: Record<string, string> = {
  source: '保留原结构', visual: '页面视觉', canonical: '保留预览布局', semantic: '内容转换', archive: '文档与历史打包',
}
const warningLabels: Record<string, string> = {
  semantic_rebuild: '根据当前内容重新生成文档，复杂排版可能变化。',
  workbook_features_lost: '公式、图表和工作簿结构无法完整保留在此格式中。',
  pdf_no_ocr: '仅转换已识别内容，不会自动识别扫描图片中的文字或恢复原始表格。',
  pdf_visual_flattened: '按页面视觉生成 PDF，原始可选中文字和矢量结构将转为页面图像；修改位置和字体可能存在偏差。',
  canonical_pagination: '按当前预览内容重新分页，可能与源文件的打印分页不同。',
  word_preview_layout: '与分页预览使用相同的字体、分节、表格、页眉页脚和分页规则。',
  source_pdf_approximate: '保留源 PDF；已修改文字的位置和字体可能存在偏差，请预览检查。',
  archive_history: '包含当前文档及完整历史，仅支持当前版本打包。',
}
const reasonLabels: Record<string, string> = {
  source_missing: '原文件缺失，请选择其他导出方式。',
  source_mismatch: '原文件与导入记录不一致，请选择其他导出方式。',
  source_revision_unsupported: '当前版本的修改无法通过保留原结构导出，请选择其他导出方式。',
  source_unreadable: '原文件无法读取，请选择其他导出方式。',
  history_archive_unavailable: '历史版本无法单独打包 HCD，请返回当前版本。',
  theme_unavailable: '此版本的字体主题不可用，请修复字体配置后重试。',
  layout_engine_unavailable: '高保真 PDF 排版服务不可用，请配置 Chromium 后重试。',
}

export function ExportControl({ session, revision, beforeExport }: {
  session: Session; revision: number | null; beforeExport?: () => Promise<number | null>
}) {
  const { locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<ExportCapabilities | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [loading, setLoading] = useState(false)
  const [planError, setPlanError] = useState('')
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState<{ url: string; filename: string; revision: number; format: string; mode: string; previewUrl?: string } | null>(null)
  const latestRevision = useRef(revision)
  latestRevision.current = revision
  const preparation = useRef<AbortController | null>(null)
  useEffect(() => () => preparation.current?.abort(), [])
  useEffect(() => {
    if (!open || revision === null) return
    const request = new AbortController()
    setLoading(true); setPlanError('')
    void api(session, `/export-capabilities?revision=${revision}`, { signal: request.signal })
      .then(response => response.json() as Promise<ExportCapabilities>).then(result => {
        if (request.signal.aborted) return
        setPlan(result)
        setSelection(previous => {
          if (previous && result.formats.some(item => item.format === previous.format)) return previous
          const initial = result.formats.find(item => item.format === result.defaultFormat)!
          return { format: initial.format, mode: initial.recommendedMode }
        })
      }).catch(cause => { if (!request.signal.aborted) setPlanError(String(cause)) })
      .finally(() => { if (!request.signal.aborted) setLoading(false) })
    return () => request.abort()
  }, [open, revision, session, reload])
  const currentPlan = plan?.revision === revision ? plan : null
  const format = currentPlan?.formats.find(item => item.format === selection?.format)
  const mode = format?.modes.find(item => item.id === selection?.mode)
  const visibleReady = ready?.revision === revision && ready?.format === selection?.format && ready?.mode === selection?.mode ? ready : null
  function select(next: Selection) { setSelection(next); setReady(null); setError('') }

  async function prepare() {
    if (!selection || !mode?.available || !format?.available || busy) return
    const chosen = selection
    const chosenMode = mode
    const request = new AbortController()
    preparation.current?.abort(); preparation.current = request
    setBusy(true); setError(''); setReady(null)
    try {
      const savedRevision = beforeExport ? await beforeExport() : revision
      if (request.signal.aborted) return
      if (savedRevision === null) throw new Error(localizeSource(locale, '文档修订尚未加载'))
      // Saving can create a revision with different export constraints. Recheck
      // the exact saved revision instead of silently changing the chosen mode.
      const checked = await (await api(session, `/export-capabilities?revision=${savedRevision}`, { signal: request.signal })).json() as ExportCapabilities
      if (request.signal.aborted) return
      if (latestRevision.current !== savedRevision) throw new Error(localizeSource(locale, '文档已更新，请重新准备导出。'))
      setPlan(checked)
      const allowed = checked.formats.find(item => item.format === chosen.format)?.modes.find(item => item.id === chosen.mode)
      if (!allowed?.available) throw new Error(localizeSource(locale, reasonLabels[allowed?.reasonCode || ''] || '当前导出方式不可用，请重新选择。'))
      const filename = session.title || session.documentId
      const response = await api(session, `/downloads/${chosen.format}?revision=${savedRevision}${chosenMode.source ? '&source=true' : ''}&filename=${encodeURIComponent(filename)}`, { method: 'POST', signal: request.signal })
      const ticket = await response.json() as { url: string; filename: string; revision: number }
      if (request.signal.aborted) return
      if (latestRevision.current !== savedRevision || ticket.revision !== savedRevision) throw new Error(localizeSource(locale, '文档已更新，请重新准备导出。'))
      if (!ticket.filename?.toLowerCase().endsWith(`.${chosen.format}`)) throw new Error(localizeSource(locale, '下载文件名与所选格式不匹配，请重新准备导出。'))
      const base = new URL(session.apiUrl || '/v1/documents', window.location.href)
      const url = new URL(ticket.url, base.origin).href
      const previewUrl = new URL(window.location.href)
      previewUrl.searchParams.set('pdfPreview', `${new URL(url).pathname}/preview`)
      setReady({ url, filename: ticket.filename, revision: savedRevision, ...chosen, previewUrl: chosen.format === 'pdf' ? previewUrl.href : undefined })
    } catch (cause) { if (!request.signal.aborted) setError(String(cause)) }
    finally { if (!request.signal.aborted) setBusy(false) }
  }

  return <details className="export-control" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><ArrowUpRight size={16} /><LocalText source="导出" /></summary>
    <div className="export-popover">
      <strong><Download size={16} /><LocalText source="导出文档" /></strong>
      {loading && <span role="status"><LocalText source="正在检查导出格式…" /></span>}
      {planError && <div className="export-error" role="alert"><LocalText source="无法获取导出选项。" /><button onClick={() => setReload(value => value + 1)}><LocalText source="重试" /></button></div>}
      <label><LocalText source="导出格式 " /><select disabled={busy || loading || !currentPlan || !!planError} aria-label={localizeSource(locale, '导出格式')} value={selection?.format || ''} onChange={event => {
        const item = currentPlan?.formats.find(item => item.format === event.target.value)
        if (item) select({ format: item.format, mode: item.recommendedMode })
      }}>
        {!currentPlan && <option value=""><LocalText source="等待导出选项" /></option>}
        {currentPlan?.formats.map(item => <option key={item.format} value={item.format} disabled={!item.available}>{item.format.toUpperCase()}{item.available ? '' : ` · ${localizeSource(locale, '不可用')}`}</option>)}
      </select></label>
      {format && <label><LocalText source="导出方式" /><select disabled={busy || loading || !!planError} aria-label={localizeSource(locale, '导出方式')} value={selection?.mode || ''} onChange={event => select({ format: format.format, mode: event.target.value })}>
        {format.modes.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{localizeSource(locale, modeLabels[item.id] || item.id)}{item.available ? '' : ` · ${localizeSource(locale, '不可用')}`}</option>)}
      </select></label>}
      {mode && <div className="export-guidance" aria-live="polite">
        {!mode.available && <p role="alert" title={mode.reason || undefined}>{localizeSource(locale, reasonLabels[mode.reasonCode || ''] || '当前导出方式不可用，请重新选择。')}</p>}
        {mode.id === 'source' && mode.available && <p><LocalText source="优先保留源文档结构和未修改内容。" /></p>}
        {mode.id === 'canonical' && <p><LocalText source="导出当前预览的布局、样式和嵌入资源。" /></p>}
        {format?.modes.filter(item => !item.available && item.id !== mode.id).map(item => <p key={item.id} className="export-unavailable" title={item.reason || undefined}>{localizeSource(locale, modeLabels[item.id] || item.id)}：{localizeSource(locale, reasonLabels[item.reasonCode || ''] || '当前导出方式不可用，请重新选择。')}</p>)}
        {mode.warnings.map(code => <p key={code}>{localizeSource(locale, warningLabels[code] || code)}</p>)}
        {mode.fontWarnings.length > 0 && <details><summary><LocalText source="字体说明" /></summary>{mode.fontWarnings.map((warning, index) => <p key={index}>{localizeDynamic(locale, warning)}</p>)}</details>}
      </div>}
      {currentPlan?.formats.filter(item => !item.available).map(item => <p className="export-guidance" key={item.format}>{item.format.toUpperCase()}：{localizeSource(locale, reasonLabels[item.modes[0]?.reasonCode || ''] || '当前导出方式不可用，请重新选择。')}</p>)}
      <button onClick={() => void prepare()} disabled={busy || loading || !!planError || !mode?.available || !format?.available}>{localizeSource(locale, busy ? '正在生成文件…' : visibleReady ? '重新准备' : '准备下载')}</button>
      {visibleReady?.previewUrl && <a className="export-preview" href={visibleReady.previewUrl}><LocalText source="预览导出 PDF" /></a>}
      {visibleReady && <a className="download-ready" href={visibleReady.url} download={visibleReady.filename} rel="noreferrer" aria-label={localizeDynamic(locale, `下载 ${visibleReady.filename}`)}><LocalText source="下载文件" /></a>}
      {visibleReady && <span className="export-filename" title={visibleReady.filename}>{visibleReady.filename}</span>}
      {error && <span className="export-error" role="alert" title={localizeDynamic(locale, error)}>{localizeDynamic(locale, error)}</span>}
    </div>
  </details>
}
