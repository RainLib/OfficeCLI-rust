import { useId, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { applyFontSize } from './fontSize.ts'
import { selectionTypography } from './selectionTypography.ts'
import { useI18n, type MessageKey } from './i18n.tsx'

const commonSizes = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 54, 60, 72, 96]

export function FontSizeControl({ editor, readOnly }: { editor: Editor | null; readOnly: boolean }) {
  const { t } = useI18n()
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<MessageKey | null>(null)
  const selection = useEditorState({ editor, selector: ({ editor: current }) => current ? {
    ...selectionTypography(current.state), allowed: current.isEditable && current.can().setMark('textTypography', { sizePt: 12 }),
  } : null })
  const disabled = readOnly || !selection?.allowed
  const reset = () => { setDraft(null); setError(null) }
  const apply = () => {
    if (!editor || disabled || draft === null) return
    const result = applyFontSize(editor, draft)
    if (result === 'applied') { reset(); editor.commands.focus() }
    else setError(result === 'invalid' ? 'fontSizeInvalid' : result === 'composing' ? 'finishComposing' : result === 'partialGrapheme' ? 'selectWholeCharacters' : 'fontSizeUnavailable')
  }
  return <div className="font-size-property" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) reset() }}>
    <div className="font-size-control">
      <input className="font-size-input" type="number" list={`${id}-sizes`} min="1" max="1638" step="0.5" aria-label={t('fontSize')}
        value={draft ?? selection?.sizePt ?? ''} placeholder={selection?.mixedSize ? t('mixedStyles') : t('inheritedStyle')}
        disabled={disabled} aria-invalid={error !== null} aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => { setDraft(event.target.value); setError(null) }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); apply() } else if (event.key === 'Escape') { event.preventDefault(); reset(); editor?.commands.focus() } }} />
      <datalist id={`${id}-sizes`}>{commonSizes.map(size => <option key={size} value={size} />)}</datalist>
      <span className="font-size-unit" aria-hidden="true">pt</span>
      <button type="button" disabled={disabled || draft === null} onMouseDown={event => event.preventDefault()} onClick={apply}>{t('applyFontSize')}</button>
    </div>
    {error && <span id={`${id}-error`} className="font-size-error" role="alert">{t(error)}</span>}
  </div>
}
