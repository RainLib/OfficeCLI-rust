import { isSpecText, mergeSpecUpdates, optimisticSpec, specTag } from './specRichText.ts'
import type { CanvasElement, CanvasScene, Operation, Selection } from './model.ts'

const transient = new Set(['version', 'versionNonce', 'updated'])
export const same = (left: unknown, right: unknown) => Object.is(left, right) || JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

/** Excalidraw mutates native elements in place during a drag. Keep value
 * snapshots for diffing, reusing only records whose native version is stable. */
export function snapshotElements(elements: readonly CanvasElement[], previous: readonly CanvasElement[] = []): CanvasElement[] {
  const before = new Map(previous.map(element => [element.id, element]))
  return elements.map(element => {
    const stored = before.get(element.id)
    return stored && typeof element.version === 'number' && typeof element.versionNonce === 'number' && stored.version === element.version && stored.versionNonce === element.versionNonce ? stored : structuredClone(element)
  })
}

/** Compare normalized UI records, but take preconditions from canonical server
 * values. Renderer defaults must never become accidental human mutations. */
export function changesFromUI(canonical: CanvasScene, previous: readonly CanvasElement[], next: readonly CanvasElement[]): Operation[] {
  const raw = new Map(canonical.elements.map(element => [element.id, element]))
  const beforeUI = new Map(previous.map(element => [element.id, element]))
  const operations: Operation[] = []
  const nextIds = new Set(next.map(el => el.id))
  const common = previous.filter(el => nextIds.has(el.id)).map(el => el.id)
  let index = 0
  const reordered = next.some(el => beforeUI.has(el.id) && el.id !== common[index++])
  for (const element of next) {
    const before = beforeUI.get(element.id), stored = raw.get(element.id)
    if (!stored) { if (!element.isDeleted) operations.push({ op: 'element.add', element }); continue }
    if (!before) continue
    if (before === element && !reordered) continue
    const specText = isSpecText(stored)
    const fields: Record<string, unknown> = {}, changes: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(before), ...Object.keys(element)])) {
      if (key === 'index') {
        if (reordered && typeof element.index === 'string' && element.index !== stored.index) {
          fields.index = stored.index ?? null; changes.index = element.index
        }
        continue
      }
      if (key === 'id' || key === 'type' || transient.has(key) || same(before[key], element[key])) continue
      // Excalidraw rewraps and measures these fields on selection/zoom. The
      // authoritative values belong to the Yjs projection in canvas-core.
      if (specText && ['text', 'originalText', 'height'].includes(key)) continue
      if (specText && key === 'customData') {
        const { officeSpec: _old, ...oldData } = (before.customData ?? {}) as Record<string, unknown>
        const { officeSpec: _new, ...newData } = (element.customData ?? {}) as Record<string, unknown>
        if (same(oldData, newData)) continue
        const spec = (stored.customData as Record<string, unknown>).officeSpec
        fields.customData = stored.customData
        changes.customData = spec ? { ...newData, officeSpec: spec } : newData
        continue
      }
      fields[key] = stored[key] ?? null; changes[key] = element[key] ?? null
    }
    if (Object.keys(changes).length) operations.push({ op: 'element.update', id: element.id, before: fields, changes })
  }
  return operations
}

/** Repair an old renderer's queued height measurements only for Spec text.
 * A paper resize, a move, and every other field keep their original guards. */
export function withoutSpecMeasurements(ops: Operation[], scene: CanvasScene): Operation[] | null {
  const textIds = new Set(scene.elements.filter(el => !el.isDeleted && isSpecText(el)).map(el => el.id))
  const result: Operation[] = []
  let repaired = false
  for (const op of ops) {
    if (op.op === 'element.add' && isSpecText(op.element)) textIds.add(op.element.id)
    if (op.op !== 'element.update' || !textIds.has(op.id) || !('height' in op.changes) || !('height' in op.before)) {
      result.push(op)
      continue
    }
    const { height: _before, ...before } = op.before
    const { height: _height, ...changes } = op.changes
    if (Object.keys(changes).length) result.push({ ...op, before, changes })
    repaired = true
  }
  return repaired ? result : null
}

