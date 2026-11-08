import { useEffect,useId,useRef,useState } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import {applyFontSizeCommand,captureFontSizeTarget,fontSizeValue,type FontSizeResult} from './fontSize.ts'
import type {EditorCommandService} from './commands/types.ts'
import { selectionTypography } from './selectionTypography.ts'
import { useI18n, type MessageKey } from './i18n.tsx'

const commonSizes = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 54, 60, 72, 96]

export function FontSizeControl({ editor, readOnly,commands }: { editor: Editor | null; readOnly: boolean;commands?:Pick<EditorCommandService,'execute'> }) {
  const { t } = useI18n()
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<MessageKey | null>(null)
  const [busy,setBusy]=useState(false),target=useRef<object|null>(null),run=useRef(0),working=useRef(false)
  useEffect(()=>{run.current++;target.current=null;working.current=false;setDraft(null);setError(null);setBusy(false);return()=>{run.current++;working.current=false}},[editor])
  const selection = useEditorState({ editor, selector: ({ editor: current }) => current ? {
    ...selectionTypography(current.state), allowed: current.isEditable && current.can().setMark('textTypography', { sizePt: 12 }),
  } : null })
  const disabled = readOnly || busy || !selection?.allowed
  const reset = () => { target.current=null;setDraft(null);setError(null) }
  const apply = async () => {
    if (!editor || disabled || working.current || draft === null) return
    const sizePt=fontSizeValue(draft);if(sizePt===null){setError('fontSizeInvalid');return}
    const ticket=++run.current,input={sizePt,target:target.current??captureFontSizeTarget(editor)};working.current=true;setBusy(true)
    try{
      const result=await (commands?commands.execute('text.fontSize.set',input):applyFontSizeCommand(editor,input)) as FontSizeResult
      if(run.current!==ticket)return
      if(result==='applied'){reset();editor.commands.focus()}
      else{if(result==='changed'){target.current=null;setDraft(null)}setError(result==='changed'?'fontSizeSelectionChanged':result==='invalid'?'fontSizeInvalid':result==='composing'?'finishComposing':result==='partialGrapheme'?'selectWholeCharacters':'fontSizeUnavailable')}
    }catch{if(run.current===ticket)setError('fontSizeUnavailable')}
    finally{if(run.current===ticket){working.current=false;setBusy(false)}}
  }
  return <div className="font-size-property" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) reset() }}>
    <div className="font-size-control">
      <input className="font-size-input" type="number" list={`${id}-sizes`} min="1" max="1638" step="0.5" aria-label={t('fontSize')}
        value={draft ?? selection?.sizePt ?? ''} placeholder={selection?.mixedSize ? t('mixedStyles') : t('inheritedStyle')}
        disabled={disabled} aria-invalid={error !== null} aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => { if(editor&&!target.current)target.current=captureFontSizeTarget(editor);setDraft(event.target.value);setError(null) }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault();void apply() } else if (event.key === 'Escape') { event.preventDefault();reset();editor?.commands.focus() } }} />
      <datalist id={`${id}-sizes`}>{commonSizes.map(size => <option key={size} value={size} />)}</datalist>
      <span className="font-size-unit" aria-hidden="true">pt</span>
      <button type="button" disabled={disabled || draft === null} onMouseDown={event => event.preventDefault()} onClick={()=>void apply()}>{t('applyFontSize')}</button>
    </div>
    {error && <span id={`${id}-error`} className="font-size-error" role="alert">{t(error)}</span>}
  </div>
}
