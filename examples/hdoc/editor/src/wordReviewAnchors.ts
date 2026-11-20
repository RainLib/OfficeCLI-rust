import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Mapping, StepMap } from '@tiptap/pm/transform'
import type { Transaction } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { documentTransferRange, type TextSpan } from './selectionTransfer'

export type WordReviewAnchor = { id: string; location: Pick<TextSpan, 'blockId' | 'start' | 'end'> }
type Located = WordReviewAnchor & { from?: number; to?: number }
type State = { anchors: Located[]; active: string | null; decorations: DecorationSet }
type Update = { anchors?: WordReviewAnchor[]; active?: string | null }
export const wordReviewAnchors = new PluginKey<State>('wordReviewAnchors')

function locate(doc: Node, anchor: WordReviewAnchor): Located {
  try {
    return { ...anchor, ...documentTransferRange(doc, { kind: 'text', spans: [{ ...anchor.location, textHash: '' }] }) }
  } catch { return { id: anchor.id, location: anchor.location } }
}

function decorations(doc: Node, anchors: Located[], active: string | null) {
  return DecorationSet.create(doc, anchors.flatMap(anchor =>
    anchor.from !== undefined && anchor.to !== undefined && anchor.from < anchor.to
    && anchor.from >= 0 && anchor.to <= doc.content.size
      ? [Decoration.inline(anchor.from, anchor.to, {
        class: 'word-comment-mark' + (anchor.id === active ? ' is-active' : ''),
        'data-word-comment-id': anchor.id,
      })] : []))
}

/** Yjs undo and peer updates can replace the entire PM document. Follow stable
 * paragraph IDs and the change inside each paragraph, rather than mapping a
 * comment through that outer replacement (which collapses it to a boundary). */
function collaborativeAnchors(transaction: Transaction, anchors: Located[]): Located[] {
  const ids = new Set(anchors.map(anchor => anchor.location.blockId))
  const collect = (doc: Node) => {
    const blocks = new Map<string, { node: Node; start: number }>()
    doc.descendants((node, pos) => {
      if (!ids.has(node.attrs.hcdBlockId)) return
      blocks.set(node.attrs.hcdBlockId, { node, start: pos + 1 })
      return false
    })
    return blocks
  }
  const before = collect(transaction.before), after = collect(transaction.doc)
  const mappings = new Map<string, Mapping>()
  return anchors.map(anchor => {
    const id = anchor.location.blockId, a = before.get(id), b = after.get(id)
    if (!a || !b || anchor.from === undefined || anchor.to === undefined || anchor.from < a.start
      || anchor.to > a.start + a.node.content.size) return locate(transaction.doc, anchor)
    let mapping = mappings.get(id)
    if (!mapping) {
      mapping = new Mapping()
      if (a.node.textContent !== b.node.textContent || a.node.content.size !== b.node.content.size) {
        const start = a.node.content.findDiffStart(b.node.content)
        const end = a.node.content.findDiffEnd(b.node.content)
        if (start !== null && end) {
          const overlap = Math.max(0, start - Math.min(end.a, end.b))
          mapping.appendMap(new StepMap([start, end.a + overlap - start, end.b + overlap - start]))
        }
      }
      mappings.set(id, mapping)
    }
    return { ...anchor, from: b.start + mapping.map(anchor.from - a.start, 1),
      to: b.start + mapping.map(anchor.to - a.start, -1) }
  })
}

/** Decorations never enter the document or its CRDT/source-format exports. */
export function createWordReviewAnchors() {
  return new Plugin<State>({
    key: wordReviewAnchors,
    state: {
      init: () => ({ anchors: [], active: null, decorations: DecorationSet.empty }),
      apply(transaction, previous) {
        const update = transaction.getMeta(wordReviewAnchors) as Update | undefined
        if (!transaction.docChanged && !update) return previous
        const anchors = update?.anchors ? update.anchors.map(anchor => locate(transaction.doc, anchor))
          : !transaction.docChanged ? previous.anchors
          : transaction.getMeta(ySyncPluginKey)?.isChangeOrigin ? collaborativeAnchors(transaction, previous.anchors)
          : previous.anchors.map(anchor => {
            if (anchor.from === undefined || anchor.to === undefined) return locate(transaction.doc, anchor)
            return { ...anchor, from: transaction.mapping.map(anchor.from, 1), to: transaction.mapping.map(anchor.to, -1) }
          })
        const active = update?.active !== undefined ? update.active : previous.active
        return { anchors, active, decorations: decorations(transaction.doc, anchors, active) }
      },
    },
    props: {
      decorations: state => wordReviewAnchors.getState(state)?.decorations,
    },
  })
}

export function arrangeWordComments(items: { id: string; top: number; height: number }[], start = 104) {
  let bottom = start - 12
  return [...items].sort((a, b) => a.top - b.top).map(item => {
    const top = Math.max(start, item.top, bottom + 12)
    bottom = top + item.height
    return { ...item, top }
  })
}
