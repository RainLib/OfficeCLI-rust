import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { BoardBox } from './boardObjects'

export type ShapeKind =
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'triangle'
  | 'down'
  | 'rounded'
  | 'cylinder'
  | 'star'
  | 'hexagon'
  | 'speech'
  | 'parallelogram'
  | 'document'
export const shapes: [ShapeKind, string][] = [
  ['rectangle', '方形'],
  ['ellipse', '圆形'],
  ['diamond', '菱形'],
  ['triangle', '三角形'],
  ['down', '倒三角形'],
  ['rounded', '圆角矩形'],
  ['cylinder', '圆柱体'],
]
export const extraShapes: [ShapeKind, string][] = [
  ['star', '星形'],
  ['hexagon', '六边形'],
  ['speech', '对话框'],
  ['parallelogram', '平行四边形'],
  ['document', '文件形状'],
]
export const outlines: Partial<Record<ShapeKind, number[][]>> = {
  triangle: [
    [0.5, 0],
    [1, 1],
    [0, 1],
    [0.5, 0],
  ],
  down: [
    [0, 0],
    [1, 0],
    [0.5, 1],
    [0, 0],
  ],
  cylinder: [
    [0, 0.12],
    [0.2, 0],
    [0.8, 0],
    [1, 0.12],
    [1, 0.88],
    [0.8, 1],
    [0.2, 1],
    [0, 0.88],
    [0, 0.12],
    [0.2, 0.22],
    [0.8, 0.22],
    [1, 0.12],
  ],
  hexagon: [
    [0.22, 0],
    [0.78, 0],
    [1, 0.5],
    [0.78, 1],
    [0.22, 1],
    [0, 0.5],
    [0.22, 0],
  ],
  speech: [
    [0, 0],
    [1, 0],
    [1, 0.78],
    [0.52, 0.78],
    [0.28, 1],
    [0.31, 0.78],
    [0, 0.78],
    [0, 0],
  ],
  parallelogram: [
    [0.22, 0],
    [1, 0],
    [0.78, 1],
    [0, 1],
    [0.22, 0],
  ],
  document: [
    [0, 0],
    [0.74, 0],
    [1, 0.25],
    [1, 1],
    [0, 1],
    [0, 0],
    [0.74, 0],
    [0.74, 0.25],
    [1, 0.25],
  ],
  star: Array.from({ length: 11 }, (_, i) => [
    0.5 + 0.5 * (i % 2 ? 0.45 : 1) * Math.cos(-Math.PI / 2 + (i * Math.PI) / 5),
    0.5 + 0.5 * (i % 2 ? 0.45 : 1) * Math.sin(-Math.PI / 2 + (i * Math.PI) / 5),
  ]),
}
export function boardShape(kind: ShapeKind, box: BoardBox, style: Pick<ExcalidrawElement, 'strokeColor' | 'backgroundColor' | 'strokeWidth' | 'roughness' | 'fillStyle'>) {
  const id = 'shape-' + crypto.randomUUID(), base = { id, ...box, ...style }
  const outline = outlines[kind]
  type Skeleton = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number]
  const shape: Skeleton = outline ? {
    ...base, type: 'line', customData: { officeShape: kind },
    points: outline.map(([x, y]) => [x * box.width, y * box.height] as [number, number]),
  } : {
    ...base, type: kind === 'ellipse' || kind === 'diamond' ? kind : 'rectangle',
    roundness: kind === 'rounded' ? { type: 3 } : null,
  }
  return { id, shape }
}

export function extensibleShape(el: ExcalidrawElement) {
  if (el.isDeleted || el.locked || el.customData?.officeBoard || el.customData?.officeDiagram || el.customData?.officeBuiltin || el.customData?.officeShapeAnchor) return false
  if (el.groupIds.length && !(el.groupIds.length === 1 && el.groupIds[0] === el.id + '-ports')) return false
  return el.type === 'rectangle' || el.type === 'ellipse' || el.type === 'diamond' ||
    (el.type === 'line' && (el.customData?.officeShape || (el.id.startsWith('shape-') && el.points.length >= 4)))
}

export function shapeBox(el: ExcalidrawElement) {
  if (el.type !== 'line') return { x: el.x, y: el.y, width: el.width, height: el.height, angle: el.angle }
  const xs = el.points.map(p => p[0]), ys = el.points.map(p => p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x: el.x + x, y: el.y + y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, angle: el.angle }
}
