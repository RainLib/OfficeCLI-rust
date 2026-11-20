import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react'
import { useI18n } from './i18n'
import { LocalText, localizeSource } from './sourceLocale'
import {
  animationKinds, animationTriggers, isExit, isInstant, validAnimationOrder,
  type AnimationKind, type AnimationTrigger, type SlideAnimation, type SlideAnimationDraft,
} from './pptxAnimation'
import './pptx-animations.css'

type Row = SlideAnimation & { id: string }
const toRow = (effect: SlideAnimation): Row => ({ ...effect, id: crypto.randomUUID() })

export function PptxAnimations({ draft, save, close }: {
  draft: SlideAnimationDraft
  save: (effects: SlideAnimation[]) => Promise<void>
  close: () => void
}) {
  const { locale } = useI18n(), title = useId(), dialog = useRef<HTMLDialogElement>(null)
  const [rows, setRows] = useState(() => draft.effects.map(toRow))
  const [target, setTarget] = useState(
    () => draft.objects.find(object => object.nodeId === draft.selected)?.id ?? draft.objects[0]?.id ?? '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const labels = new Map(draft.objects.map(object => [object.id, localizeSource(locale, object.label)]))
  const addExit = rows.some(effect => effect.target === target && !isExit(effect.kind))
  const canAdd = target && rows.length < 100 && !rows.some(effect => effect.target === target && isExit(effect.kind))
  const invalidOrder = !validAnimationOrder(rows)

  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  function update(id: string, change: Partial<SlideAnimation>) {
    setRows(previous => previous.map(row => row.id === id ? { ...row, ...change } : row))
  }

  function move(index: number, delta: number) {
    setRows(previous => {
      const next = [...previous]
      const adjacent = index + delta
      const moving = next[index]
      next[index] = next[adjacent]
      next[adjacent] = moving
      return next
    })
  }

  return <dialog ref={dialog} className="hcd-dialog pptx-animation-dialog" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <header>
      <h2 id={title}><LocalText source="幻灯片动画" /></h2>
      <button type="button" className="icon-btn" disabled={busy} onClick={close}
        aria-label={localizeSource(locale, '关闭')}><X size={18} /></button>
    </header>
    {draft.locked ? <p className="pptx-animation-empty"><LocalText source="本页含高级原生动画，将随 PPTX 保留。请在 PowerPoint 中编辑此动画轨道。" /></p> :
      <form onSubmit={async event => {
        event.preventDefault()
        if (busy || invalidOrder) return
        setBusy(true)
        setError('')
        try {
          await save(rows.map(({ id: _, ...effect }) => effect))
          close()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }}>
        <div className="pptx-animation-add">
          <label><LocalText source="幻灯片对象" />
            <select aria-label={localizeSource(locale, '幻灯片对象')} value={target} disabled={busy || !draft.objects.length}
              onChange={event => setTarget(event.target.value)}>
              {!draft.objects.length && <option value=""><LocalText source="没有可用对象" /></option>}
              {draft.objects.map(object => <option key={object.id} value={object.id}>{labels.get(object.id)}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy || !canAdd}
            onClick={() => setRows(previous => [...previous, toRow({
              target, kind: addExit ? 'fadeOut' : 'fadeIn', trigger: 'onClick', durationMs: 400, delayMs: 0,
            })])}><Plus size={16} /><LocalText source="添加动画" /></button>
        </div>
        {rows.length ? <ol className="pptx-animation-steps" role="list">{rows.map((row, index) => <li key={row.id}>
          <div className="pptx-animation-row-title">
            <span className="pptx-animation-number">{index + 1}</span>
            <strong title={labels.get(row.target)}>{labels.get(row.target) ?? localizeSource(locale, '原生对象')}</strong>
            <div className="pptx-animation-row-actions">
              <button type="button" className="icon-btn" disabled={busy || index === 0}
                aria-label={localizeSource(locale, '上移动画')} onClick={() => move(index, -1)}><ArrowUp size={15} /></button>
              <button type="button" className="icon-btn" disabled={busy || index === rows.length - 1}
                aria-label={localizeSource(locale, '下移动画')} onClick={() => move(index, 1)}><ArrowDown size={15} /></button>
              <button type="button" className="icon-btn" disabled={busy}
                aria-label={localizeSource(locale, '移除动画')} onClick={() => setRows(previous => previous.filter(item => item.id !== row.id))}><Trash2 size={15} /></button>
            </div>
          </div>
          <div className="pptx-animation-fields">
            <label><LocalText source="效果" />
              <select aria-label={localizeSource(locale, '效果')} disabled={busy} value={row.kind} onChange={event => {
                const kind = event.target.value as AnimationKind
                update(row.id, { kind, durationMs: isInstant(kind) ? 1 : (isInstant(row.kind) ? 400 : row.durationMs) })
              }}>{Object.entries(animationKinds).map(([kind, label]) => <option key={kind} value={kind}>{localizeSource(locale, label)}</option>)}</select>
            </label>
            <label><LocalText source="开始" />
              <select aria-label={localizeSource(locale, '开始')} disabled={busy} value={row.trigger} onChange={event => update(row.id, { trigger: event.target.value as AnimationTrigger })}>
                {Object.entries(animationTriggers).map(([trigger, label]) => <option key={trigger} value={trigger}>{localizeSource(locale, label)}</option>)}
              </select>
            </label>
            <label><LocalText source="时长（毫秒）" />
              <input aria-label={localizeSource(locale, '时长（毫秒）')} type="number" required min={1} max={60000} disabled={busy || isInstant(row.kind)}
                value={row.durationMs || ''} onChange={event => update(row.id, { durationMs: event.target.valueAsNumber || 0 })} />
            </label>
            <label><LocalText source="延迟（毫秒）" />
              <input aria-label={localizeSource(locale, '延迟（毫秒）')} type="number" required min={0} max={60000} disabled={busy}
                value={row.delayMs} onChange={event => update(row.id, { delayMs: event.target.valueAsNumber || 0 })} />
            </label>
          </div>
        </li>)}</ol> : <p className="pptx-animation-empty"><LocalText source="给文字框、形状或图片添加动画。" /></p>}
        {invalidOrder && <p className="pptx-animation-error" role="alert"><LocalText source="同一对象可以先进入再退出一次，两段动画需错开。" /></p>}
        {error && <p className="pptx-animation-error" role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={close}><LocalText source="取消" /></button>
          <button type="submit" className="primary" disabled={busy || invalidOrder}><LocalText source={busy ? '正在保存…' : '保存动画'} /></button>
        </footer>
      </form>}
  </dialog>
}
