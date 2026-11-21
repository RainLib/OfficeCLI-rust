import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw'
import type {
  ExcalidrawElement,
  ExcalidrawElbowArrowElement,
  FixedPointBinding,
  ExcalidrawTextElement,
} from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { stickyLabel, type BoardPoint } from './boardObjects'

type Scene = readonly ExcalidrawElement[]
type DiagramNode = {
  id: string
  layout: 'mindmap'
  nodeId: string
  nodeTitle: string
  title: string
  kind: string
}
function diagram(el?: ExcalidrawElement): DiagramNode | undefined {
  const d = el?.customData?.officeDiagram
  return d?.layout === 'mindmap' && typeof d.nodeId === 'string' ? d : undefined
}
export const isMindNode = (el?: ExcalidrawElement) =>
  !!el && !el.isDeleted && (el.customData?.officeBuiltin?.kind === 'mind' || !!diagram(el))
export function mindOwner(scene: Scene, el?: ExcalidrawElement) {
  if (!el || el.isDeleted) return
  if (isMindNode(el)) return el
  if (el.type !== 'text') return
  return scene.find(
    (node) =>
      isMindNode(node) &&
      (node.id === el.containerId || (!!node.groupIds[0] && node.groupIds[0] === el.groupIds[0])),
  )
}
export type MindText = { title: string; body: string }
export type MindFields = { title?: ExcalidrawTextElement; body?: ExcalidrawTextElement }
export function mindFields(scene: Scene, node: ExcalidrawElement): MindFields {
  const fields: MindFields = { title: stickyLabel(scene, node.id) }
  const d = diagram(node)
  const group = node.groupIds[0]
  if (!group) return fields
  for (const el of scene) {
    if (el.isDeleted || el.type !== 'text' || el.groupIds[0] !== group) continue
    const role: unknown = el.customData?.officeNodeField
    if (role === 'title' || role === 'body') fields[role] = el
    else if (d && el.id.startsWith(d.id + '-title-')) fields.title = el
    else if (d && el.id.startsWith(d.id + '-text-')) fields.body = el
    // Excalidraw assigns new IDs to duplicated legacy groups.
    else if (d && !role && !fields.title && el.fontSize === 20) fields.title = el
    else if (d && !role && !fields.body && el.fontSize === 16) fields.body = el
  }
  return fields
}
export function mindText(fields: MindFields): MindText {
  return { title: fields.title?.originalText ?? '', body: fields.body?.originalText ?? '' }
}

export function mindParent(scene: Scene, node: ExcalidrawElement) {
  const d = diagram(node)
  if (!d) return scene.find((el) => isMindNode(el) && el.id === node.customData?.officeBuiltin?.parent)
  const edge = scene.find(
    (el) =>
      !el.isDeleted &&
      el.type === 'arrow' &&
      el.customData?.officeDiagram?.id === d.id &&
      (el.endBinding?.elementId === node.id ||
        (!el.endBinding && el.customData?.officeDiagram?.to === d.nodeId)),
  )
  if (edge?.type === 'arrow')
    return scene.find(
      (el) =>
        isMindNode(el) &&
        (edge.startBinding
          ? el.id === edge.startBinding.elementId
          : diagram(el)?.id === d.id && diagram(el)?.nodeId === edge.customData?.officeDiagram?.from),
    )
}
export type MindDirection = -1 | 1
function sideOf(parent: ExcalidrawElement, child: ExcalidrawElement): MindDirection {
  return child.x + child.width / 2 < parent.x + parent.width / 2 ? -1 : 1
}
export function mindSide(scene: Scene, node: ExcalidrawElement): MindDirection {
  const ancestor = mindParent(scene, node)
  if (ancestor) return sideOf(ancestor, node)
  const d = diagram(node)
  const targets = new Set<string>()
  if (d)
    for (const el of scene) {
      if (
        !el.isDeleted &&
        el.type === 'arrow' &&
        el.customData?.officeDiagram?.id === d.id &&
        el.startBinding?.elementId === node.id &&
        el.endBinding
      )
        targets.add(el.endBinding.elementId)
    }
  const children = scene.filter(
    (el) => isMindNode(el) && (targets.has(el.id) || el.customData?.officeBuiltin?.parent === node.id),
  )
  return children.reduce((sum, child) => sum + sideOf(node, child), 0) > 0 ? -1 : 1
}

const branchGap = 32
type Shift = { x: number; y: number }

