import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  newElementWith,
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

import { boardShape, extensibleShape, shapeBox, type ShapeKind } from './boardShapes'
import type { NoteFormat } from './StickyToolbar'
import { pointOnSide, type NoteDirection } from './sceneGeometry'

export type BoardPoint = { x: number; y: number }
export type BoardBox = BoardPoint & { width: number; height: number }
export type BoardObjectKind = 'sticky' | 'table' | 'spec' | 'comment' | 'tape'
export type TapePattern = 'checker' | 'grid' | 'stripe'
export type BoardTag = {
  kind: BoardObjectKind
  root: string
  part?: string
  row?: number
  col?: number
  author?: string
  noteFormat?: NoteFormat
  showAuthor?: boolean
  resolved?: boolean
}
type Shape = NonNullable<
  Parameters<typeof convertToExcalidrawElements>[0]
>[number]
export const boardTag = (el: ExcalidrawElement | undefined) =>
  el?.customData?.officeBoard as BoardTag | undefined
const tag = (value: BoardTag) => ({ officeBoard: value })
const newId = (kind: string) => kind + '-' + crypto.randomUUID()
const ink = '#28272b'
export function insertBoardShapes(
  editor: ExcalidrawImperativeAPI,
  shapes: Shape[],
  selectId?: string,
) {
  const created = convertToExcalidrawElements(shapes, { regenerateIds: false })
  // Native history and the normal field-level canvas transaction both see one insertion.
  editor.updateScene({
    elements: [...editor.getSceneElementsIncludingDeleted(), ...created],
    appState: { selectedElementIds: selectId ? { [selectId]: true } : {} },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
  return created
}
export const stickySize = 192
export const stickyInset = 15
export const stickyFont = 20

export function stickyLabel(elements: readonly ExcalidrawElement[], id?: string) {
  return elements.find((el): el is Extract<ExcalidrawElement, { type: 'text' }> =>
    !el.isDeleted && el.type === 'text' && el.containerId === id)
}

export function saveSticky(
  editor: ExcalidrawImperativeAPI, at: BoardPoint, text: string, paper: string, author: string,
  height: number, existing?: ExcalidrawElement, width = stickySize, format?: NoteFormat, mentions?: import('./BoardMentions').BoardMention[],
) {
  const id = existing?.id ?? newId('sticky')
  const elements = editor.getSceneElementsIncludingDeleted()
  const previous = stickyLabel(elements, id)
  const body = text || ' '
  const [sheet, label] = convertToExcalidrawElements([{
    type: 'rectangle', id, ...at, width: existing?.width ?? width, height,
    fillStyle: 'solid', backgroundColor: paper, strokeColor: 'transparent', roughness: 0,
    customData: { ...tag({ kind: 'sticky', root: id, author, ...(format && {noteFormat:format}) }), ...(mentions && {mentions}) },
    label: { text: body, strokeColor: previous?.strokeColor ?? ink, fontSize: format?.size ?? previous?.fontSize ?? stickyFont,
      fontFamily: previous?.fontFamily ?? 2, textAlign: 'left', verticalAlign: 'top' },
  }], { regenerateIds: false })
  if (label.type !== 'text') throw new Error('生成便利贴正文失败')
  const newText = previous ? newElementWith(previous, {
    text: label.text, originalText: body, fontSize:label.fontSize, width: label.width, height: label.height,
    textAlign: 'left', verticalAlign: 'top', x: label.x, y: label.y,
  }) : label
  const newSheet = existing ? newElementWith(existing, {
    height: Math.max(existing.height, height), backgroundColor: paper,
    customData: { ...existing.customData, ...(mentions && {mentions}), officeBoard: { ...boardTag(existing), ...(format && {noteFormat:format}) } },
    boundElements: previous ? existing.boundElements : [...(existing.boundElements ?? []), { type: 'text', id: newText.id }],
  }) : sheet
  editor.updateScene({
    elements: existing ? [...elements.map(el => el.id === id ? newSheet : el.id === previous?.id ? newText : el),
      ...(previous ? [] : [newText])] : [...elements, newSheet, newText],
    appState: { selectedElementIds: { [id]: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
  return id
}

export function connectNotes(editor: ExcalidrawImperativeAPI, sourceId: string, side: NoteDirection,
  target: string | BoardPoint | { shape: ShapeKind }) {
  const all: ExcalidrawElement[] = [...editor.getSceneElementsIncludingDeleted()]
  const source = all.find(el => el.id === sourceId && !el.isDeleted && !el.locked)
  if (!source) return
  let neighbor: ExcalidrawElement | undefined
  if (typeof target === 'object' && 'shape' in target) {
    const box = shapeBox(source), horizontal = side === 'left' || side === 'right'
    const center = pointOnSide(box, side, 60 + (horizontal ? box.width : box.height) / 2)
    const at = { x: center.x - box.width / 2, y: center.y - box.height / 2 }
    const occupied = all.filter(el => extensibleShape(el) || !el.isDeleted && boardTag(el)?.kind === 'sticky').map(shapeBox)
    const x = at.x, y = at.y
    for (let slot = 1; occupied.some(o => at.x < o.x + o.width && at.x + box.width > o.x && at.y < o.y + o.height && at.y + box.height > o.y); slot++) {
      const offset = Math.ceil(slot / 2) * (slot % 2 ? 1 : -1)
      if (horizontal) at.y = y + offset * (box.height + 16)
      else at.x = x + offset * (box.width + 16)
    }
    const { shape } = boardShape(target.shape, { ...at, width: box.width, height: box.height }, {
      strokeColor: source.strokeColor, backgroundColor: source.backgroundColor, strokeWidth: source.strokeWidth,
      roughness: source.roughness, fillStyle: source.fillStyle,
    })
    neighbor = convertToExcalidrawElements([shape], { regenerateIds: false })[0]
    all.push(neighbor)
  }
  const destination = neighbor ?? (typeof target === 'string' ? all.find(el => el.id === target && !el.isDeleted && !el.locked) : undefined)
  if (typeof target === 'string' && !destination) return
  // Polygon outlines are native lines. Group each with a transparent native
  // binding target on first connection so dragging and undo work in Excalidraw.
  function bindingTarget(el: ExcalidrawElement) {
    if (el.type !== 'line') return el
    const group = el.id + '-ports'
    const existing = all.find(item => item.groupIds.includes(group) && item.customData?.officeShapeAnchor && !item.isDeleted)
    if (existing) return existing
    const box = shapeBox(el)
    const [anchor] = convertToExcalidrawElements([{ type: 'rectangle', id: newId('port'), ...box,
      strokeColor: 'transparent', backgroundColor: 'transparent', opacity: 0,
      customData: { officeShapeAnchor: true }, groupIds: [group] }], { regenerateIds: false })
    all.splice(all.indexOf(el), 1, newElementWith(el, { groupIds: [group] }), anchor)
    return anchor
  }
  const a = bindingTarget(source), b = destination && bindingTarget(destination)
  const start = pointOnSide(a, side)
  let end: BoardPoint
  if (b) {
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2
    const dx = start.x - cx, dy = start.y - cy
    const nx = dx / Math.max(0.1, b.width / 2), ny = dy / Math.max(0.1, b.height / 2)
    const divisor = b.type === 'ellipse' ? Math.hypot(nx, ny) : b.type === 'diamond' ? Math.abs(nx) + Math.abs(ny) : Math.max(Math.abs(nx), Math.abs(ny))
    end = divisor ? { x: cx + dx / divisor, y: cy + dy / divisor } : { x: cx, y: cy }
  } else end = target as BoardPoint
  if (Math.hypot(end.x - start.x, end.y - start.y) < 1) return
  const id = newId('connector')
  const [edge] = convertToExcalidrawElements([{ id, type: 'arrow', ...start, points: [[0, 0], [end.x-start.x, end.y-start.y]],
    roughness: 0, strokeWidth: 2, strokeColor: '#746790', endArrowhead: 'arrow' }], { regenerateIds: false })
  if (edge.type !== 'arrow') return
  const bind = (elementId: string) => ({ elementId, focus: 0, gap: 1, fixedPoint: null })
  editor.updateScene({
    elements: [...all.map(el => el === a || el === b ? newElementWith(el, { boundElements: [...(el.boundElements || []), { type: 'arrow', id }] }) : el),
      newElementWith(edge, { startBinding: bind(a.id), endBinding: b ? bind(b.id) : null })],
    ...(neighbor && b && { appState: { selectedElementIds: { [neighbor.id]: true, [b.id]: true } as Record<string, true> } }),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
}

export function specElements(
  id: string,
  at: BoardPoint,
  title: string,
  body: string,
) {
  const groupIds = [id + '-group'],
    width = 520
  const height = Math.max(
    290,
    110 +
      body
        .split('\n')
        .reduce((sum, s) => sum + Math.max(1, Math.ceil(s.length / 36)), 0) *
        25,
  )
  const shapes: Shape[] = [
    {
      id,
      type: 'rectangle',
      ...at,
      width,
      height,
      groupIds,
      fillStyle: 'solid',
      backgroundColor: '#ffffff',
      strokeColor: '#dcdde2',
      strokeWidth: 1,
      roughness: 0,
      customData: tag({ kind: 'spec', root: id, part: 'paper' }),
    },
  ]
  for (const [part, text, offset, size] of [
    ['title', title, 28, 28],
    ['body', body, 83, 17],
  ] as const) {
    shapes.push({
      id: id + '-' + part,
      type: 'text',
      x: at.x + 28,
      y: at.y + offset,
      width: width - 56,
      autoResize: false,
      text: text || ' ',
      fontFamily: 2,
      fontSize: size,
      strokeColor: ink,
      groupIds,
      customData: tag({ kind: 'spec', root: id, part }),
    })
  }
  // The native converter measures the placeholder as one space, even for a
  // fixed-width text shape. Reserve the writing column before typing begins.
  return convertToExcalidrawElements(shapes, { regenerateIds: false }).map(el =>
    el.type === 'text' ? { ...el, width: width - 56, autoResize: false } : el,
  )
}
export function insertBoardTable(
  editor: ExcalidrawImperativeAPI,
  at: BoardPoint,
  rows: number,
  columns: number,
) {
  const root = newId('table'),
    groupIds = [root],
    shapes: Shape[] = []
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < columns; col++) {
      const id = root + '-' + row + '-' + col
      shapes.push({
        id,
        type: 'rectangle',
        x: at.x + col * 108,
        y: at.y + row * 44,
        width: 108,
        height: 44,
        groupIds,
        fillStyle: 'solid',
        backgroundColor: row === 0 ? '#eff2f4' : '#ffffff',
        strokeColor: '#b6bac1',
        strokeWidth: 1,
        roughness: 0,
        customData: tag({ kind: 'table', root, row, col }),
        label: { text: ' ', fontFamily: 2, fontSize: 15, strokeColor: ink },
      })
    }
  insertBoardShapes(editor, shapes, root + '-0-0')
  return root
}
export function insertComment(
  editor: ExcalidrawImperativeAPI,
  at: BoardPoint,
  author: string,
  text: string,
  metadata: {createdAt:number;authorId?:string;mentions:import('./BoardMentions').BoardMention[];imageFileId?:string},
) {
  const id = newId('comment')
  insertBoardShapes(
    editor,
    [
      {
        id,
        type: 'ellipse',
        ...at,
        width: 36,
        height: 36,
        roughness: 0,
        strokeWidth: 2,
        strokeColor: '#ffffff',
        backgroundColor: '#7250aa',
        fillStyle: 'solid',
        customData: {
          ...tag({ kind: 'comment', root: id, author }),
          officeComment: text,
          ...metadata,
        },
        label: {
          text: author.slice(0, 1) || '·',
          fontSize: 16,
          fontFamily: 2,
          strokeColor: '#ffffff',
        },
      },
    ],
    id,
  )
  return id
}
export function insertTape(
  editor: ExcalidrawImperativeAPI,
  start: BoardPoint,
  end: BoardPoint,
  pattern: TapePattern,
  primary: string,
) {
  const root = newId('tape'),
    groupIds = [root],
    length = Math.max(28, Math.hypot(end.x - start.x, end.y - start.y))
  const angle = Math.atan2(end.y - start.y, end.x - start.x),
    dx = Math.cos(angle),
    dy = Math.sin(angle),
    height = 24
  const shapes: Shape[] = []
  const tile = (
    along: number,
    across: number,
    w: number,
    h: number,
    color: string,
    part: string,
  ) => {
    const x =
        start.x +
        dx * (along + w / 2) -
        dy * (across + h / 2 - height / 2) -
        w / 2,
      y =
        start.y +
        dy * (along + w / 2) +
        dx * (across + h / 2 - height / 2) -
        h / 2
    shapes.push({
      id: part === 'paper' ? root : newId('tile'),
      type: 'rectangle',
      x,
      y,
      width: w,
      height: h,
      angle,
      groupIds,
      strokeColor: 'transparent',
      backgroundColor: color,
      fillStyle: 'solid',
      roughness: 0,
      customData: tag({ kind: 'tape', root, part }),
    })
  }
  tile(0, 0, length, height, '#fff8df', 'paper')
  const size = Math.max(pattern === 'checker' ? 6 : 10, length / 64)
  for (let n = 0; n * size < length; n++) {
    const x = n * size,
      w = Math.min(size, length - x)
    if (pattern === 'checker') {
      for (let row = n % 2; row < 4; row += 2)
        tile(x, row * 6, w, 6, primary, 'pattern')
    } else
      tile(
        x,
        0,
        Math.min(w, pattern === 'grid' ? 1.5 : 4),
        height,
        primary,
        'pattern',
      )
  }
  if (pattern === 'grid')
    for (const y of [5, 14, 22]) tile(0, y, length, 1.2, primary, 'pattern')
  insertBoardShapes(editor, shapes, root)
  return root
}
