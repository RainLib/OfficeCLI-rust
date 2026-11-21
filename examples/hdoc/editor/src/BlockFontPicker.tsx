import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { themeFontOptions, themeFontPatch, type ThemeFace } from './themeCss.ts'
import type { BlockFont } from './schema.ts'

/** Node names that are one HCD block each. A list is not: its items are, so the
 * search stops at the `listItem` and never reaches the paragraph inside it. */
const BLOCK_TYPES = ['paragraph', 'heading', 'listItem']

type CurrentBlock = { type: string; font: BlockFont | null }

/** The block the caret sits in, outermost first, so a list item is chosen over the
 * paragraph it wraps — which is the node `jsonToSnapshot` writes the face from. */
function currentBlock(editor: Editor): CurrentBlock | null {
  const { $from } = editor.state.selection
  for (let depth = 1; depth <= $from.depth; depth += 1) {
    const node = $from.node(depth)
    if (!BLOCK_TYPES.includes(node.type.name)) continue
    return { type: node.type.name, font: (node.attrs.hcdFont as BlockFont | null) ?? null }
  }
  return null
}

/**
 * The block face control for the semantic editor.
 *
 * The families come from the theme the document pins, never from free text, and the
 * slots sent are exactly the ones that theme covers for the chosen family. Clearing
 * is possible here even though a `text.font` patch cannot clear a run: the block
 * model owns the face, so a checkpoint that leaves it out rewrites the block with no
 * markers.
 */
export function BlockFontPicker({ editor, faces, disabled }: { editor: Editor | null; faces: ThemeFace[]; disabled: boolean }) {
  const { locale } = useI18n()
  const [block, setBlock] = useState<CurrentBlock | null>(null)
  const last = useRef<string | null>(null)
  useEffect(() => {
    if (!editor) return
    const sync = () => {
      const current = currentBlock(editor)
      const serialized = JSON.stringify([current?.type ?? '', current?.font ?? null])
      if (serialized === last.current) return
      last.current = serialized
      setBlock(current)
    }
    editor.on('transaction', sync)
    sync()
    return () => {
      editor.off('transaction', sync)
    }
  }, [editor])
  const options = themeFontOptions(faces)
  const family = block?.font?.latin || block?.font?.eastAsia || block?.font?.bidi || ''
  const listed = options.some(option => option.family === family)
  const none = !block || disabled
  const apply = (option: (typeof options)[number] | null) => {
    if (!editor || !block || disabled) return
    editor.chain().focus().updateAttributes(block.type, { hcdFont: option ? themeFontPatch(option) : null }).run()
  }
  return <label className="tool-group font-group" title={localizeSource(locale, options.length
    ? block
      ? '把整段的字体改成钉住主题的字体'
      : '把光标移到段落里再选字体'
    : '文档没有钉住主题字体，先在管理后台钉住主题')}>
    <LocalText source={'字体'} />
    <select
      value={listed ? family : ''}
      disabled={none || options.length === 0}
      onChange={event => apply(options.find(option => option.family === event.target.value) || null)}>
      <option value="">{localizeSource(locale, block?.font ? '清除段落字体' : '选择主题字体')}</option>
      {options.map(option => <option key={option.family} value={option.family}>{option.family}</option>)}
    </select>
  </label>
}
