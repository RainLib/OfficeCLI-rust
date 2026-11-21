import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import type { WordPictureAlignment, WordPictureLayout, WordPictureTarget, WordPictureWrap, WordPictureWrapSide } from './wordPictureLayout.ts'
import './word-picture-layout.css'

const layouts: Record<WordPictureWrap, string> = {
  inline: '嵌入型', square: '四周型', topAndBottom: '上下型', behind: '衬于文字下方', inFront: '浮于文字上方',
}
const alignments: Record<WordPictureAlignment, string> = { left: '左对齐', center: '居中', right: '右对齐' }
const sides: Record<WordPictureWrapSide, string> = { bothSides: '两侧', left: '仅左侧', right: '仅右侧', largest: '较宽一侧' }
const EMU_PER_POINT = 12_700
const points = (value?: number) => value === undefined ? '' : String(Math.round(value / EMU_PER_POINT * 100) / 100)

function offset(value: string) {
  return value.trim() ? Math.round(Number(value) * EMU_PER_POINT) : undefined
}

export function WordPictureLayoutDialog({ target, onClose, onSave }: {
  target: WordPictureTarget
  onClose: () => void
  onSave: (layout: WordPictureLayout | null) => Promise<void>
}) {
  const { locale } = useI18n()
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const existing = target.savedLayout
  const [wrap, setWrap] = useState<WordPictureWrap | ''>(existing?.wrap ?? target.currentWrap ?? '')
  const [alignment, setAlignment] = useState<WordPictureAlignment | 'current' | 'offset'>(
    existing?.horizontalAlignment ?? (existing?.horizontalOffsetEmu === undefined ? 'current' : 'offset'),
  )
  const [x, setX] = useState(points(existing?.horizontalOffsetEmu))
  const [y, setY] = useState(points(existing?.verticalOffsetEmu))
  const [distance, setDistance] = useState(points(existing?.textDistanceEmu))
  const [side, setSide] = useState<WordPictureWrapSide | ''>(existing?.wrapSide ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  const floating = wrap && wrap !== 'inline'
  const canWrapText = wrap === 'square' || wrap === 'topAndBottom'

  async function apply(event: FormEvent) {
    event.preventDefault()
    if (!wrap || busy) return
    const draft: WordPictureLayout = { wrap }
    if (floating) {
      if (alignment === 'offset') draft.horizontalOffsetEmu = offset(x)
      else if (alignment !== 'current') draft.horizontalAlignment = alignment
      draft.verticalOffsetEmu = offset(y)
      if (canWrapText) draft.textDistanceEmu = offset(distance)
    }
    if (wrap === 'square' && side) draft.wrapSide = side
    await save(draft)
  }

  async function save(layout: WordPictureLayout | null) {
    if (busy) return
    setBusy(true)
    setFailure('')
    try {
      await onSave(layout)
      onClose()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return <dialog ref={dialog} className="hcd-dialog word-picture-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header><h2 id={titleId}><LocalText source="图片版式" /></h2>
      <button type="button" className="icon-btn" aria-label={localizeSource(locale, '关闭')} onClick={onClose} disabled={busy}><X size={18} /></button>
    </header>
    <div className="word-picture-thumbnail"><img src={target.source} alt={target.alt} /></div>
    <form onSubmit={apply}>
      <div className="word-picture-fields">
        <label><LocalText source="文字环绕" /><select aria-label={localizeSource(locale, '文字环绕')} value={wrap}
          disabled={busy} onChange={event => setWrap(event.target.value as WordPictureWrap | '')}>
          {!wrap && <option value="" disabled>{localizeSource(locale, '选择新的环绕方式')}</option>}
          {Object.entries(layouts).map(([key, label]) => <option key={key} value={key}>{localizeSource(locale, label)}</option>)}
        </select></label>
        {floating && <label><LocalText source="水平位置" /><select aria-label={localizeSource(locale, '水平位置')} value={alignment}
          disabled={busy} onChange={event => setAlignment(event.target.value as typeof alignment)}>
          <option value="current">{localizeSource(locale, '沿用原件位置')}</option>
          {Object.entries(alignments).map(([key, label]) => <option key={key} value={key}>{localizeSource(locale, label)}</option>)}
          <option value="offset">{localizeSource(locale, '相对本列偏移')}</option>
        </select></label>}
        {floating && alignment === 'offset' && <label><LocalText source="水平偏移（磅）" /><input type="number" required
          min="-2000" max="2000" step="any" value={x} disabled={busy} onChange={event => setX(event.target.value)} /></label>}
        {floating && <label><LocalText source="相对段落的垂直偏移（磅）" /><input type="number" min="-2000" max="2000" step="any"
          value={y} placeholder={localizeSource(locale, '沿用原件位置')} disabled={busy} onChange={event => setY(event.target.value)} /></label>}
        {canWrapText && <label><LocalText source="与文字的间距（磅）" /><input type="number" min="0" max="400" step="any"
          value={distance} disabled={busy} onChange={event => setDistance(event.target.value)} /></label>}
        {wrap === 'square' && <label><LocalText source="文字环绕侧" /><select aria-label={localizeSource(locale, '文字环绕侧')} value={side}
          disabled={busy} onChange={event => setSide(event.target.value as WordPictureWrapSide | '')}>
          <option value="">{localizeSource(locale, '沿用原件环绕侧')}</option>
          {Object.entries(sides).map(([key, label]) => <option key={key} value={key}>{localizeSource(locale, label)}</option>)}
        </select></label>}
      </div>
      {failure && <p role="alert">{failure}</p>}
      <footer className="hcd-dialog-actions">
        {existing && <button type="button" className="word-picture-reset" disabled={busy} onClick={() => void save(null)}>
          <LocalText source="恢复原件版式" /></button>}
        <button type="button" disabled={busy} onClick={onClose}><LocalText source="取消" /></button>
        <button className="primary" disabled={!wrap || busy}><LocalText source={busy ? '保存中…' : '应用版式'} /></button>
      </footer>
    </form>
  </dialog>
}
