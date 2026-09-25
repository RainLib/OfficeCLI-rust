import { useEffect } from 'react'
import { Extension, Node } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { history, redo, undo } from '@tiptap/pm/history'
import { keymap } from '@tiptap/pm/keymap'
import { Plugin } from '@tiptap/pm/state'

const limit = 10_000

// Fixed-layout nodes currently carry plain text only. Keep a strict schema so
// formatting that HCD cannot save is never offered or silently discarded.
const fixedTextExtensions = [
  Node.create({ name: 'doc', topNode: true, content: 'paragraph' }),
  Node.create({ name: 'paragraph', group: 'block', content: 'text*', parseHTML: () => [{ tag: 'p' }], renderHTML: () => ['p', 0] }),
  Node.create({ name: 'text', group: 'inline' }),
  Extension.create({
    name: 'fixedTextHistory',
    addProseMirrorPlugins: () => [history(), keymap({ 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo })],
  }),
  Extension.create({
    name: 'fixedTextLimit',
    addProseMirrorPlugins: () => [new Plugin({
      filterTransaction: transaction => !transaction.docChanged || transaction.doc.textContent.length <= limit,
    })],
  }),
]

export function FixedTextBoxEditor({ text, disabled, onChange }: {
  text: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const editor = useEditor({
    extensions: fixedTextExtensions,
    content: { type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] },
    editable: !disabled,
    editorProps: {
      attributes: { class: 'fixed-tiptap-text', role: 'textbox', 'aria-label': '编辑文字', 'aria-multiline': 'false' },
      handleKeyDown: (_view, event) => event.key === 'Enter',
      transformPastedText: pasted => pasted.replace(/[\r\n]+/g, ' '),
    },
    onUpdate: ({ editor: changed }) => onChange(changed.state.doc.textContent),
  })
  useEffect(() => { editor?.setEditable(!disabled) }, [editor, disabled])
  return <EditorContent editor={editor} />
}
