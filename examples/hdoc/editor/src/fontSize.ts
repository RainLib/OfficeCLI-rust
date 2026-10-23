import type { Editor } from '@tiptap/core'

export function fontSizeValue(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) return null
  const size = Number(value)
  return Number.isFinite(size) && size >= 1 && size <= 1638 && Number.isInteger(size * 2) ? size : null
}

/** setMark merges attrs per run, preserving mixed-script font choices. */
export function applyFontSize(editor: Editor, value: string): 'applied' | 'invalid' | 'readOnly' | 'composing' | 'partialGrapheme' | 'unsupported' {
  const sizePt = fontSizeValue(value)
  if (sizePt === null) return 'invalid'
  if (!editor.isEditable) return 'readOnly'
  if (editor.view.composing) return 'composing'
  if (typeof Intl.Segmenter !== 'function') return 'unsupported'
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const range of editor.state.selection.ranges) {
    for (const position of [range.$from, range.$to]) {
      if (!position.parent.isTextblock) continue
      const text = position.parent.textBetween(0, position.parent.content.size, '', '\n')
      const offset = position.parentOffset
      if (offset !== text.length && segmenter.segment(text).containing(offset)?.index !== offset) return 'partialGrapheme'
    }
  }
  if (!editor.can().setMark('textTypography', { sizePt })) return 'unsupported'
  return editor.commands.setMark('textTypography', { sizePt, explicitSize: true }) ? 'applied' : 'unsupported'
}
