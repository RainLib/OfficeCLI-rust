import { useLayoutEffect, useRef } from 'react'
import { Editor, Extension, Node } from '@tiptap/core'
import { history, redo, undo } from '@tiptap/pm/history'
import { keymap } from '@tiptap/pm/keymap'
import { Plugin } from '@tiptap/pm/state'
import { useI18n } from './i18n.tsx'
import { localizeDynamic } from './sourceLocale.tsx'

const limit = 10_000

// Fixed-layout nodes currently carry plain text only. Keep a strict schema so
// formatting that HCD cannot save is never offered or silently discarded.
const fixedTextExtensions = [
  Node.create({ name: 'doc', topNode: true, content: 'paragraph' }),
  Node.create({ name: 'paragraph', group: 'block', content: 'text*', parseHTML: () => [{ tag: 'p' }], renderHTML: () => ['p', 0] }),
  Node.create({ name: 'text', group: 'inline' }),
  Extension.create({
    name: 'fixedTextHistory',
    addProseMirrorPlugins: () => [history({ depth: 20 }), keymap({ 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo })],
  }),
  Extension.create({
    name: 'fixedTextLimit',
    addProseMirrorPlugins: () => [new Plugin({
      filterTransaction: transaction => !transaction.docChanged || transaction.doc.textContent.length <= limit,
    })],
  }),
]

export function FixedTextBoxEditor({ text, disabled, onChange, onReady, autoFocus = false, onSave, onCancel }: {
  text: string
  disabled: boolean
  onChange: (value: string) => void
  onReady?: (editor: Editor | null) => void
  autoFocus?: boolean | 'start' | 'end'
  onSave?: (value: string) => void
  onCancel?: () => void
}) {
  const { locale } = useI18n()
  const host = useRef<HTMLDivElement>(null), editor = useRef<Editor | null>(null)
  const initial = useRef({ text, disabled, locale, autoFocus })
  const callbacks = useRef({ onSave, onCancel, onChange, onReady })
  callbacks.current = { onSave, onCancel, onChange, onReady }
  useLayoutEffect(() => {
    if (!host.current) return
    const options = initial.current
    // Create the view in its final document. Moving EditorContent from the app
    // into an iframe leaves ProseMirror's selectionchange listener on the old
    // document; updateRoot alone does not rebind that listener.
    const instance = new Editor({
      element: host.current,
      extensions: fixedTextExtensions,
      content: { type: 'doc', content: [{ type: 'paragraph', content: options.text ? [{ type: 'text', text: options.text }] : [] }] },
      editable: !options.disabled,
      autofocus: false,
      editorProps: {
        attributes: { class: 'fixed-tiptap-text', role: 'textbox', 'aria-label': localizeDynamic(options.locale, '编辑文字'), 'aria-multiline': 'false' },
        handleKeyDown: (view, event) => {
          if (event.key === 'Escape') { callbacks.current.onCancel?.(); return true }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            callbacks.current.onSave?.(view.state.doc.textContent)
            return true
          }
          return event.key === 'Enter'
        },
        transformPastedText: pasted => pasted.replace(/[\r\n]+/g, ' '),
      },
      onUpdate: ({ editor: changed }) => callbacks.current.onChange(changed.state.doc.textContent),
    })
    editor.current = instance
    if (options.autoFocus) {
      instance.commands.setTextSelection(options.autoFocus === 'start' ? 1 : Math.max(1, instance.state.doc.content.size - 1))
      instance.view.focus()
    }
    return () => { editor.current = null; instance.destroy() }
  }, [])
  useLayoutEffect(() => { if (editor.current?.isEditable === disabled) editor.current.setEditable(!disabled, false) }, [disabled])
  useLayoutEffect(() => { editor.current?.view.dom.setAttribute('aria-label', localizeDynamic(locale, '编辑文字')) }, [locale])
  useLayoutEffect(() => {
    onReady?.(editor.current)
    return () => onReady?.(null)
  }, [onReady])
  return <div ref={host} />
}