function blocksBranch(el: ExcalidrawElement) {
  return (
    !el.isDeleted &&
    el.opacity > 0 &&
    !['arrow', 'line', 'freedraw', 'frame', 'magicframe'].includes(el.type)
  )
}

// Slide the ordered stack together so unrelated canvas objects stay in place.
function clearStackShift(intervals: [number, number][]) {
  let low = Infinity,
    high = -Infinity
  for (const [a, b] of intervals.sort((left, right) => left[0] - right[0])) {
    if (a >= high) {
      if (low < 0 && high > 0) break
      low = a
      high = b
    } else high = Math.max(high, b)
  }
  return low < 0 && high > 0 ? (Math.abs(low) < high ? low : high) : 0
}

function branchLayout(
  scene: Scene,
  parent: ExcalidrawElement,
  side: MindDirection,
  added?: ExcalidrawElement,
  after?: ExcalidrawElement,
) {
  const nodes = scene.filter(isMindNode)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const children = new Map<string, ExcalidrawElement[]>()
  const parentIds = new Map<string, string>()
  for (const el of scene) {
    if (el.isDeleted || el.type !== 'arrow') continue
    if (
      el.startBinding &&
      el.endBinding &&
      byId.has(el.startBinding.elementId) &&
      byId.has(el.endBinding.elementId) &&
      el.customData?.officeDiagram?.layout === 'mindmap'
    ) {
      parentIds.set(el.endBinding.elementId, el.startBinding.elementId)
    }
  }
  for (const node of nodes) {
    const id =
      node.customData?.officeBuiltin?.parent ??
      parentIds.get(node.id) ??
      (diagram(node) && mindParent(scene, node)?.id)
    if (typeof id !== 'string') continue
    const list = children.get(id) ?? []
    list.push(node)
    children.set(id, list)
  }
  const siblings = (children.get(parent.id) ?? [])
    .filter((n) => n.id !== added?.id && sideOf(parent, n) === side)
    .sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2)
  const column = siblings[0] ?? added
  if (!column) return new Map<string, Shift>()
  const index = after ? siblings.findIndex((n) => n.id === after.id) : -1
  if (added) siblings.splice(index < 0 ? siblings.length : index + 1, 0, added)
  const seen = new Set([parent.id])
  const lanes = siblings.map((root) => {
    const members = new Set<string>(),
      groups = new Set<string>(),
      pending = [root]
    while (pending.length) {
      const node = pending.pop()!
      if (seen.has(node.id)) continue
      seen.add(node.id)
      members.add(node.id)
      if (node.groupIds[0]) groups.add(node.groupIds[0])
      pending.push(...(children.get(node.id) ?? []))
    }
    const contents = scene.filter(
      (el) =>
        !el.isDeleted &&
        (members.has(el.id) ||
          (el.type === 'text' && (members.has(el.containerId ?? '') || groups.has(el.groupIds[0])))),
    )
    const left = Math.min(...contents.map((el) => el.x)),
      top = Math.min(...contents.map((el) => el.y))
    const right = Math.max(...contents.map((el) => el.x + el.width)),
      bottom = Math.max(...contents.map((el) => el.y + el.height))
    return {
      root,
      contents,
      box: { x: left, y: top, width: right - left, height: bottom - top },
      pinned: contents.some((el) => el.locked),
    }
  })
  const movable = new Set(
    lanes.filter((lane) => !lane.pinned).flatMap((lane) => lane.contents.map((el) => el.id)),
  )
  const obstacles = scene.filter((el) => blocksBranch(el) && !movable.has(el.id))
  const total = lanes.reduce((h, lane) => h + lane.box.height, branchGap * (lanes.length - 1))
  let y = parent.y + (parent.height - total) / 2
  const positions = new Map<string, Shift>()
  // Locked siblings divide the column into runs that can be arranged independently.
  function pack(run: typeof lanes, minY: number, maxY: number) {
    if (!run.length) return
    const height = run.reduce((h, lane) => h + lane.box.height, branchGap * (run.length - 1))
    let cursor = Math.max(minY, Math.min(y, maxY - height))
    const planned = run.map((lane) => {
      const dx =
        side === 1 ? column.x - lane.root.x : column.x + column.width - lane.root.x - lane.root.width
      const dy = cursor - lane.box.y
      cursor += lane.box.height + branchGap
      return { lane, dx, dy }
    })
    const intervals: [number, number][] = []
    for (const { lane, dx, dy } of planned)
      for (const el of lane.contents) {
        if (!isMindNode(el)) continue
        const x = el.x + dx,
          top = el.y + dy
        for (const other of obstacles) {
          if (other.x < x + el.width + 16 && other.x + other.width > x - 16)
            intervals.push([other.y - top - el.height - 20, other.y + other.height - top + 20])
        }
      }
    const shift = clearStackShift(intervals)
    for (const { lane, dx, dy } of planned)
      for (const el of lane.contents)
        if (dx || dy + shift) positions.set(el.id, { x: dx, y: dy + shift })
    y = cursor + shift
  }
  let runStart = 0,
    minY = -Infinity
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]
    if (!lane.pinned) continue
    pack(lanes.slice(runStart, i), minY, lane.box.y - branchGap)
    minY = lane.box.y + lane.box.height + branchGap
    y = Math.max(y, minY)
    runStart = i + 1
  }
  pack(lanes.slice(runStart), minY, Infinity)
  return positions
}

