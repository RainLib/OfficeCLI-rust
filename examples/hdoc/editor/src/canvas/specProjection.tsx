import { AgentPointer } from '../AgentPointer'
import { createElement, type CSSProperties, type ReactNode } from 'react'
import type * as Y from 'yjs'
import { resolveCursor, type SpecPeer } from './specCoordinates'
const marks: Record<string, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
}
type Position = { block: number; offset: number }
const order = (a: Position, b: Position) =>
  a.block - b.block || a.offset - b.offset
type Marker = { peer: SpecPeer; from: Position; to: Position; head: Position }
export function projectRuns(
  runs: { insert: string; attributes?: Record<string, unknown> }[],
  block: number,
  markers: Marker[],
) {
  const out: ReactNode[] = []
  let offset = 0
  const heads = (pos: number) =>
    markers
      .filter((m) => m.head.block === block && m.head.offset === pos)
      .forEach(({ peer }, i) => {
        out.push(
          <span
            key={'head:' + peer.key}
            className="spec-peer-caret"
            data-spec-peer={peer.name}
            data-agent={peer.agent}
            data-below={i % 2 === 1}
            aria-label={(peer.agent ? 'AI · ' : '') + peer.name + ' 的光标'}
            style={
              {
                '--spec-peer': peer.color,
                '--spec-tier': Math.floor(i / 2),
              } as CSSProperties
            }
          >{peer.agent && <AgentPointer phase={peer.phase} />}</span>,
        )
      })
  for (const run of runs) {
    const end = offset + run.insert.length
    const edges = new Set([offset, end])
    for (const m of markers)
      for (const p of [m.from, m.to, m.head])
        if (p.block === block && p.offset > offset && p.offset < end)
          edges.add(p.offset)
    const cuts = [...edges].sort((a, b) => a - b)
    for (let i = 0; i < cuts.length - 1; i++) {
      const pos = { block, offset: cuts[i] }
      heads(pos.offset)
      let text: ReactNode = run.insert.slice(
        pos.offset - offset,
        cuts[i + 1] - offset,
      )
      for (const key of Object.keys(run.attributes || {}))
        if (marks[key]) text = createElement(marks[key], null, text)
      for (const m of markers)
        if (order(m.from, pos) <= 0 && order(pos, m.to) < 0)
          text = (
            <span
              className="spec-peer-range"
              data-spec-selection={m.peer.name}
              style={{ '--spec-peer': m.peer.color } as CSSProperties}
            >
              {text}
            </span>
          )
      out.push(<span key={pos.offset}>{text}</span>)
    }
    offset = end
  }
  heads(offset)
  return out
}
export function markersFor(
  doc: Y.Doc,
  id: string,
  peers: SpecPeer[],
): Marker[] {
  return peers.flatMap((peer) => {
    if (peer.cursor.id !== id) return []
    const p = resolveCursor(doc, peer.cursor)
    if (!p) return []
    const [from, to] =
      order(p.anchor, p.head) <= 0 ? [p.anchor, p.head] : [p.head, p.anchor]
    return [{ peer, head: p.head, from, to }]
  })
}
