import { useCallback, useLayoutEffect, useRef } from 'react'
import type { Editor } from '@tiptap/react'
import { Selection, TextSelection } from '@tiptap/pm/state'
import type { Session } from './api.ts'
import { isIndex, readTabState, sameTargetVersion, tabStateKey, writeTabState, type TargetVersion } from './tabState.ts'

type DocumentSelection = { version: TargetVersion; selection: { type: string; anchor?: number; head?: number } }

export function useDocumentTabSelection(session: Session, editor: Editor | null, ready: boolean, revision: number | null) {
  const key = tabStateKey(session, 'document-selection')
  const epoch = session.collaborationEpoch
  const restored = useRef<{ editor: Editor; epoch: number } | null>(null)
  const checkpoint = useRef<TargetVersion | null>(null)
  const persistSelection = useCallback((atRevision: number) => {
    if (!editor || editor.isDestroyed || !key || !ready || epoch === undefined) return
    const revision = checkpoint.current?.collaborationEpoch === epoch
      ? Math.max(atRevision, checkpoint.current.revision) : atRevision
    writeTabState<DocumentSelection>(key, { version: { revision, collaborationEpoch: epoch }, selection: editor.state.selection.toJSON() })
  }, [editor, key, ready, epoch])
  useLayoutEffect(() => {
    if (!editor || !key || !ready || revision === null || epoch === undefined) return
    const persist = () => persistSelection(revision)
    if (restored.current?.editor !== editor || restored.current.epoch !== epoch) {
      restored.current = { editor, epoch }
      const saved = readTabState<DocumentSelection>(key)
      if (saved?.selection && sameTargetVersion(saved.version, revision, epoch)) {
        try {
          const doc = editor.state.doc
          const selection = Selection.fromJSON(doc, saved.selection)
          if (!(selection instanceof TextSelection) || (isIndex(selection.anchor) && isIndex(selection.head)
            && selection.$anchor.parent.inlineContent && selection.$head.parent.inlineContent)) {
            editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta('addToHistory', false))
          }
        } catch { /* An unavailable position is left at the editor's default. */ }
      }
    } else persist()
    editor.on('selectionUpdate', persist)
    window.addEventListener('pagehide', persist)
    return () => {
      editor.off('selectionUpdate', persist)
      window.removeEventListener('pagehide', persist)
    }
  }, [editor, key, ready, revision, epoch, persistSelection])
  return (revision: number) => {
    if (epoch === undefined) return
    checkpoint.current = { revision, collaborationEpoch: epoch }
    persistSelection(revision)
  }
}
