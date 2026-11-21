import * as Y from 'yjs'
import type { EditorState } from '@tiptap/pm/state'
import type { CanvasEvent } from './model'
import { fromBase64, isTextBlock, toBase64 } from './specRichText'

export type SpecCursor = { id: string; anchor: string; head: string }
export type SpecSentence = SpecCursor & {
  block: number
  start: number
  end: number
  expected: string
}
export type SpecPeer = {
  key: string
  name: string
  color: string
  agent: boolean
  phase: 'idle' | 'writing'
  cursor: SpecCursor
}
type Point = { block: number; offset: number }
type Row = { element: Y.XmlElement; runs: Y.XmlText[] }

// Textblocks have the same depth-first order in the Spec projection, Yrs
// storage and ProseMirror. Browser positions are UTF-16; API ranges are scalars.
function rows(doc: Y.Doc) {
  const result: Row[] = []
  function visit(n: Y.XmlElement | Y.XmlText | Y.XmlHook) {
    if (!(n instanceof Y.XmlElement)) return
    if (isTextBlock(n.nodeName))
      result.push({
        element: n,
        runs: n.toArray().filter((r): r is Y.XmlText => r instanceof Y.XmlText),
      })
    else n.toArray().forEach(visit)
  }
  doc.getXmlFragment('spec').toArray().forEach(visit)
  return result
}
function pmRows(state: EditorState) {
  const starts: { from: number; to: number }[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    starts.push({ from: pos + 1, to: pos + 1 + node.content.size })
    return false
  })
  return starts
}
function encode(row: Row, utf16: number, assoc: number) {
  let offset = utf16
  for (const run of row.runs) {
    if (offset <= run.length)
      return toBase64(
        Y.encodeRelativePosition(
          Y.createRelativePositionFromTypeIndex(run, offset, assoc),
        ),
      )
    offset -= run.length
  }
  if (utf16 === 0)
    return toBase64(
      Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(row.element, 0, assoc),
      ),
    )
}
export function titleCursor(
  doc: Y.Doc,
  id: string,
  a: number,
  h: number,
): SpecCursor | null {
  const row = rows(doc)[0]
  if (!row) return null
  const anchor = encode(row, a, a > h ? -1 : 0),
    head = encode(row, h, h > a ? -1 : 0)
  return anchor && head ? { id, anchor, head } : null
}
export function selectionCursor(
  doc: Y.Doc,
  id: string,
  state: EditorState,
): SpecCursor | null {
  const xml = rows(doc),
    pm = pmRows(state)
  const point = (pos: number, assoc: number) => {
    const i = pm.findIndex((r) => r.from <= pos && pos <= r.to)
    if (i >= 0 && xml[i]) return encode(xml[i], pos - pm[i].from, assoc)
  }
  const { anchor: a, head: h } = state.selection
  const anchor = point(a, a > h ? -1 : 0),
    head = point(h, h > a ? -1 : 0)
  return anchor && head ? { id, anchor, head } : null
}
function decode(doc: Y.Doc, xml: Row[], wire: string): Point | null {
  try {
    const pos = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(fromBase64(wire)),
      doc,
    )
    if (!pos) return null
    for (const [block, row] of xml.entries()) {
      if (pos.type === row.element)
        return {
          block,
          offset: row.runs
            .slice(0, pos.index)
            .reduce((n, r) => n + r.length, 0),
        }
      let offset = 0
      for (const run of row.runs) {
        if (pos.type === run) return { block, offset: offset + pos.index }
        offset += run.length
      }
    }
  } catch {
    /* Unavailable / invalid awareness data never affects the document. */
  }
  return null
}
export function resolveCursor(doc: Y.Doc, cursor: SpecCursor) {
  const xml = rows(doc),
    anchor = decode(doc, xml, cursor.anchor),
    head = decode(doc, xml, cursor.head)
  if (anchor && head) return { anchor, head }
}
export function sentenceAt(
  doc: Y.Doc,
  cursor: SpecCursor,
): SpecSentence | null {
  const xml = rows(doc),
    a = decode(doc, xml, cursor.anchor),
    h = decode(doc, xml, cursor.head)
  if (!a || !h || a.block !== h.block || a.offset === h.offset) return null
  const text = xml[a.block].runs
    .map((r) =>
      r
        .toDelta()
        .map((d: { insert: string }) => d.insert)
        .join(''),
    )
    .join('')
  const from = Math.min(a.offset, h.offset),
    to = Math.max(a.offset, h.offset)
  const start = Array.from(text.slice(0, from)).length,
    expected = text.slice(from, to),
    length = Array.from(expected).length
  return length && length <= 8000
    ? { ...cursor, block: a.block, start, end: start + length, expected }
    : null
}
const colors = [
  '#28618b',
  '#a34a36',
  '#377457',
  '#96527b',
  '#5862a1',
  '#8a631e',
]
export function specPeers(events: Map<string, CanvasEvent>): SpecPeer[] {
  return Array.from(events).flatMap(([key, e]) => {
    if (!e.specCursor) return []
    const actor = e.actorId || key,
      agent = e.actorKind === 'agent'
    let n = 0
    for (const c of actor) n = (31 * n + c.charCodeAt(0)) >>> 0
    return [
      {
        key,
        name: e.name || (agent ? '墨点' : '协作者'),
        color: agent ? '#73558a' : colors[n % colors.length],
        agent,
        phase: e.agentPhase ?? 'idle',
        cursor: e.specCursor,
      },
    ]
  })
}
export function prosePositions(doc: Y.Doc, state: EditorState, peer: SpecPeer) {
  const pos = resolveCursor(doc, peer.cursor)
  if (!pos) return
  const pm = pmRows(state)
  const absolute = (p: Point) =>
    pm[p.block] && Math.min(pm[p.block].to, pm[p.block].from + p.offset)
  const a = absolute(pos.anchor),
    h = absolute(pos.head)
  if (a !== undefined && h !== undefined)
    return { from: Math.min(a, h), to: Math.max(a, h), head: h }
}
