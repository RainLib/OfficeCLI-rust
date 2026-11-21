import { getExtensionField, type Editor, type AnyConfig } from '@tiptap/core'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { Doc } from 'yjs'

/** Switch only CRDT bindings after the new room has synced. Never merge a stale
 * Y.Doc into a new epoch. Keep EditorView, its DOM and other plugins in place. */
export function rebindCollaboration(editor: Editor, document: Doc, provider: HocuspocusProvider, user: Record<string, unknown>) {
  const extensions = editor.extensionManager.extensions.filter(extension => ['collaboration', 'collaborationCaret'].includes(extension.name))
  const viewport = editor.view.dom.closest('.canvas-viewport')
  const top = viewport?.scrollTop ?? 0, left = viewport?.scrollLeft ?? 0
  for (const extension of extensions) {
    // Extension.options is a getter returning a copy in Tiptap 3. Configure
    // the source of those options, rather than mutating a temporary object.
    const options = { ...extension.options, ...(extension.name === 'collaboration' ? { document, fragment: null } : { provider, user }) }
    extension.config.addOptions = () => options
  }
  const plugins = extensions.flatMap(extension => getExtensionField<AnyConfig['addProseMirrorPlugins']>(extension, 'addProseMirrorPlugins', {
    name: extension.name, options: extension.options, type: null,
    storage: editor.extensionStorage[extension.name as keyof typeof editor.extensionStorage], editor,
  })?.() || [])
  // Remove the old keyed plugin states before installing the new ones. Merely
  // replacing plugins with identical keys would retain the previous Y.Doc.
  const remaining = editor.state.plugins.filter(plugin => !/^(y-sync\$|y-undo\$|yjs-cursor\$|collaborationCaretAwarenessListener\$|filterInvalidContent\$|boundedHistory\$)/.test((plugin as unknown as { key: string }).key))
  const detached = editor.state.reconfigure({ plugins: remaining })
  editor.view.updateState(detached.reconfigure({ plugins: [...plugins, ...remaining] }))
  if (viewport) { viewport.scrollTop = top; viewport.scrollLeft = left }
}