function moveBranches(
  scene: Scene,
  shifts: Map<string, Shift>,
  resized?: { id: string; heightDelta: number },
) {
  const zero = { x: 0, y: 0 }
  return scene.map((el) => {
    const shift = shifts.get(el.id)
    if (shift) return newElementWith(el, { x: el.x + shift.x, y: el.y + shift.y })
    if (el.isDeleted || el.type !== 'arrow') return el
    const movement = (binding: typeof el.startBinding) => {
      if (!binding) return zero
      const delta = shifts.get(binding.elementId) ?? zero
      if (!resized || resized.id !== binding.elementId) return delta
      const point = (binding as FixedPointBinding).fixedPoint
      return { x: delta.x, y: delta.y + (point?.[1] ?? 0.5) * resized.heightDelta }
    }
    const a = movement(el.startBinding),
      b = movement(el.endBinding)
    if (a === zero && b === zero) return el
    const x = el.x + a.x,
      y = el.y + a.y
    if (a.x === b.x && a.y === b.y) return newElementWith(el, { x, y })
    const last = el.points[el.points.length - 1],
      dx = last[0] + b.x - a.x,
      dy = last[1] + b.y - a.y
    // Generated branches use horizontal end segments. Preserve authored intermediate
    // bends on other arrows, translating their endpoints with the bound cards.
    const points =
      'elbowed' in el && el.elbowed && !(el as ExcalidrawElbowArrowElement).fixedSegments?.length
        ? Math.abs(dy) < 0.001
          ? [
              [0, 0],
              [dx, 0],
            ]
          : [
              [0, 0],
              [dx / 2, 0],
              [dx / 2, dy],
              [dx, dy],
            ]
        : el.points.map((p, i) =>
            i === 0 ? [0, 0] : i === el.points.length - 1 ? [dx, dy] : [p[0] - a.x, p[1] - a.y],
          )
    const xs = points.map((p) => p[0]),
      ys = points.map((p) => p[1])
    return newElementWith(el, {
      x,
      y,
      points: points as typeof el.points,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    })
  })
}
const papers = ['#edf2ea', '#edf1f6', '#f3edf4', '#fff2d9']
const inks = ['#59745f', '#54728c', '#886c8f', '#886c41']

