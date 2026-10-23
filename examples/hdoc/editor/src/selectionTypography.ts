import type { Mark } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import { typography } from './typography.ts'

export function selectionTypography(state: EditorState) {
  const families = new Set<string | null>(), sizes = new Set<number | null>()
  const add = (marks: readonly Mark[]) => {
    const font = typography(marks.find(mark => mark.type.name === 'textTypography')?.attrs)
    families.add(font?.family ?? font?.eastAsia ?? font?.latin ?? null)
    sizes.add(font?.sizePt ?? null)
  }
  if (state.selection.empty) add(state.storedMarks || state.selection.$from.marks())
  else state.doc.nodesBetween(state.selection.from, state.selection.to, node => { if (node.isText) add(node.marks) })
  return {
    family: families.size === 1 ? [...families][0] : null,
    sizePt: sizes.size === 1 ? [...sizes][0] : null,
    mixedFamily: families.size > 1,
    mixedSize: sizes.size > 1,
  }
}
