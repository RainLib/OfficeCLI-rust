import { useId, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useI18n } from './i18n'
import { LocalText, localizeSource } from './sourceLocale'

export type PptxSlideDesign = {
  layoutName: string
  masterName: string
  masterColor: string | null
  layoutBackground: boolean
  slideBackground: boolean
  masterTextStyles?: PptxMasterTextStyle[]
}

export type PptxMasterTextStyle = {
  kind: 'title' | 'body' | 'other'; level: number
  format: { bold?: boolean; italic?: boolean; underline?: boolean; fontSizePt?: number; color?: string }
  font?: { latin?: string; eastAsia?: string; bidi?: string }
}
type TextDraft = { size: string; color: string; latin: string; eastAsia: string; bidi: string; bold: string; italic: string; underline: string }
function textDraft(style: PptxMasterTextStyle | undefined): TextDraft {
  const flag = (value: boolean | undefined) => value === undefined ? '' : String(value)
  return { size: String(style?.format.fontSizePt ?? ''), color: style?.format.color ?? '',
    latin: style?.font?.latin ?? '', eastAsia: style?.font?.eastAsia ?? '', bidi: style?.font?.bidi ?? '',
    bold: flag(style?.format.bold), italic: flag(style?.format.italic), underline: flag(style?.format.underline) }
}