export function addMindNode(
  api: ExcalidrawImperativeAPI,
  at: BoardPoint,
  parent?: ExcalidrawElement,
  side: MindDirection = 1,
  sibling?: ExcalidrawElement,
) {
  const elements = api.getSceneElementsIncludingDeleted(),
    d = diagram(parent)
  const uid = crypto.randomUUID(),
    id = d ? d.id + '-node-' + uid : 'mind-' + uid
  const width = d ? Math.max(180, Math.min(340, parent!.width)) : 172,
    height = 64
  const x = parent ? (side === 1 ? parent.x + parent.width + 80 : parent.x - 80 - width) : at.x
  const preferredY = sibling
    ? sibling.y + sibling.height + 28
    : parent
      ? parent.y + (parent.height - height) / 2
      : at.y
  const y = preferredY
  const edges = parent?.boundElements?.filter((el) => el.type === 'arrow').length ?? 0,
    color = edges % papers.length
  const group = d ? d.id + '-node-group-' + uid : 'mind-group-' + uid
  const isRoot = !d && !parent
  const [node] = convertToExcalidrawElements(
    [
      {
        id,
        type: 'rectangle',
        x,
        y,
        width,
        height,
        fillStyle: 'solid',
        roughness: 0,
        strokeWidth: 1,
        roundness: { type: 3 },
        groupIds: [group],
        backgroundColor: isRoot ? '#e4dafb' : papers[color],
        strokeColor: d ? '#cacec6' : isRoot ? '#685584' : inks[color],
        customData: d
          ? {
              officeComposition: { group, role: 'rectangle' },
              officeDiagram: {
                id: d.id,
                title: d.title,
                layout: d.layout,
                nodeId: uid,
                kind: 'concept',
                group: null,
                nodeTitle: '',
              },
            }
          : { officeBuiltin: { kind: 'mind', ...(parent && { parent: parent.id }) } },
      },
    ],
    { regenerateIds: false },
  )
  const selected = {
    selectedElementIds: { [node.id]: true as const },
    selectedGroupIds: { [group]: true as const },
    editingGroupId: null,
  }
  if (!parent) {
    api.updateScene({
      elements: [...elements, node],
      appState: selected,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    return id
  }
  const edgeId = (d ? d.id + '-branch-' : 'branch-') + uid
  const sx = side === 1 ? parent.x + parent.width + 6 : parent.x - 6,
    sy = parent.y + parent.height / 2
  const dx = (side === 1 ? x - 6 : x + width + 6) - sx,
    dy = y + height / 2 - sy
  const [arrow] = convertToExcalidrawElements(
    [
      {
        id: edgeId,
        type: 'arrow',
        x: sx,
        y: sy,
        points:
          dy === 0
            ? [
                [0, 0],
                [dx, 0],
              ]
            : [
                [0, 0],
                [dx / 2, 0],
                [dx / 2, dy],
                [dx, dy],
              ],
        roughness: 0,
        strokeWidth: 2,
        strokeColor: inks[color],
        roundness: { type: 2 },
        startArrowhead: null,
        endArrowhead: null,
        ...(d && {
          customData: {
            officeDiagram: { id: d.id, layout: d.layout, from: d.nodeId, to: uid, label: '' },
          },
        }),
      },
    ],
    { regenerateIds: false },
  )
  if (arrow.type !== 'arrow') throw Error('无法创建分支')
  const binding = (elementId: string, right: boolean): FixedPointBinding => ({
    elementId,
    focus: 0,
    gap: 6,
    fixedPoint: [right ? 1 : 0, 0.5],
  })
  const bound = (el: ExcalidrawElement) =>
    newElementWith(el, { boundElements: [...(el.boundElements || []), { type: 'arrow', id: edgeId }] })
  const edge: ExcalidrawElbowArrowElement = {
    ...arrow,
    type: 'arrow',
    elbowed: true,
    fixedSegments: [],
    startIsSpecial: false,
    endIsSpecial: false,
    startBinding: binding(parent.id, side === 1),
    endBinding: binding(id, side === -1),
  }
  const connected = [...elements.map((el) => (el.id === parent.id ? bound(el) : el)), edge, bound(node)]
  const placed = moveBranches(connected, branchLayout(connected, parent, side, node, sibling))
  const placedNode = placed.find((el) => el.id === id)!
  api.updateScene({
    elements: placed,
    appState: selected,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
  const app = api.getAppState(),
    cx = (placedNode.x + width / 2 + app.scrollX) * app.zoom.value,
    cy = (placedNode.y + height / 2 + app.scrollY) * app.zoom.value
  if (cx < 36 || cy < 55 || cx > app.width - 36 || cy > app.height - 90)
    api.scrollToContent(placedNode, { animate: false })
  return id
}

export function saveMindText(
  api: ExcalidrawImperativeAPI,
  id: string,
  initial: MindText,
  draft: MindText,
) {
  const scene = api.getSceneElementsIncludingDeleted()
  const node = scene.find((el) => el.id === id && isMindNode(el))
  if (!node) throw Error('此节点已移除，请保留输入。')
  if (node.locked || api.getAppState().viewModeEnabled) throw Error('此节点当前不可编辑。')
  const fields = mindFields(scene, node)
  const current = mindText(fields)
  const keys = ['title', 'body'] as const
  const changed = keys.filter((key) => draft[key].trim() !== initial[key].trim())
  if (!changed.length) return
  for (const key of changed) {
    const value = draft[key].trim()
    if (value === current[key]) continue
    if (fields[key]?.locked || current[key] !== initial[key])
      throw Error('这段文字已被其他人更新或锁定，请保留输入并重新打开。')
    current[key] = value
  }
  const d = diagram(node)
  // Legacy manual topics used a single native bound label. Give both fields their
  // own group when editing it, keeping the original label ID and arrow bindings.
  const groupIds =
    node.groupIds.length && !fields.title?.containerId
      ? node.groupIds
      : ['mind-group-' + crypto.randomUUID(), ...node.groupIds]
  const inset = d ? 24 : 16
  const width = Math.max(24, node.width - inset * 2)
  const updated = new Map<string, ExcalidrawElement>()
  const labels: ExcalidrawTextElement[] = []
  const fresh = new Set<string>()
  for (const key of keys) {
    const previous = fields[key],
      text = current[key]
    if (!text) {
      if (previous) updated.set(previous.id, newElementWith(previous, { isDeleted: true }))
      continue
    }
    const fontSize = previous?.fontSize ?? (key === 'title' ? 20 : 16)
    const fontFamily = previous?.fontFamily ?? 2
    const [, metrics] = convertToExcalidrawElements([
      {
        type: 'rectangle',
        x: 0,
        y: 0,
        width: width + 10,
        height: 64,
        label: { text, fontSize, fontFamily, textAlign: 'left', verticalAlign: 'top' },
      },
    ])
    if (metrics?.type !== 'text') throw Error('无法测量节点文字。')
    const [label] = convertToExcalidrawElements(
      [
        {
          id:
            previous?.id ??
            (d?.id ?? node.id) + (key === 'title' ? '-title-' : '-text-') + crypto.randomUUID(),
          type: 'text',
          x: node.x + inset,
          y: node.y,
          text,
          fontSize,
          fontFamily,
          width,
          autoResize: false,
          groupIds,
          strokeColor:
            previous?.strokeColor ??
            (d?.kind === 'topic' ? '#ffffff' : key === 'title' ? '#252722' : '#61655c'),
        },
      ],
      { regenerateIds: false },
    )
    if (label.type !== 'text') throw Error('无法创建节点文字。')
    const lineHeight = previous?.lineHeight ?? label.lineHeight
    const props = {
      text: metrics.text,
      originalText: text,
      width,
      height: metrics.text.split('\n').length * fontSize * lineHeight,
      groupIds,
      containerId: null,
      autoResize: false,
      textAlign: 'left' as const,
      verticalAlign: 'top' as const,
      customData: {
        ...previous?.customData,
        officeNodeField: key,
        ...(d && { officeComposition: { group: groupIds[0], role: 'text' } }),
      },
    }
    labels.push(newElementWith(previous ?? label, props))
    if (!previous) fresh.add(label.id)
  }
  const gap = labels.length === 2 ? 10 : 0
  const textHeight = labels.reduce((sum, label) => sum + label.height, gap)
  const measuredHeight = Math.max(64, textHeight + inset * 2)
  const height =
    node.height === node.customData?.officeMindAutoHeight || node.height === 64
      ? measuredHeight
      : Math.max(node.height, measuredHeight)
  let y = node.y + (height - textHeight) / 2
  for (const label of labels) {
    updated.set(label.id, newElementWith(label, { x: node.x + inset, y }))
    y += label.height + gap
  }
  updated.set(
    node.id,
    newElementWith(node, {
      height,
      groupIds,
      boundElements: node.boundElements?.filter((binding) => binding.id !== fields.title?.id) ?? null,
      customData: {
        ...node.customData,
        officeMindAutoHeight: measuredHeight,
        ...(d && { officeDiagram: { ...d, nodeTitle: current.title } }),
      },
    }),
  )
  const next = scene.flatMap((el) => {
    const result = [updated.get(el.id) ?? el]
    if (el.id === node.id) for (const freshId of fresh) result.push(updated.get(freshId)!)
    return result
  })
  const resized = height !== node.height
  const parent = resized && mindParent(next, node)
  const shifts = parent ? branchLayout(next, parent, sideOf(parent, node)) : new Map<string, Shift>()
  api.updateScene({
    elements: resized ? moveBranches(next, shifts, { id, heightDelta: height - node.height }) : next,
    appState: {
      selectedElementIds: Object.fromEntries([node, ...labels].map((el) => [el.id, true as const])),
      selectedGroupIds: { [groupIds[0]]: true },
      editingGroupId: null,
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
}
