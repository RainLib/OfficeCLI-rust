import type { CanvasElement } from './model'
import { specTag } from './specRichText'

export type SpecMember = {
  root: string
  bundle: string
  after: number
  anchor?: string
  before?: string
}
export const memberOf = (el: CanvasElement) =>
  (el.customData as { officeSpecMember?: SpecMember } | undefined)
    ?.officeSpecMember
export function parentSpec(el: CanvasElement) {
  const tag = specTag(el)
  return tag?.kind === 'spec' && tag.part !== 'paper'
    ? tag.root
    : memberOf(el)?.root
}

/** Indexed records have a durable paint order. Keep legacy slots stable until explicitly reordered. */
export function inPaintOrder<T extends { id: string; index?: unknown }>(
  elements: readonly T[],
): T[] {
  const used = new Set<string>()
  const indexed = elements.map((el) => {
    if (typeof el.index !== 'string' || used.has(el.index)) return false
    used.add(el.index)
    return true
  })
  const sorted = elements
    .filter((_, i) => indexed[i])
    .sort((a, b) => ((a.index as string) < (b.index as string) ? -1 : 1))
  let i = 0
  return elements.map((el, slot) => (indexed[slot] ? sorted[i++] : el))
}

/** A Spec can be selected by its border, by a deep link, or together with its native group. */
export function carriedPositions(
  before: readonly CanvasElement[],
  now: readonly CanvasElement[],
) {
  const prior = new Map(before.map((el) => [el.id, el]))
  const moved = new Map<string, { dx: number; dy: number }>()
  for (const el of now) {
    if (el.isDeleted || specTag(el)?.part !== 'paper') continue
    const old = prior.get(el.id)
    if (old && (old.x !== el.x || old.y !== el.y))
      moved.set(el.id, { dx: el.x - old.x, dy: el.y - old.y })
  }
  const result = new Map<string, { x: number; y: number }>()
  if (!moved.size) return result
  for (const el of now) {
    const old = prior.get(el.id)
    let parent = parentSpec(el)
    const visited = new Set([el.id])
    let delta: { dx: number; dy: number } | undefined
    while (parent && !visited.has(parent)) {
      visited.add(parent)
      if (moved.has(parent)) delta = moved.get(parent)
      const ancestor = prior.get(parent)
      parent = ancestor ? parentSpec(ancestor) : undefined
    }
    if (el.isDeleted || !old || !delta) continue
    const x = old.x + delta.dx,
      y = old.y + delta.dy
    if (Math.abs(el.x - x) + Math.abs(el.y - y) > 0.001)
      result.set(el.id, { x, y })
  }
  return result
}

export type NoteDirection = 'up' | 'right' | 'down' | 'left'
export const noteDirections: Record<NoteDirection, string> = {
  up: '上',
  right: '右',
  down: '下',
  left: '左',
}

export function pointOnSide(
  box: { x: number; y: number; width: number; height: number; angle?: number },
  side: NoteDirection,
  distance = 0,
) {
  const dx = side === 'left' ? -box.width / 2 - distance : side === 'right' ? box.width / 2 + distance : 0
  const dy = side === 'up' ? -box.height / 2 - distance : side === 'down' ? box.height / 2 + distance : 0
  const angle = box.angle || 0, cos = Math.cos(angle), sin = Math.sin(angle)
  return { x: box.x + box.width / 2 + dx * cos - dy * sin, y: box.y + box.height / 2 + dx * sin + dy * cos }
}
export function neighborSpot(
  source: { x: number; y: number; width: number; height: number },
  direction: NoteDirection,
  others: readonly { x: number; y: number; width: number; height: number }[],
  sameLine = false,
) {
  const width = source.width,
    height = Math.min(source.width, source.height),
    gap = 16
  const horizontal = direction === 'left' || direction === 'right'
  let x =
    direction === 'right'
      ? source.x + source.width + gap
      : direction === 'left'
        ? source.x - width - gap
        : source.x
  let y =
    direction === 'down'
      ? source.y + source.height + gap
      : direction === 'up'
        ? source.y - height - gap
        : source.y
  // Keep the requested edge adjacent even when the next slot already holds a note.
  const startX = x, startY = y
  for (let slot = 1; others.some(el => el.x < x + width && el.x + el.width > x && el.y < y + height && el.y + el.height > y); slot++) {
    if (sameLine) {
      if (horizontal) x = startX + slot * (width+gap) * (direction==='left'?-1:1)
      else y = startY + slot * (height+gap) * (direction==='up'?-1:1)
      continue
    }
    const offset = Math.ceil(slot / 2) * (slot % 2 ? 1 : -1)
    if (horizontal) y = startY + offset * (height + gap)
    else x = startX + offset * (width + gap)
  }
  return { x, y, width, height }
}
