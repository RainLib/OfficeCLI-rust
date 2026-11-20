import { Group, Move, Ungroup } from 'lucide-react'
import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { PptxGeometry } from './FixedViewer'
import { useI18n } from './i18n'
import { LocalText, localizeSource } from './sourceLocale'

export type PptxPreset = 'rect' | 'roundRect' | 'ellipse'
export type PptxObject = {
  nodeId: string
  label: string
  kind: 'shape' | 'picture' | 'group'
  geometry: PptxGeometry
  order: number
  textIds: string[]
  rotation: number
  groupable: boolean
  members?: string[]
  canUngroup?: boolean
}
export type PptxMove = { nodeId: string; before: PptxGeometry; geometry: PptxGeometry }

const shapeNames = { rect: '矩形', roundRect: '圆角矩形', ellipse: '椭圆' }
const alignments = [
  ['left', '对象左对齐'], ['center', '对象水平居中'], ['right', '对象右对齐'],
  ['top', '对象顶端对齐'], ['middle', '对象垂直居中'], ['bottom', '对象底端对齐'],
] as const
type Alignment = (typeof alignments)[number][0]
const emuPerPixel = 9525
const size = (geometry: PptxGeometry) => ({
  left: geometry.xEmu / emuPerPixel,
  top: geometry.yEmu / emuPerPixel,
  width: geometry.widthEmu / emuPerPixel,
  height: geometry.heightEmu / emuPerPixel,
})
const sameGeometry = (a: PptxGeometry, b: PptxGeometry) =>
  a.xEmu === b.xEmu && a.yEmu === b.yEmu && a.widthEmu === b.widthEmu && a.heightEmu === b.heightEmu
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))
type DrawRect = { x: number; y: number; width: number; height: number }
type DrawTransform = { frame: DrawRect; children?: DrawRect; rotation: number; flipH: boolean; flipV: boolean }

function readTransform(element: Element): DrawTransform | undefined {
  const value = element.getAttribute('data-hcd-pptx-transform')
  if (!value) return
  try {
    return JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))) as DrawTransform
  } catch { return }
}

function transformGroup(transform: DrawTransform, geometry: PptxGeometry): string {
  const inner = transform.children!
  const angle = transform.rotation * Math.PI / 10_800_000
  const sx = geometry.widthEmu / inner.width * (transform.flipH ? -1 : 1)
  const sy = geometry.heightEmu / inner.height * (transform.flipV ? -1 : 1)
  const a = sx * Math.cos(angle), b = sx * Math.sin(angle), c = -sy * Math.sin(angle), d = sy * Math.cos(angle)
  const x = (inner.x + inner.width / 2) / emuPerPixel, y = (inner.y + inner.height / 2) / emuPerPixel
  const tx = (geometry.xEmu + geometry.widthEmu / 2) / emuPerPixel - a * x - c * y
  const ty = (geometry.yEmu + geometry.heightEmu / 2) / emuPerPixel - b * x - d * y
  return `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`
}

function objectId(element: Element): string | undefined {
  return element.getAttribute('data-hcd-id') ?? element.querySelector('[data-hcd-node-hash][data-hcd-id]')?.getAttribute('data-hcd-id') ?? undefined
}

function boxInSlide(geometry: PptxGeometry, rotation: number): PptxGeometry {
  if (!rotation) return geometry
  const angle = rotation * Math.PI / 10_800_000
  const side = Math.abs(Math.cos(angle)), cross = Math.abs(Math.sin(angle))
  const widthEmu = Math.round(geometry.widthEmu * side + geometry.heightEmu * cross)
  const heightEmu = Math.round(geometry.widthEmu * cross + geometry.heightEmu * side)
  return { xEmu: Math.round(geometry.xEmu + (geometry.widthEmu - widthEmu) / 2),
    yEmu: Math.round(geometry.yEmu + (geometry.heightEmu - heightEmu) / 2), widthEmu, heightEmu }
}

