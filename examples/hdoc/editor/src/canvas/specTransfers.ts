import {
  CaptureUpdateAction,
  newElementWith,
  restoreElements,
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import * as Y from 'yjs'
import { boardTag, type BoardPoint } from './boardObjects'
import {
  openSpec,
  specBlocks,
  specTag,
  toBase64,
  fromBase64,
} from './specRichText'
import { memberOf, parentSpec, type SpecMember } from './sceneGeometry'
import type { CanvasElement, Operation } from './model'

type Native = ExcalidrawElement
export const rawElement = (e: Native) => e as unknown as CanvasElement
function localPoint(el: Native, point: BoardPoint) {
  const dx = point.x - el.x - el.width / 2, dy = point.y - el.y - el.height / 2
  const c = Math.cos(el.angle), s = Math.sin(el.angle)
  return { x: dx * c + dy * s + el.width / 2, y: dy * c - dx * s + el.height / 2 }
}

/** A canvas attachment in front of the writing column keeps its native drag
 * gesture, including when an editable paragraph spans its screen position. */
export function hitsSpecAttachment(scene: readonly Native[], root: string, textId: string, point: BoardPoint, zoom: number) {
  const text = scene.findIndex(el => el.id === textId)
  if (text < 0) return false
  for (let i = scene.length - 1; i > text; i--) {
    const el = scene[i]
    if (el.isDeleted || memberOf(rawElement(el))?.root !== root) continue
    const { x, y } = localPoint(el, point)
    if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') {
      const margin = el.strokeWidth / 2 + 3 / zoom
      if (el.points.some(([ax, ay], j) => {
        const [bx, by] = el.points[j + 1] ?? [ax, ay]
        const dx = bx - ax, dy = by - ay
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
        return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= margin
      })) return true
      continue
    }
    if (x < 0 || x > el.width || y < 0 || y > el.height) continue
    const u = (2 * x / el.width) - 1, v = (2 * y / el.height) - 1
    if (el.type === 'ellipse' && u * u + v * v > 1 || el.type === 'diamond' && Math.abs(u) + Math.abs(v) > 1) continue
    return true
  }
  return false
}
export function specAt(
  scene: readonly Native[],
  point: BoardPoint,
  exclude: ReadonlySet<string>,
) {
  const byId = new Map(scene.map((el) => [el.id, el]))
  return [...scene].reverse().find((el) => {
    if (
      boardTag(el)?.part !== 'paper' ||
      boardTag(el)?.kind !== 'spec' ||
      el.locked ||
      el.isDeleted
    )
      return false
    const ancestors = new Set<string>()
    let current: Native | undefined = el
    while (current) {
      if (exclude.has(current.id) || ancestors.has(current.id)) return false
      ancestors.add(current.id)
      current = byId.get(parentSpec(rawElement(current)) || '')
    }
    const { x, y } = localPoint(el, point)
    return x >= 0 && x <= el.width && y >= 0 && y <= el.height
  })
}
export function nativeBundle(scene: readonly Native[], seed: Native) {
  const ids = new Set([seed.id]),
    groups = new Set<string>(),
    roots = new Set<string>()
  // Bound text, table cells, native groups and frames travel together. Arrows bound to two
  // independent shapes remain connectors unless explicitly selected.
  let count = -1
  while (count !== ids.size) {
    count = ids.size
    for (const el of scene)
      if (ids.has(el.id)) {
        el.groupIds.forEach((id) => groups.add(id))
        const tag = boardTag(el)
        if (tag) roots.add(tag.root)
        if (el.customData?.officeStickerPart?.anchor)
          ids.add(String(el.customData.officeStickerPart.anchor))
        if (el.type === 'text' && el.containerId) ids.add(el.containerId)
      }
    for (const el of scene)
      if (
        !el.isDeleted &&
        (el.groupIds.some((g) => groups.has(g)) ||
          ids.has(String(el.customData?.officeStickerPart?.anchor || '')) ||
          roots.has(boardTag(el)?.root || '') ||
          (el.type === 'text' && !!el.containerId && ids.has(el.containerId)) ||
          (!!el.frameId && ids.has(el.frameId)))
      )
        ids.add(el.id)
  }
  return scene.filter((el) => ids.has(el.id) && !el.isDeleted)
}
export function bodyOf(scene: readonly CanvasElement[], root: string) {
  return scene.find(
    (el) =>
      !el.isDeleted &&
      specTag(el)?.root === root &&
      specTag(el)?.part === 'body',
  )
}
function insertIndex(
  root: string,
  y: number,
  body: CanvasElement | undefined,
  api: ExcalidrawImperativeAPI,
) {
  const app = api.getAppState(),
    vy = (y + app.scrollY) * app.zoom.value + app.offsetTop
  const host = document
    .elementFromPoint(
      app.offsetLeft + app.width / 2,
      app.offsetTop + app.height / 2,
    )
    ?.closest('.canvas-surface')
  const key = CSS.escape(root)
  const article = host?.querySelector(`article[data-spec-root="${key}"], .board-spec-inline[data-spec-id="${key}"] .ProseMirror`)
  const blocks = article ? Array.from(article.children) : []
  if (blocks.length) {
    const i = blocks.findIndex((el) => {
      const box = el.getBoundingClientRect()
      return vy < box.y + box.height / 2
    })
    return i < 0 ? blocks.length : i
  }
  return body ? Math.max(0, Math.floor((y - body.y) / 25)) : 0
}
function anchorAt(doc: Y.Doc, index: number) {
  const frag = doc.getXmlFragment('spec'),
    i = Math.min(index, frag.length)
  return toBase64(
    Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(frag, i, -1),
    ),
  )
}
export function memberSlot(doc: Y.Doc, member: SpecMember) {
  if (member.anchor)
    try {
      const pos = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(fromBase64(member.anchor)),
        doc,
      )
      if (pos?.type === doc.getXmlFragment('spec')) return pos.index
    } catch {
      /* Older scenes only have the paragraph slot. */
    }
  return Math.min(member.after, doc.getXmlFragment('spec').length)
}
export function appendBoardText(doc: Y.Doc, index: number, el: Native) {
  if (el.type !== 'text') return
  const excerpt = el.customData?.officeSpecExcerpt
  let nodes: Y.XmlElement[] = []
  if (excerpt?.update && excerpt.text === el.originalText) {
    const copy = new Y.Doc()
    try {
      Y.applyUpdate(copy, fromBase64(excerpt.update))
      nodes = copy
        .getXmlFragment('spec')
        .toArray()
        .flatMap((b) => (b instanceof Y.XmlElement ? [b.clone()] : []))
    } finally {
      copy.destroy()
    }
  }
  if (!nodes.length)
    nodes = el.originalText.split('\n').map((line) => {
      const p = new Y.XmlElement('paragraph')
      if (line) {
        const run = new Y.XmlText()
        run.insert(0, line)
        p.push([run])
      }
      return p
    })
  const frag = doc.getXmlFragment('spec')
  frag.insert(Math.min(index, frag.length), nodes)
}
export function transferBoardDrop(
  api: ExcalidrawImperativeAPI,
  ids: string[],
  point: BoardPoint,
  origin: BoardPoint | undefined,
  send: (ops: Operation[]) => void,
  canonical: readonly CanvasElement[],
) {
  const scene = api.getSceneElementsIncludingDeleted(),
    active = scene.filter((el) => !el.isDeleted)
  const first = active.filter((el) => ids.includes(el.id) && !el.locked)
  if (!first.length) return
  const seen = new Set<string>(),
    bundles: Native[][] = []
  for (const seed of first) {
    if (seen.has(seed.id)) continue
    const members = nativeBundle(active, seed)
    members.forEach((el) => seen.add(el.id))
    bundles.push(members)
  }
  const target = specAt(active, point, seen),
    start = origin && specAt(active, origin, seen)
  const latest = active.map(rawElement)
  const body = target && bodyOf(latest, target.id)
  if (target && (!body || body.locked)) return
  const doc = body ? openSpec(body) : null,
    vector = doc ? Y.encodeStateVector(doc) : null
  let slot = target ? insertIndex(target.id, point.y, body, api) : 0
  const baseOrder: Native[] = [...scene],
    updates = new Map<string, Native>()
  const ops: Operation[] = []
  for (const bundle of bundles) {
    const lead =
        bundle.find((el) => ids.includes(el.id) && el.type !== 'text') ??
        bundle[0],
      previous = memberOf(rawElement(lead))
    if (
      previous?.root === target?.id ||
      (!previous && start?.id === target?.id)
    )
      continue
    if (bundle.some((el) => el.locked && boardTag(el)?.kind !== 'comment'))
      continue
    const oldParent = previous && active.find((el) => el.id === previous.root)
    if (oldParent?.locked) continue
    if (
      target &&
      doc &&
      body &&
      bundle.length === 1 &&
      lead.type === 'text' &&
      !boardTag(lead) &&
      !lead.containerId
    ) {
      appendBoardText(doc, slot++, lead)
      ops.push({
        op: 'element.update',
        id: lead.id,
        before: {
          isDeleted:
            canonical.find((el) => el.id === lead.id)?.isDeleted ?? null,
        },
        changes: { isDeleted: true },
      })
      continue
    }
    const idsOf = new Set(bundle.map((el) => el.id))
    const before = baseOrder.findIndex((el) => idsOf.has(el.id))
    const targetEnd = target
      ? baseOrder.reduce(
          (last, el, i) =>
            el.id === target.id || boardTag(el)?.root === target.id ? i : last,
          -1,
        )
      : -1
    const lift = target && before >= 0 && before < targetEnd
    const home =
      previous?.before ??
      (lift
        ? baseOrder.slice(before + 1).find((el) => !idsOf.has(el.id))?.id
        : undefined)
    const member: SpecMember | undefined = target
      ? {
          root: target.id,
          bundle: previous?.bundle || lead.id,
          after: slot,
          anchor: doc ? anchorAt(doc, slot) : undefined,
          before: home,
        }
      : undefined
    for (const el of bundle) {
      const data: Record<string, unknown> = { ...el.customData }
      if (member) data.officeSpecMember = member
      else delete data.officeSpecMember
      updates.set(el.id, newElementWith(el, { customData: data }))
    }
    if (lift || (!target && home)) {
      const rest = baseOrder.filter((el) => !idsOf.has(el.id))
      const slot = target
        ? rest.reduce(
            (n, el, i) =>
              el.id === target.id || boardTag(el)?.root === target.id
                ? i + 1
                : n,
            0,
          )
        : rest.findIndex((el) => el.id === home)
      if (slot >= 0) {
        rest.splice(slot, 0, ...bundle)
        baseOrder.splice(0, baseOrder.length, ...rest)
      }
    }
  }
  if (updates.size) {
    const ordered = baseOrder.map((el) => updates.get(el.id) ?? el)
    const reordered = ordered.some((el, i) => el.id !== scene[i].id)
    api.updateScene({
      elements: reordered ? restoreElements(ordered, null) : ordered,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
  }
  if (doc && vector && body && ops.length) {
    ops.push({
      op: 'spec.update',
      id: body.id,
      update: toBase64(Y.encodeStateAsUpdate(doc, vector)),
    })
    send(ops)
  }
  doc?.destroy()
}
export function detachBundle(
  api: ExcalidrawImperativeAPI,
  root: string,
  bundle: string,
  at: BoardPoint,
) {
  const all = api.getSceneElementsIncludingDeleted(),
    paper = all.find((el) => el.id === root && !el.isDeleted)
  const members = all.filter((el) => {
    const m = memberOf(rawElement(el))
    return !el.isDeleted && m?.root === root && m.bundle === bundle
  })
  if (
    !paper ||
    paper.locked ||
    !members.length ||
    members.some((el) => el.locked && boardTag(el)?.kind !== 'comment')
  )
    return
  const left = Math.min(...members.map((el) => el.x)),
    top = Math.min(...members.map((el) => el.y))
  const member = memberOf(rawElement(members[0]))!,
    ids = new Set(members.map((el) => el.id))
  let ordered = [...all]
  if (
    member.before &&
    ordered.some((el) => el.id === member.before && !ids.has(el.id))
  ) {
    ordered = ordered.filter((el) => !ids.has(el.id))
    ordered.splice(
      ordered.findIndex((el) => el.id === member.before),
      0,
      ...members,
    )
  }
  const result = ordered.map((el) => {
    if (!ids.has(el.id)) return el
    const data: Record<string, unknown> = { ...el.customData }
    delete data.officeSpecMember
    return newElementWith(el, {
      x: el.x + at.x - left,
      y: el.y + at.y - top,
      customData: data,
    })
  })
  api.updateScene({
    elements: member.before ? restoreElements(result, null) : result,
    appState: { selectedElementIds: { [bundle]: true } },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
}
