import { pointerElement } from '../AgentPointer'
import { createContext } from 'react'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type * as Y from 'yjs'
import {
  prosePositions,
  type SpecCursor,
  type SpecPeer,
  type SpecSentence,
} from './specCoordinates'

export type RewriteRef = { id: string; revision: number }
export const SpecCollaboration = createContext<{
  peers: SpecPeer[]
  active: boolean
  report: (state: { id: string; cursor: SpecCursor | null } | null) => void
  rewrite?: (sentence: SpecSentence) => Promise<void>
  release: () => void
  undo: (ref: RewriteRef) => Promise<void>
  receipts: RewriteRef[]
} | null>(null)

export const peerKey = new PluginKey<SpecPeer[]>('spec-remote-selections')
export function presenceExtension(doc: Y.Doc, id: string) {
  return Extension.create({
    name: 'specPresence',
    addProseMirrorPlugins() {
      return [
        new Plugin<SpecPeer[]>({
          key: peerKey,
          state: {
            init: () => [],
            apply: (tr, previous) => tr.getMeta(peerKey) ?? previous,
          },
          props: {
            decorations(state) {
              const decorations: Decoration[] = [],
                lanes = new Map<number, number>()
              for (const peer of peerKey.getState(state) || []) {
                if (peer.cursor.id !== id) continue
                const pos = prosePositions(doc, state, peer)
                if (!pos) continue
                if (pos.from < pos.to)
                  decorations.push(
                    Decoration.inline(pos.from, pos.to, {
                      nodeName: 'span',
                      class: 'spec-peer-range',
                      style: '--spec-peer:' + peer.color,
                      'data-spec-selection': peer.name,
                    }),
                  )
                const lane = lanes.get(pos.head) ?? 0
                lanes.set(pos.head, lane + 1)
                decorations.push(
                  Decoration.widget(
                    pos.head,
                    () => {
                      const mark = document.createElement('span')
                      mark.className = 'spec-peer-caret'
                      mark.contentEditable = 'false'
                      mark.dataset.specPeer = peer.name
                      mark.dataset.agent = String(peer.agent)
                      if (peer.agent) mark.append(pointerElement(mark.ownerDocument, peer.phase))
                      mark.dataset.below = String(lane % 2 === 1)
                      mark.style.setProperty(
                        '--spec-tier',
                        String(Math.floor(lane / 2)),
                      )
                      mark.style.setProperty('--spec-peer', peer.color)
                      mark.setAttribute('aria-label', (peer.agent ? 'AI · ' : '') + peer.name + ' 的光标')
                      return mark
                    },
                    {
                      key: peer.key + ':' + peer.name + ':' + peer.phase + ':' + lane,
                      side: -1,
                      ignoreSelection: true,
                    },
                  ),
                )
              }
              return DecorationSet.create(state.doc, decorations)
            },
          },
        }),
      ]
    },
  })
}