export function applyOperations(scene: CanvasScene, operations: Operation[]): CanvasScene {
  if (!operations.length) return scene
  let elements = scene.elements.map(element => ({ ...element }))
  const files = { ...scene.files }, appState = { ...scene.appState }
  for (const operation of operations) {
    if (operation.op === 'element.add') {
      const existing = elements.findIndex(element => element.id === operation.element.id)
      if (existing < 0) elements.push(operation.element)
      else elements[existing] = operation.element
    }
    if (operation.op === 'spec.update') elements = elements.map(e => e.id===operation.id?optimisticSpec(e,operation.update):e)
    if (operation.op === 'element.remove') elements = elements.filter(element => element.id !== operation.id)
    if (operation.op === 'element.update') elements = elements.map(element => element.id === operation.id ? { ...element, ...operation.changes } : element)
    if (operation.op === 'file.add') files[operation.id] = operation.file
    if (operation.op === 'scene.update') Object.assign(appState, operation.changes)
  }
  return { ...scene, elements, files, appState }
}

/** Collapse pointer frames into one transaction while retaining the first
 * observed prior value. Further changes to an uncommitted new object edit its add. */
export function combineOperations(pending: Operation[], incoming: Operation[]): Operation[] {
  const output = structuredClone(pending)
  for (const operation of incoming) {
    if(operation.op==='spec.update'){
      const previous=output.find(candidate=>candidate.op==='spec.update' && candidate.id===operation.id)
      if(previous?.op==='spec.update'){previous.update=mergeSpecUpdates(previous.update,operation.update);continue}
    }
    if (operation.op === 'element.update') {
      const previous = output.find(candidate => candidate.op === 'element.add' ? candidate.element.id === operation.id : candidate.op === 'element.update' && candidate.id === operation.id)
      if (previous?.op === 'element.add') { Object.assign(previous.element, operation.changes); continue }
      if (previous?.op === 'element.update') {
        for (const key of Object.keys(operation.changes)) {
          if (!(key in previous.before)) previous.before[key] = operation.before[key]
          previous.changes[key] = operation.changes[key]
        }
        continue
      }
    }
    if (operation.op === 'file.add' && output.some(candidate => candidate.op === 'file.add' && candidate.id === operation.id)) continue
    output.push(operation)
  }
  return output.filter(operation => operation.op !== 'element.update' || Object.keys(operation.changes).some(key => !same(operation.before[key], operation.changes[key])))
}

export function selectedRegion(elements: readonly CanvasElement[], ids: string[]): Selection | null {
  const selected = new Set(ids)
  // Bound text and frame children are editable objects in their own right.
  for (const element of elements) if (selected.has(String(element.containerId)) || selected.has(String(element.frameId))) selected.add(element.id)
  for (const element of elements) {
    const spec=specTag(element)
    if(spec?.kind==='spec' && selected.has(spec.root))selected.add(element.id)
  }
  const targets = elements.filter(element => selected.has(element.id) && !element.isDeleted)
  if (!targets.length) return null
  const bounds = targets.map(element => {
    let { x, y, width: signedWidth, height: signedHeight } = element
    // Match canvas-core Region::of: an arrow can travel left/up of its origin.
    // Native width/height alone do not describe the actual routed line bounds.
    if (['arrow', 'line', 'freedraw'].includes(element.type) && Array.isArray(element.points) && element.points.length) {
      const points = element.points as number[][]
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const [px, py] of points) { minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py) }
      x += minX; y += minY
      signedWidth = maxX - minX
      signedHeight = maxY - minY
    }
    const angle = typeof element.angle === 'number' ? element.angle : 0
    const width = Math.abs(signedWidth * Math.cos(angle)) + Math.abs(signedHeight * Math.sin(angle))
    const height = Math.abs(signedHeight * Math.cos(angle)) + Math.abs(signedWidth * Math.sin(angle))
    return { x: x + (signedWidth - width) / 2, y: y + (signedHeight - height) / 2, width, height }
  })
  const x = Math.min(...bounds.map(b => b.x)), y = Math.min(...bounds.map(b => b.y))
  return { elementIds: targets.map(element => element.id), region: { x, y, width: Math.max(...bounds.map(b => b.x + b.width)) - x, height: Math.max(...bounds.map(b => b.y + b.height)) - y } }
}
