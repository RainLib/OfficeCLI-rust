import type { Snapshot } from './model'
import { openSpec, specTag } from './specRichText'
import { sentenceAt, type SpecCursor } from './specCoordinates'
import type { RewriteRef } from './specCollaboration'
import { isIndex, readTabState, tabStateKey, writeTabState } from '../tabState'
import type { Session } from '../api'

export function savedSentence(
  snapshot: Snapshot | null | undefined,
  cursor: SpecCursor | null | undefined,
) {
  if (!snapshot || !cursor) return null
  const el = snapshot.scene.elements.find((e) => e.id === cursor.id)
  if (
    !el ||
    el.isDeleted ||
    el.locked ||
    !['body', 'title'].includes(specTag(el)?.part || '')
  )
    return null
  const doc = openSpec(el)
  try {
    return sentenceAt(doc, cursor)
  } finally {
    doc.destroy()
  }
}

export function rewriteLog(
  session: Session,
  epoch: number,
  change?: { add?: RewriteRef; remove?: number },
) {
  const key = tabStateKey(session, 'spec-rewrites:' + epoch)
  const cached = readTabState<RewriteRef[]>(key)
  const items = (Array.isArray(cached) ? cached : []).filter(
    (r) => typeof r?.id === 'string' && isIndex(r.revision),
  )
  if (!change) return items
  const next = items.filter(
    (r) => r.revision !== change.remove && r.revision !== change.add?.revision,
  )
  if (change.add) next.push(change.add)
  writeTabState(key, next.slice(-40))
  return next.slice(-40)
}
