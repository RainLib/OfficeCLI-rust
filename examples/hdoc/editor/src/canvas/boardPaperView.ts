import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types'
import { boardTag, stickyInset } from './boardObjects'
import type { CanvasElement } from './model'

// Old generators drew classification labels as separate, editable text objects.
// Match their identity, group and original wording so authored text survives.
const previousKinds: Record<string, string> = {
  topic: '中心主题', concept: '概念讲解', process: '步骤', decision: '条件判断', terminal: '起止',
  service: '组件 / 服务', database: '数据存储', example: '示范例题', question: '思考练习', summary: '归纳总结',
}
export function presentDiagramCards(elements: readonly CanvasElement[]) {
  const badges = new Map<string, { node: CanvasElement; stem: string; suffix: string; wording: string }>()
  for (const node of elements) {
    const d = (node.customData as {officeDiagram?: {id: string; nodeId?: string; kind: string; layout: string}} | undefined)?.officeDiagram
    if (!d?.nodeId || (d.layout !== 'mindmap' && d.kind !== 'concept') || !node.id.startsWith(d.id + '-node-')) continue
    const suffix = node.id.slice(d.id.length + 6)
    badges.set(d.id + '-badge-' + suffix, {node, stem:d.id, suffix, wording:previousKinds[d.kind]})
  }
  if (!badges.size) return elements
  const byId = new Map(elements.map(el => [el.id, el]))
  const hidden = new Set<string>(), positions = new Map<string, number>()
  const group = (el: CanvasElement) => (el.groupIds as string[] | undefined)?.[0]
  for (const [id, {node,stem,suffix,wording}] of badges) {
    const badge = byId.get(id)
    if (!badge || badge.type !== 'text' || !group(node) || group(badge) !== group(node) ||
        badge.originalText !== wording || badge.text !== wording) continue
    hidden.add(id)
    if (node.angle || node.isDeleted || badge.isDeleted) continue
    const title = byId.get(stem + '-title-' + suffix), body = byId.get(stem + '-text-' + suffix)
    const fields = [title,body].filter((e):e is CanvasElement => !!e && !e.isDeleted)
    const top = node.y + 44
    if (!fields.length || fields.some(el => el.angle || el.type !== 'text' || group(el) !== group(node) || Math.abs(el.x - node.x - 24) > 1) ||
        (title && Math.abs(title.y-top)>1) || (body && title && Math.abs(body.y-top-title.height-12)>2)) continue
    let y = node.y + (node.height - fields.reduce((h,el) => h + el.height,0) - (fields.length-1)*12)/2
    for (const el of fields) { positions.set(el.id,y); y += el.height + 12 }
  }
  return hidden.size ? elements.filter(el => !hidden.has(el.id)).map(el => positions.has(el.id) ? {...el, y:positions.get(el.id)!} : el) : elements
}

const measurements = new Map<string, Pick<ExcalidrawTextElement, 'width' | 'height' | 'text'>>()

// Measure the same writing column for the native export and the formatted canvas preview.
function paperText(root: ExcalidrawElement, label: ExcalidrawTextElement): ExcalidrawTextElement {
  const width = Math.max(label.fontSize, root.width - stickyInset * 2)
  const key = JSON.stringify([width, label.originalText, label.fontSize, label.fontFamily, label.lineHeight])
  let metrics = measurements.get(key)
  if (!metrics) {
    const [, measured] = convertToExcalidrawElements([{
      type: 'rectangle', x: 0, y: 0, width: width + 10, height: root.height,
      label: { text: label.originalText || ' ', fontFamily: label.fontFamily, fontSize: label.fontSize,
        textAlign: 'left', verticalAlign: 'top' },
    }])
    if (measured.type !== 'text') return label
    metrics = { width: measured.width, height: measured.height, text: measured.text }
    if (measurements.size >= 256) measurements.delete(measurements.keys().next().value!)
    measurements.set(key, metrics)
  }
  const dx = (metrics.width - root.width) / 2 + stickyInset
  const dy = (metrics.height - root.height) / 2 + stickyInset
  const c = Math.cos(root.angle), s = Math.sin(root.angle)
  return { ...label, ...metrics, textAlign: 'left', verticalAlign: 'top', angle: root.angle,
    x: root.x + (root.width - metrics.width) / 2 + dx * c - dy * s,
    y: root.y + (root.height - metrics.height) / 2 + dx * s + dy * c }
}

export function presentBoardPaper(elements: ExcalidrawElement[], live: boolean) {
  const roots = new Map(elements.filter(el => !el.isDeleted && (
    (el.type === 'rectangle' && boardTag(el)?.kind === 'sticky') ||
    (el.type === 'ellipse' && boardTag(el)?.kind === 'comment')
  )).map(el => [el.id, el]))
  return elements.map(el => {
    const root = el.type === 'text' && el.containerId ? roots.get(el.containerId) : roots.get(el.id)
    if (!root) return el
    if (boardTag(root)?.kind === 'comment') return live ? { ...el, opacity: 0 } : el
    return el.type === 'text' ? { ...paperText(root, el), ...(live && Object.keys(boardTag(root)?.noteFormat ?? {}).length > 0 ? {opacity:0} : {}) } : el
  })
}
