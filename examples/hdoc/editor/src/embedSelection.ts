import { createContext, useContext, useEffect } from 'react'
import type { Editor } from '@tiptap/react'
import type { HcdEmbedSelection } from './public'
import type { Session } from './api'
import { captureDocumentTransfer } from './selectionTransfer'

/** Last canonical commit observed by a host-side agent for this editor. */
export const EmbedCommittedRevision = createContext<number | undefined>(undefined)

/** Host-owned chat may opt into an explicit sentence rewrite gesture. */
export const EmbedSpecRewrite = createContext<((selection: HcdEmbedSelection) => void | Promise<void>) | undefined>(undefined)

export const EmbedSelection = createContext<
  ((selection: HcdEmbedSelection | null) => void) | undefined
>(undefined)

export function useEmbeddedTextSelection(
  session: Session,
  editor: Editor | null,
  ready: boolean,
  revision: number | null,
) {
  const report = useContext(EmbedSelection)
  const { documentId, collaborationEpoch } = session
  useEffect(() => {
    if (!report) return
    if (!ready || !editor || revision === null || collaborationEpoch === undefined) {
      report(null)
      return
    }
    let version = 0
    const read = () => {
      const current = ++version
      report(null)
      if (editor.state.selection.empty) return
      void captureDocumentTransfer(editor)
        .then((target) => {
          if (current === version) report({ documentId, revision, collaborationEpoch, target })
        })
        .catch(() => {
          /* Unmapped or empty selections cannot be delegated. */
        })
    }
    // When returning from a host button, ProseMirror can restore its old
    // anchor on focus before Chrome starts the new mouse selection. Anchor
    // an ordinary gesture at the point the user actually pressed.
    const beginSelection = (event: PointerEvent) => {
      if (event.button !== 0 || event.shiftKey || editor.view.hasFocus()) return
      if (!(event.target instanceof Element) || event.target.closest('[contenteditable="false"]')) return
      const point = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
      if (point && editor.state.doc.resolve(point.pos).parent.isTextblock) {
        editor.commands.setTextSelection(point.pos)
      }
    }
    read()
    const dom = editor.view.dom
    dom.addEventListener('pointerdown', beginSelection, true)
    editor.on('selectionUpdate', read).on('update', read)
    return () => {
      version++
      dom.removeEventListener('pointerdown', beginSelection, true)
      editor.off('selectionUpdate', read).off('update', read)
      report(null)
    }
  }, [report, ready, editor, revision, collaborationEpoch, documentId])
}
