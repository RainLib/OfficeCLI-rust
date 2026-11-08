import type { Editor } from '@tiptap/core'
import {Mark} from '@tiptap/pm/model'

export type FontSizeResult='applied'|'invalid'|'readOnly'|'composing'|'partialGrapheme'|'unsupported'|'changed'
type Target={editor:Editor;document:Editor['state']['doc'];selection:Editor['state']['selection'];marks:Editor['state']['storedMarks']}
const targets=new WeakMap<object,Target>()
/** An ephemeral UI token, never persisted or sent to a server. Switching a
 * region, selection or document invalidates the draft formatting target. */
export function captureFontSizeTarget(editor:Editor):object{
 const token={};targets.set(token,{editor,document:editor.state.doc,selection:editor.state.selection,marks:editor.state.storedMarks});return token
}
export function applyFontSizeCommand(editor:Editor,input:unknown):FontSizeResult{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['sizePt','target'].includes(key)))return 'invalid'
 const value=input as {sizePt?:unknown;target?:unknown}
 if(typeof value.sizePt!=='number'||!Number.isFinite(value.sizePt)||fontSizeValue(String(value.sizePt))===null)return 'invalid'
 if(value.target!==undefined){
  const target=value.target&&typeof value.target==='object'?targets.get(value.target):undefined
  if(!target||target.editor!==editor||target.document!==editor.state.doc||!target.selection.eq(editor.state.selection)||!Mark.sameSet(target.marks??[],editor.state.storedMarks??[]))return 'changed'
 }
 return applyFontSize(editor,String(value.sizePt))
}

export function fontSizeValue(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) return null
  const size = Number(value)
  return Number.isFinite(size) && size >= 1 && size <= 1638 && Number.isInteger(size * 2) ? size : null
}

/** setMark merges attrs per run, preserving mixed-script font choices. */
export function applyFontSize(editor: Editor, value: string): FontSizeResult {
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
