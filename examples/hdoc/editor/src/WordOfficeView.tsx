import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { useEffect, useState } from 'react'
import type { Session } from './api'
import { useOfficeSnapshot, type WordOffice } from './OfficeFeatures'

const key = new PluginKey<{ office: WordOffice | null; decorations: DecorationSet }>('wordOffice')
function decorations(doc: PMNode, office: WordOffice | null) {
  if (!office) return DecorationSet.empty
  const list: Decoration[] = []
  const hidden = new Set(office.tocBlockIds)
  doc.descendants((node, pos) => {
    if (!node.attrs.hcdBlockId) return
    if (hidden.has(node.attrs.hcdBlockId)) list.push(Decoration.node(pos, pos + node.nodeSize, { class: 'word-native-toc-cache' }))
    if (!node.isTextblock) return
    for (const note of office.footnotes) {
      const anchor = note.anchor
      if (!anchor || note.anchorChanged || anchor.blockId !== node.attrs.hcdBlockId) continue
      // Context follows peer insertions; never guess when the anchor is ambiguous.
      const needle = anchor.before + anchor.after, text = node.textContent
      let offset = Array.from(text).slice(0, anchor.offset).join('').length
      const unique = (value: string) => { if (!value) return -1; const at = text.indexOf(value); return at < 0 || text.indexOf(value, at + 1) >= 0 ? -1 : at }
      if (anchor.offset === 0) offset = 0
      else if (!anchor.after) offset = text.length
      else {
        const exact = unique(needle)
        if (exact >= 0) offset = exact + anchor.before.length
        else {
          const before = unique(anchor.before), after = unique(anchor.after)
          if (before >= 0 && (after < 0 || before + anchor.before.length <= after)) offset = before + anchor.before.length
          else if (before < 0 && after >= 0) offset = after
          else continue
        }
      }
      if (offset > node.content.size) continue
      list.push(Decoration.widget(pos + 1 + offset, () => {
        const marker = document.createElement('sup')
        marker.className = 'word-footnote-reference'; marker.textContent = String(note.number)
        marker.title = note.text; marker.setAttribute('aria-label', `脚注 ${note.number}：${note.text}`)
        marker.addEventListener('click', () => document.getElementById(`word-note-${note.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
        return marker
      }, { key: `footnote-${note.id}`, side: -1 }))
    }
  })
  return DecorationSet.create(doc, list)
}
export const wordOfficeExtension = Extension.create({ name: 'wordOffice', addProseMirrorPlugins: () => [new Plugin<{ office: WordOffice | null; decorations: DecorationSet }>({
  key, state: { init: () => ({ office: null, decorations: DecorationSet.empty }), apply(tr, previous) {
    const office = tr.getMeta(key) as WordOffice | null | undefined
    if (office !== undefined || tr.docChanged) { const next = office === undefined ? previous.office : office; return { office: next, decorations: decorations(tr.doc, next) } }
    return previous
  } }, props: { decorations: state => key.getState(state)?.decorations ?? DecorationSet.empty },
})] })
export function WordOfficeView({ editor, session, revision, placement }: { editor: Editor; session: Session; revision: number | null; placement: 'before' | 'after' }) {
  const snapshot = useOfficeSnapshot(session, revision), word = snapshot?.word
  const [, update] = useState(0)
  useEffect(() => { const changed = () => update(n => n + 1); editor.on('update', changed); return () => { editor.off('update', changed) } }, [editor])
  useEffect(() => {
    if (placement !== 'before' || editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta(key, word ?? null).setMeta('addToHistory', false))
    const paper = editor.view.dom.closest<HTMLElement>('.document'), layout = word?.sections[0]?.layout
    if (!paper || !layout) return
    paper.dataset.officePage = 'true'
    for (const [name, value] of Object.entries({ width: layout.widthTwips, top: layout.topTwips, right: layout.rightTwips, bottom: layout.bottomTwips, left: layout.leftTwips + layout.gutterTwips, height: layout.heightTwips })) paper.style.setProperty(`--office-page-${name}`, `${value / 15}px`)
    return () => { delete paper.dataset.officePage; ['width', 'top', 'right', 'bottom', 'left', 'height'].forEach(name => paper.style.removeProperty(`--office-page-${name}`)) }
  }, [editor, word, placement])
  if (!word) return null
  if (placement === 'after') return word.footnotes.length > 0 ? <section className="word-footnotes" aria-label="文档脚注"><h3>脚注</h3>{word.footnotes.map(note => <p id={`word-note-${note.id}`} key={note.id}><sup>{note.number}</sup><span>{note.text}</span>{note.anchorChanged && <small>正文锚点已变化，请核对</small>}</p>)}</section> : null
  if (!word.toc) return null
  const headings: { blockId: string; level: number; text: string; pos: number }[] = []
  editor.state.doc.descendants((node, pos) => { if (node.attrs.hcdBlockId && !word.tocBlockIds.includes(node.attrs.hcdBlockId) && node.textContent.trim()) { const level = node.type.name === 'heading' ? node.attrs.level : word.headings.find(h => h.blockId === node.attrs.hcdBlockId)?.level; if (level) headings.push({ blockId: node.attrs.hcdBlockId, level, text: node.textContent, pos }) } })
  const entries = headings.filter(h => h.level >= word.toc!.firstLevel && h.level <= word.toc!.lastLevel)
  return <nav className="word-linked-toc" aria-label="文档目录">{word.toc.title && <h2>{word.toc.title}</h2>}{entries.map(h => <button type="button" key={h.blockId} style={{ paddingLeft: (h.level - word.toc!.firstLevel) * 18 }} onClick={() => { editor.commands.setTextSelection(h.pos + 1); editor.view.dom.querySelector(`[data-hcd-block-id="${CSS.escape(h.blockId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}>{h.text}</button>)}{!entries.length && <p>为正文设置标题后，这里会显示目录。</p>}</nav>
}
