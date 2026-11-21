import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import type {
  WorksheetCondition, WorksheetConditionConfig, WorksheetConditionOperator,
} from '../../xlsx-univer-viewer/src/hcd.ts'
import { formatRange, parseRange } from './resources/resourceReference.ts'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { useI18n } from './i18n.tsx'
import './worksheet-conditions.css'

const operators: Record<WorksheetConditionOperator, string> = {
  greaterThan: '大于',
  greaterThanOrEqual: '大于或等于',
  lessThan: '小于',
  lessThanOrEqual: '小于或等于',
  equal: '等于',
  notEqual: '不等于',
  between: '介于',
  notBetween: '不介于',
}

function address(range: WorksheetConditionConfig['range']): string {
  return formatRange({
    row: range.startRow - 1,
    column: range.startColumn - 1,
    endRow: range.endRow - 1,
    endColumn: range.endColumn - 1,
  })
}

function draftFor(rule: WorksheetCondition | undefined, selection: string) {
  const config = rule?.config
  return {
    id: rule?.id ?? crypto.randomUUID().replaceAll('-', ''),
    range: config ? address(config.range) : selection,
    operator: config?.operator ?? 'greaterThan',
    value: config?.values[0] ?? '0',
    upper: config?.values[1] ?? '',
    fill: config?.fill ?? '#f5dba3',
    color: config?.color ?? '#633b1e',
    useFill: !config || Boolean(config.fill),
    useColor: Boolean(config?.color),
    stopIfTrue: config?.stopIfTrue ?? false,
  }
}

export function WorksheetConditionDialog({ rules, selection, revision, editable, onClose, onSave }: {
  rules: WorksheetCondition[]
  selection: string
  revision: number
  editable: boolean
  onClose: () => void
  onSave: (id: string, config: WorksheetConditionConfig | null, revision: number) => Promise<void>
}) {
  const { locale } = useI18n()
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const [baseRevision, setBaseRevision] = useState(revision)
  const [draft, setDraft] = useState(() => draftFor(rules[0], selection))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const existing = rules.find(rule => rule.id === draft.id)
  const bounded = draft.operator === 'between' || draft.operator === 'notBetween'
  const stale = baseRevision !== revision
  const locked = busy || !editable || stale
  const change = (update: Partial<typeof draft>) => setDraft(previous => ({ ...previous, ...update }))
  const open = (rule?: WorksheetCondition) => {
    setDraft(draftFor(rule, selection))
    setBaseRevision(revision)
    setError('')
  }
  useEffect(() => { dialog.current?.showModal() }, [])

  async function submit(event: FormEvent, remove = false) {
    event.preventDefault()
    if (locked) return
    setError('')
    setBusy(true)
    try {
      if (remove) await onSave(draft.id, null, baseRevision)
      else {
        const range = parseRange(draft.range.replaceAll('$', ''), 1_048_576 * 16_384)
        const values = bounded ? [draft.value, draft.upper] : [draft.value]
        if (values.some(value => !value || !Number.isFinite(Number(value)))) {
          throw new Error(localizeSource(locale, '请输入有效数字。'))
        }
        await onSave(draft.id, {
          range: { startRow: range.row + 1, startColumn: range.column + 1,
            endRow: range.endRow + 1, endColumn: range.endColumn + 1 },
          operator: draft.operator,
          values,
          fill: draft.useFill ? draft.fill : undefined,
          color: draft.useColor ? draft.color : undefined,
          stopIfTrue: draft.stopIfTrue || undefined,
        }, baseRevision)
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return <dialog ref={dialog} className="hcd-dialog worksheet-condition-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header>
      <h2 id={titleId}><LocalText source="条件格式" /></h2>
      <button type="button" aria-label={localizeSource(locale, '关闭')} onClick={onClose} disabled={busy}><X size={16} /></button>
    </header>
    <div className="worksheet-condition-list">
      {rules.map(rule => <button type="button" key={rule.id} aria-pressed={rule.id === draft.id} disabled={busy}
        onClick={() => open(rule)}>
        <span className="worksheet-condition-swatch" aria-hidden="true" style={{ background: rule.config.fill, color: rule.config.color }}>Aa</span>
        <span>{address(rule.config.range)}</span>
        <span><LocalText source={operators[rule.config.operator]} /> {rule.config.values.join(' – ')}</span>
      </button>)}
      {editable && <button type="button" onClick={() => open()} disabled={busy}><Plus size={15} /><LocalText source="新建规则" /></button>}
    </div>
    {stale && <p role="status"><LocalText source="工作簿已更新，请重新选择规则。" /></p>}
    {(editable || existing) && <form onSubmit={submit}>
      <fieldset disabled={locked}>
        <label><LocalText source="应用区域" /><input required value={draft.range} onChange={event => change({ range: event.target.value })} /></label>
        <label><LocalText source="条件" /><select aria-label={localizeSource(locale, '条件')} value={draft.operator}
          onChange={event => change({ operator: event.target.value as WorksheetConditionOperator })}>
          {Object.entries(operators).map(([value, label]) => <option key={value} value={value}>{localizeSource(locale, label)}</option>)}
        </select></label>
        <label><LocalText source="阈值" /><input type="number" required step="any" value={draft.value} onChange={event => change({ value: event.target.value })} /></label>
        {bounded && <label><LocalText source="第二个阈值" /><input type="number" required step="any" value={draft.upper} onChange={event => change({ upper: event.target.value })} /></label>}
        <div className="worksheet-condition-colors">
          <label><input type="checkbox" checked={draft.useFill} onChange={event => change({ useFill: event.target.checked })} /><LocalText source="填充色" /></label>
          <input type="color" aria-label={localizeSource(locale, '规则填充色')} value={draft.fill} disabled={!draft.useFill} onChange={event => change({ fill: event.target.value })} />
          <label><input type="checkbox" checked={draft.useColor} onChange={event => change({ useColor: event.target.checked })} /><LocalText source="文字色" /></label>
          <input type="color" aria-label={localizeSource(locale, '规则文字色')} value={draft.color} disabled={!draft.useColor} onChange={event => change({ color: event.target.value })} />
        </div>
        <label className="worksheet-condition-stop"><input type="checkbox" checked={draft.stopIfTrue} onChange={event => change({ stopIfTrue: event.target.checked })} /><LocalText source="条件成立时停止应用后续规则" /></label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {editable && <footer className="hcd-dialog-actions">
        {existing && <button type="button" className="worksheet-condition-remove" disabled={locked}
          onClick={event => void submit(event, true)}><Trash2 size={15} /><LocalText source="删除规则" /></button>}
        <button type="button" onClick={onClose} disabled={busy}><LocalText source="取消" /></button>
        <button type="submit" className="primary" disabled={locked || !draft.useFill && !draft.useColor}>
          <LocalText source={busy ? '保存中…' : '保存规则'} />
        </button>
      </footer>}
    </form>}
    {!editable && !rules.length && <p><LocalText source="当前工作表没有可预览的条件规则。" /></p>}
  </dialog>
}