export function PptxMaster({ design, close, save, saveText }: {
  design: PptxSlideDesign | null
  close: () => void
  save: (color: string) => Promise<void>
  saveText: (style: PptxMasterTextStyle) => Promise<void>
}) {
  const { locale } = useI18n()
  const title = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const [color, setColor] = useState(design?.masterColor ?? '#ffffff')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [section, setSection] = useState<'background' | 'text'>('background')
  const [kind, setKind] = useState<PptxMasterTextStyle['kind']>('title')
  const [level, setLevel] = useState(1)
  const key = kind + ':' + level
  const [drafts, setDrafts] = useState<Record<string, TextDraft>>({})
  const original = textDraft(design?.masterTextStyles?.find(style => style.kind === kind && style.level === level))
  const draft = drafts[key] ?? original
  const update = (field: keyof TextDraft, value: string) => setDrafts(previous => ({ ...previous, [key]: { ...draft, [field]: value } }))
  const text: PptxMasterTextStyle = { kind, level, format: {} }
  for (const field of ['bold', 'italic', 'underline'] as const) if (draft[field] && draft[field] !== original[field]) text.format[field] = draft[field] === 'true'
  if (draft.size && draft.size !== original.size) text.format.fontSizePt = Number(draft.size)
  if (draft.color && draft.color.toLowerCase() !== original.color.toLowerCase()) text.format.color = draft.color.toLowerCase()
  for (const field of ['latin', 'eastAsia', 'bidi'] as const) if (draft[field].trim() && draft[field] !== original[field]) (text.font ??= {})[field] = draft[field].trim()
  const valid = section === 'background' ? /^#[0-9a-f]{6}$/i.test(color)
    : (text.format.fontSizePt === undefined || Number.isFinite(text.format.fontSizePt) && text.format.fontSizePt >= 1 && text.format.fontSizePt <= 256)
      && (!text.format.color || /^#[0-9a-f]{6}$/i.test(text.format.color))
      && Object.values(text.font ?? {}).every(value => !/[<>"';:&\u0000-\u001f]/.test(value))
  const changed = section === 'background' ? color.toLowerCase() !== design?.masterColor?.toLowerCase()
    : Object.keys(text.format).length > 0 || !!text.font
  useLayoutEffect(() => {
    const el = dialog.current
    el?.showModal()
    return () => el?.close()
  }, [])

  return <dialog ref={dialog} className="hcd-dialog pptx-master-dialog" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <header>
      <h2 id={title}><LocalText source="幻灯片母版" /></h2>
      <button type="button" className="icon-btn" disabled={busy} onClick={close}
        aria-label={localizeSource(locale, '关闭')}><X size={18} /></button>
    </header>
    {design ? <form onSubmit={async event => {
      event.preventDefault()
      if (busy || !valid || !changed) return
      setBusy(true)
      setError('')
      try {
        if (section === 'background') await save(color.toLowerCase())
        else await saveText(text)
        close()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    }}>
      <dl>
        <div><dt><LocalText source="当前母版" /></dt><dd>{design.masterName}</dd></div>
        <div><dt><LocalText source="当前版式" /></dt><dd>{design.layoutName}</dd></div>
      </dl>
      <nav className="pptx-master-sections" aria-label={localizeSource(locale, '母版编辑内容')}>
        <button type="button" aria-pressed={section === 'background'} disabled={busy} onClick={() => setSection('background')}><LocalText source="背景" /></button>
        <button type="button" aria-pressed={section === 'text'} disabled={busy || !design.masterTextStyles?.length} onClick={() => setSection('text')}><LocalText source="文字样式" /></button>
      </nav>
      {section === 'background' ? <><div className="pptx-master-color">
        <label htmlFor={`${title}-color`}><LocalText source="母版背景" /></label>
        <div>
          <input type="color" id={`${title}-color`} disabled={busy} value={valid ? color : '#ffffff'}
            onChange={event => setColor(event.currentTarget.value)} />
          <input type="text" aria-label={localizeSource(locale, '母版背景色值')} disabled={busy}
            maxLength={7} value={color} onChange={event => setColor(event.currentTarget.value.trim())} />
        </div>
      </div>
      {(design.slideBackground || design.layoutBackground) && <p className="pptx-master-inheritance">
        <LocalText source={design.slideBackground ? '本页使用独立背景。母版背景会应用于继承它的幻灯片。' : '本版式使用独立背景。母版背景会应用于继承它的其他版式。'} />
      </p>}
      </> : <div className="pptx-master-text">
        <div className="pptx-master-text-row">
          <label><LocalText source="文字类型" /><select aria-label={localizeSource(locale, '文字类型')} disabled={busy} value={kind} onChange={event => setKind(event.target.value as PptxMasterTextStyle['kind'])}>
            <option value="title">{localizeSource(locale, '标题')}</option><option value="body">{localizeSource(locale, '正文')}</option><option value="other">{localizeSource(locale, '其他文字')}</option>
          </select></label>
          <label><LocalText source="列表级别" /><select aria-label={localizeSource(locale, '列表级别')} disabled={busy} value={level} onChange={event => setLevel(Number(event.target.value))}>
            {Array.from({ length: 9 }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
          </select></label>
        </div>
        <div className="pptx-master-text-row">
          <label><LocalText source="母版字号" /><input type="number" min="1" max="256" step="0.5" disabled={busy} value={draft.size} placeholder={localizeSource(locale, '跟随主题')} onChange={event => update('size', event.target.value)} /></label>
          <label><LocalText source="母版文字颜色" /><input type="text" maxLength={7} disabled={busy} value={draft.color} placeholder="#112233" onChange={event => update('color', event.target.value.trim())} /></label>
        </div>
        <div className="pptx-master-text-row">
          {(['bold', 'italic', 'underline'] as const).map((field, index) => <label key={field}><LocalText source={['母版加粗', '母版斜体', '母版下划线'][index]} /><select aria-label={localizeSource(locale, ['母版加粗', '母版斜体', '母版下划线'][index])} disabled={busy} value={draft[field]} onChange={event => update(field, event.target.value)}>
            <option value="">{localizeSource(locale, '跟随主题')}</option><option value="true">{localizeSource(locale, '开启')}</option><option value="false">{localizeSource(locale, '关闭')}</option>
          </select></label>)}
        </div>
        {(['latin', 'eastAsia', 'bidi'] as const).map((field, index) => <label key={field}><LocalText source={['西文字体', '东亚字体', '复杂文字字体'][index]} /><input disabled={busy} maxLength={128} value={draft[field]} placeholder={localizeSource(locale, '跟随主题')} onChange={event => update(field, event.target.value)} /></label>)}
        <p className="pptx-master-inheritance"><LocalText source="应用于使用此母版的幻灯片。版式、段落和单独设置的文字格式会保留。" /></p>
      </div>}
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" disabled={busy} onClick={close}><LocalText source="取消" /></button>
        <button type="submit" className="primary" disabled={busy || !valid || !changed}>
          <LocalText source={busy ? '正在保存…' : '应用到母版'} />
        </button>
      </footer>
    </form> : <p className="pptx-master-inheritance"><LocalText source="当前文件未读取到原生母版。重新导入原始 PPTX 后可查看。" /></p>}
  </dialog>
}