/** Project a group member's text hit area into the slide's coordinate space. */
export function groupedTextBounds(anchor: HTMLElement | null) {
  const group = anchor?.parentElement?.closest<HTMLElement>('.hcd-slide-group')
  if (!group || !anchor) return
  const [x, y, width, height] = ['left', 'top', 'width', 'height'].map(key => Number.parseFloat(anchor.style.getPropertyValue(key)))
  if (![x, y, width, height].every(Number.isFinite)) return
  const shape = new DOMMatrix(anchor.style.transform || undefined)
  const centerX = x + width / 2, centerY = y + height / 2
  const initial = new DOMMatrix().translate(centerX, centerY).multiply(shape).translate(-centerX, -centerY)
  let projection = initial
  for (let parent: HTMLElement | null = group; parent; parent = parent.parentElement?.closest<HTMLElement>('.hcd-slide-group') ?? null) {
    projection = new DOMMatrix(parent.style.transform || undefined).multiply(projection)
  }
  const corners = [[x, y], [x, y + height], [x + width, y], [x + width, y + height]]
    .map(([x, y]) => projection.transformPoint({ x, y }))
  const left = Math.min(...corners.map(point => point.x)), top = Math.min(...corners.map(point => point.y))
  const right = Math.max(...corners.map(point => point.x)), bottom = Math.max(...corners.map(point => point.y))
  return { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` }
}

/** DrawingML changes the frame sizes of a resized group while retaining run point sizes. */
export function keepNativeGroupTextSize(root: ParentNode) {
  const scales = new Map<HTMLElement, number>()
  for (const paragraph of root.querySelectorAll<HTMLElement>('.hcd-slide-group .hcd-slide-text')) {
    let scale = 1
    for (let group = paragraph.closest<HTMLElement>('.hcd-slide-group'); group; group = group.parentElement?.closest<HTMLElement>('.hcd-slide-group') ?? null) {
      let factor = scales.get(group)
      if (factor === undefined) {
        const matrix = new DOMMatrix(group.style.transform || undefined)
        const x = Math.hypot(matrix.a, matrix.b), y = Math.hypot(matrix.c, matrix.d)
        factor = x > 0 && Math.abs(x - y) <= Math.max(x, y) * .0001 ? x : 1
        scales.set(group, factor)
      }
      scale *= factor
    }
    const zoom = Math.abs(scale - 1) < .0001 || !Number.isFinite(scale) || scale <= 0 ? '' : String(1 / scale)
    paragraph.style.zoom = zoom
  }
}

export function readPptxObjects(canvas: HTMLElement | null): PptxObject[] {
  if (!canvas) return []
  return Array.from(canvas.children).flatMap((child, order) => {
    if (child.getAttribute('data-hcd-pptx-grouped') === 'true') return []
    const group = child.classList.contains('hcd-slide-group')
    if (group && child.getAttribute('data-hcd-pptx-group-complete') !== '1') return []
    const picture = child.getAttribute('data-hcd-node-kind') === 'image'
      && (child.hasAttribute('data-hcd-picture-id') || child.hasAttribute('data-hcd-created-image'))
    if (!group && !picture && !child.classList.contains('hcd-slide-shape')) return []
    const text = picture ? [] : Array.from(child.querySelectorAll<HTMLElement>('[data-hcd-node-hash][data-hcd-id]'))
    const textIds = text.map(node => node.dataset.hcdId!)
    const nodeId = objectId(child)
    if (!nodeId) return []
    const transform = readTransform(child)
    const bounds = (['x', 'y', 'width', 'height'] as const).map(axis => transform?.frame[axis] ??
      Number(child.getAttribute(picture ? 'data-hcd-' + axis : 'data-hcd-' + axis + '-emu') ?? NaN))
    const [xEmu, yEmu, widthEmu, heightEmu] = bounds
    if (!bounds.every(Number.isSafeInteger) || xEmu < 0 || yEmu < 0 || widthEmu <= 0 || heightEmu <= 0) return []
    const preset = child.getAttribute('data-hcd-created-preset') as PptxPreset | null
    const label = picture
      ? child.querySelector('img')?.alt || '图片'
      : (preset && shapeNames[preset]) || child.getAttribute('data-hcd-shape-name') || child.textContent?.trim().slice(0, 56) || '形状'
    const groupable = child.getAttribute('data-hcd-pptx-placeholder') !== 'true'
      && (group || !!preset || picture || child.hasAttribute('data-hcd-shape-id') || !child.hasAttribute('data-hcd-id') && !!textIds.length)
    return [{ nodeId, label, kind: group ? 'group' as const : picture ? 'picture' as const : 'shape' as const,
      geometry: { xEmu, yEmu, widthEmu, heightEmu }, order, textIds, groupable,
      rotation: transform?.rotation ?? Number(child.getAttribute('data-hcd-rotation') ?? 0),
      members: group ? Array.from(child.children).flatMap(member => objectId(member) ?? []) : undefined,
      canUngroup: group && child.getAttribute('data-hcd-pptx-can-ungroup') === '1' }]
  })
}

export function PptxInsertShape({ disabled, add }: { disabled: boolean; add: (preset: PptxPreset) => void }) {
  const { locale } = useI18n()
  return <select aria-label={localizeSource(locale, '插入形状')} value="" disabled={disabled}
    onChange={event => add(event.currentTarget.value as PptxPreset)}>
    <option value="" disabled>{localizeSource(locale, '形状')}</option>
    {Object.entries(shapeNames).map(([preset, name]) => <option key={preset} value={preset}>{localizeSource(locale, name)}</option>)}
  </select>
}

export function PptxArrange({ selected, mode, disabled, toggle, align, group, ungroup }: {
  selected: PptxObject[]; mode: boolean; disabled: boolean; toggle: () => void; align: (moves: PptxMove[]) => void
  group: () => void; ungroup: () => void
}) {
  const { locale } = useI18n()
  function apply(direction: Alignment) {
    const geometries = selected.map(object => boxInSlide(object.geometry, object.rotation))
    const left = Math.min(...geometries.map(geometry => geometry.xEmu))
    const right = Math.max(...geometries.map(geometry => geometry.xEmu + geometry.widthEmu))
    const top = Math.min(...geometries.map(geometry => geometry.yEmu))
    const bottom = Math.max(...geometries.map(geometry => geometry.yEmu + geometry.heightEmu))
    align(selected.flatMap(({ nodeId, geometry: before }, index) => {
      const geometry = { ...before }
      const bounds = geometries[index]
      if (direction === 'left') geometry.xEmu += left - bounds.xEmu
      if (direction === 'right') geometry.xEmu += right - bounds.xEmu - bounds.widthEmu
      if (direction === 'center') geometry.xEmu += Math.round((left + right - bounds.widthEmu) / 2) - bounds.xEmu
      if (direction === 'top') geometry.yEmu += top - bounds.yEmu
      if (direction === 'bottom') geometry.yEmu += bottom - bounds.yEmu - bounds.heightEmu
      if (direction === 'middle') geometry.yEmu += Math.round((top + bottom - bounds.heightEmu) / 2) - bounds.yEmu
      return sameGeometry(before, geometry) ? [] : [{ nodeId, before, geometry }]
    }))
  }
  return <div className="tool-group">
    <button type="button" aria-pressed={mode} disabled={disabled} onClick={toggle}><Move size={15} /><LocalText source="选择对象" /></button>
    {selected.length > 1 && <select aria-label={localizeSource(locale, '对象对齐')} value="" disabled={disabled}
      onChange={event => apply(event.currentTarget.value as Alignment)}>
      <option value="" disabled>{localizeSource(locale, '对象对齐')}</option>
      {alignments.map(([value, name]) => <option key={value} value={value}>{localizeSource(locale, name)}</option>)}
    </select>}
    {selected.length > 1 && selected.every(object => object.groupable) &&
      <button type="button" disabled={disabled} onClick={group}><Group size={15}/><LocalText source="组合" /></button>}
    {selected.length === 1 && selected[0].kind === 'group' &&
      <button type="button" disabled={disabled || !selected[0].canUngroup} onClick={ungroup}><Ungroup size={15}/><LocalText source="取消组合" /></button>}
  </div>
}

type SlideDrag = {
  pointer: number
  startX: number
  startY: number
  ratio: number
  mode: 'move' | 'resize'
  objects: PptxObject[]
  current: PptxMove[]
}

const noMoves: PptxMove[] = []

export function PptxObjectLayer({ objects, selected, objectMode, frame, slideWidth, slideHeight, disabled, pick, commit }: {
  objects: PptxObject[]; selected: string[]; objectMode: boolean; frame: RefObject<HTMLIFrameElement | null>
  slideWidth: number; slideHeight: number; disabled: boolean
  pick: (object: PptxObject, additive: boolean) => void; commit: (moves: PptxMove[]) => Promise<boolean>
}) {
  const { locale } = useI18n()
  const drag = useRef<SlideDrag | null>(null)
  const [preview, setPreview] = useState<PptxMove[]>(noMoves)
  const active = objects.filter(object => selected.includes(object.nodeId))
  const previewById = new Map(preview.map(move => [move.nodeId, move.geometry]))

  function paint(moves: PptxMove[], revert = false) {
    const doc = frame.current?.contentDocument
    for (const move of moves) {
      const element = doc?.querySelector<HTMLElement>(`[data-hcd-id="${CSS.escape(move.nodeId)}"]`)
      const position = element?.closest<HTMLElement>('.hcd-slide-group, .hcd-slide-shape, [data-hcd-node-kind="image"]')
      if (!position) continue
      const geometry = revert ? move.before : move.geometry
      const transform = position.classList.contains('hcd-slide-group') ? readTransform(position) : undefined
      if (transform?.children) {
        position.style.transform = transformGroup(transform, geometry)
        if (move.before.widthEmu !== move.geometry.widthEmu || move.before.heightEmu !== move.geometry.heightEmu) {
          keepNativeGroupTextSize(position)
        }
        continue
      }
      for (const [property, value] of Object.entries(size(geometry))) {
        position.style.setProperty(property, value + 'px')
      }
    }
  }

  function start(mode: SlideDrag['mode'], event: ReactPointerEvent<HTMLButtonElement>) {
    const width = frame.current?.getBoundingClientRect().width
    if (event.button !== 0 || !width || !slideWidth || !active.length || drag.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, ratio: slideWidth / width,
      mode, objects: active, current: [] }
  }

  function update(event: ReactPointerEvent<HTMLButtonElement>) {
    const work = drag.current
    if (!work || work.pointer !== event.pointerId) return
    const dx = Math.round((event.clientX - work.startX) * work.ratio)
    const dy = Math.round((event.clientY - work.startY) * work.ratio)
    const geometry = work.objects.map(object => object.geometry)
    const x = clamp(dx, -Math.min(...geometry.map(item => item.xEmu)),
      slideWidth - Math.max(...geometry.map(item => item.xEmu + item.widthEmu)))
    const y = clamp(dy, -Math.min(...geometry.map(item => item.yEmu)),
      slideHeight - Math.max(...geometry.map(item => item.yEmu + item.heightEmu)))
    const moves = work.objects.map(({ nodeId, kind, geometry: before }) => {
      if (work.mode === 'move') return { nodeId, before, geometry: { ...before, xEmu: before.xEmu + x, yEmu: before.yEmu + y } }
      const maxWidth = slideWidth - before.xEmu
      const maxHeight = slideHeight - before.yEmu
      const aspect = before.widthEmu / before.heightEmu
      const proportional = kind === 'picture' || kind === 'group'
      const widthLimit = proportional ? Math.min(maxWidth, Math.floor(maxHeight * aspect)) : maxWidth
      const widthEmu = clamp(before.widthEmu + dx, Math.min(emuPerPixel * 12, widthLimit), widthLimit)
      const heightEmu = proportional ? Math.max(1, Math.round(widthEmu / aspect))
        : clamp(before.heightEmu + dy, Math.min(emuPerPixel * 12, maxHeight), maxHeight)
      return { nodeId, before, geometry: { ...before, widthEmu, heightEmu } }
    })
    work.current = moves
    paint(moves)
    setPreview(moves)
  }

  function finish(event: ReactPointerEvent<HTMLButtonElement>, canceled = false) {
    const work = drag.current
    if (!work || work.pointer !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const moves = work.current.filter(move => !sameGeometry(move.before, move.geometry))
    if (canceled || !moves.length) {
      paint(work.current, true)
      setPreview(noMoves)
      return
    }
    const doc = frame.current?.contentDocument
    void commit(moves).then(saved => {
      if (!saved && frame.current?.contentDocument === doc) paint(moves, true)
      setPreview(noMoves)
    })
  }

  const lead = active.at(-1)
  return <>
    {objects.filter(object => objectMode || !object.textIds.length).map(object => (
      <button key={object.nodeId} type="button" className="fixed-page-hitbox pptx-object-hitbox" data-pptx-object={object.nodeId}
        style={{ ...size(boxInSlide(object.geometry, object.rotation)), zIndex: object.order + 1 }} aria-pressed={selected.includes(object.nodeId)}
        aria-label={localizeSource(locale, '选择对象') + ' · ' + localizeSource(locale, object.label)} disabled={disabled}
        onClick={event => pick(object, event.shiftKey || event.metaKey || event.ctrlKey)} />
    ))}
    {active.map(object => <div key={object.nodeId} className="pptx-shape-controls pptx-object-controls" data-selected-object={object.nodeId}
      style={size(boxInSlide(previewById.get(object.nodeId) ?? object.geometry, object.rotation))}>
      {object === lead && <>
        <button type="button" className="pptx-shape-move" disabled={disabled} aria-label={localizeSource(locale, '移动所选对象')}
          onPointerDown={event => start('move', event)} onPointerMove={update} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}><Move size={13} /></button>
        {active.length === 1 && <button type="button" className="pptx-shape-resize" disabled={disabled} aria-label={localizeSource(locale, '调整对象大小')}
          onPointerDown={event => start('resize', event)} onPointerMove={update} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} />}
      </>}
    </div>)}
  </>
}
