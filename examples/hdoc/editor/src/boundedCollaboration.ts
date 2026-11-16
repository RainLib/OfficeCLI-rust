import type { CommandProps } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import type { UndoManager } from 'yjs'
import { EDIT_HISTORY_LIMIT } from './editHistory.ts'

/** Preserve Yjs character-level local undo and provide a guarded table fallback.
 * Plugin views are installed again when the room changes, so the cap follows
 * the active UndoManager rather than a detached document. */
export function boundedCollaboration(history: { can: (direction: 'undo' | 'redo') => boolean; travel: (direction: 'undo' | 'redo') => void; edited: () => void }) {
  return Collaboration.extend({
    addCommands() {
      const native = this.parent!()
      return Object.fromEntries((['undo', 'redo'] as const).map(direction => [direction, () => (props: CommandProps) => {
        if (native[direction]!()(props)) return true
        if (!history.can(direction)) return false
        props.tr.setMeta('preventDispatch', true)
        if (props.dispatch) history.travel(direction)
        return true
      }])) as ReturnType<NonNullable<typeof this.parent>>
    },
    addProseMirrorPlugins() {
      return [...this.parent!(), new Plugin({ key: new PluginKey('boundedHistory'),
        view(view) {
          let manager: UndoManager | undefined
          const cap = () => {
            if (!manager) return
            manager.undoStack.splice(0, Math.max(0, manager.undoStack.length - EDIT_HISTORY_LIMIT))
            manager.redoStack.splice(0, Math.max(0, manager.redoStack.length - EDIT_HISTORY_LIMIT))
          }
          const added = () => { cap(); if (manager && !manager.undoing && !manager.redoing) history.edited() }
          const attach = () => {
            const next = yUndoPluginKey.getState(view.state)?.undoManager as UndoManager | undefined
            if (next === manager) return
            manager?.off('stack-item-added', added); manager?.off('stack-item-updated', added)
            manager = next; manager?.on('stack-item-added', added); manager?.on('stack-item-updated', added); cap()
          }
          attach()
          return { update: attach, destroy() { manager?.off('stack-item-added', added); manager?.off('stack-item-updated', added) } }
        },
      })]
    },
  })
}
