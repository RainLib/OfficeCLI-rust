import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { PaintMask,usePaintStack } from './paintStack'
import { useMemo, type CSSProperties } from 'react'
import type { ArtBrush, CanvasElement, StickerMotif, StickerMotion } from './model.ts'
import originals from '../../../../../crates/canvas-core/assets/stickers.json'
import fluentStickers from '../../../../../crates/canvas-core/assets/fluent-stickers.json'
import fluentDetails from '../../../../../crates/canvas-core/assets/fluent-materials.json'
import brushes from '../../../../../crates/canvas-core/assets/brushes.json'
import './journal.css'

const catalog = {...originals,...fluentStickers}
const packMotions=new Map(fluentDetails.map(item=>[item.id,item.motion]))
type StickerMeta = { version: number; motif: StickerMotif; motion: StickerMotion; palette: string }
const naturalMotion = {
  petals: 'drift', butterfly: 'flutter', paperPlane: 'flight', flower: 'float', mascot: 'companion-idle',
  moonPal: 'blink', starPal: 'gleam', firefly: 'glow', peelDot:'wiggle',
  spark: 'twinkle', leaf: 'float', heart: 'twinkle', tape: 'wiggle', book: 'float',
} as const satisfies Record<keyof typeof originals, string>
export const resolveMotion = (motif: StickerMotif, motion: StickerMotion) => motion === 'auto' ? (naturalMotion[motif as keyof typeof originals] || packMotions.get(motif) || 'float') : motion
export const isStickerMotif = (id: string): id is StickerMotif => Object.hasOwn(catalog, id)
const paint = (value: unknown) => typeof value === 'string' && /^(#[\da-f]{3,8}|[a-z]{1,20}|rgba?\([\d.% ,/]+\)|hsla?\([\d.% ,/]+\))$/i.test(value) ? value : 'none'
export function stickerMeta(element: CanvasElement): StickerMeta | null {
  const meta = (element.customData as { officeSticker?: StickerMeta } | undefined)?.officeSticker
  return !element.isDeleted && meta?.version === 1 && Object.hasOwn(catalog, meta.motif) && ['none', 'float', 'wiggle', 'twinkle', 'auto'].includes(meta.motion) ? meta : null
}
function partMeta(element: CanvasElement) { return (element.customData as { officeStickerPart?: { anchor?: string; layer?: string } } | undefined)?.officeStickerPart }
export function selectedStickerId(elements: readonly CanvasElement[], ids?: readonly string[]) {
  if (!ids?.length) return null
  const selected = new Set(ids)
  const owners = new Set(elements.filter(e => !e.isDeleted && selected.has(e.id)).map(e => stickerMeta(e) ? e.id : partMeta(e)?.anchor))
  if (owners.size !== 1) return null
  const [id] = owners
  return id && elements.some(e => e.id === id && stickerMeta(e)) ? id : null
}
export function stickerParts(elements: readonly CanvasElement[], id: string) {
  return elements.filter(e => !e.isDeleted && partMeta(e)?.anchor === id)
}
function animatedStickers(elements: readonly CanvasElement[]) {
  const parts = new Map<string, CanvasElement[]>()
  for (const element of elements) {
    const anchor = partMeta(element)?.anchor
    if (!anchor || element.isDeleted) continue
    const list = parts.get(anchor)
    if (list) list.push(element)
    else parts.set(anchor, [element])
  }
  const stickers = new Map<string, { anchor: CanvasElement; meta: StickerMeta; parts: CanvasElement[] }>()
  let budget = 512
  for (const anchor of elements) {
    const meta = stickerMeta(anchor), shapes = parts.get(anchor.id)
    if (!meta || meta.motion === 'none' || !shapes?.length || shapes.length + 1 > budget) continue
    // Both the native renderer and the overlay must agree on entire stickers.
    stickers.set(anchor.id, { anchor, meta, parts: shapes })
    budget -= shapes.length + 1
    if (stickers.size === 32) break
  }
  return stickers
}
/** Only the native visual is suppressed. Objects, hit targets, selection,
 * grouping, coordinates and export data remain native Excalidraw records. */
export function motionElements(elements: readonly CanvasElement[]) {
  const animated = animatedStickers(elements)
  return elements.map(e => animated.has(partMeta(e)?.anchor || '') && !e.isDeleted ? { ...e, opacity: 0 } : e)
}
export function stickerElements(elements: readonly CanvasElement[], canonical?: readonly CanvasElement[]): CanvasElement[] {
  const stickers = animatedStickers(elements)
  if (!stickers.size) return []
  const raw = canonical && new Map(canonical.map(e => [e.id, e.opacity]))
  return elements.filter(e => !e.isDeleted && (stickers.has(e.id) || stickers.has(partMeta(e)?.anchor || ''))).map(e => {
    const copy = structuredClone(e)
    if (raw?.has(e.id) && copy.opacity === 0 && partMeta(copy)) copy.opacity = raw.get(e.id) ?? 100
    return copy
  })
}

export function NativeSticker({ element, origin }: { element: CanvasElement; origin: { x: number; y: number } }) {
  const e = element, x = e.x - origin.x, y = e.y - origin.y
  const width = Number(e.strokeWidth || 0)
  const common = { fill: paint(e.backgroundColor), stroke: paint(e.strokeColor), strokeWidth: width,
    opacity: typeof e.opacity === 'number' ? e.opacity / 100 : 1,
    strokeDasharray: e.strokeStyle === 'dashed' ? `${width * 2.6} ${width * 2.8}` : e.strokeStyle === 'dotted' ? `0.1 ${width * 2}` : undefined,
    strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const,
    style: e.angle ? { transformBox: 'fill-box' as const, transformOrigin: 'center', transform: `rotate(${Number(e.angle)}rad)` } : undefined }
  if (e.type === 'ellipse') return <ellipse cx={x + e.width / 2} cy={y + e.height / 2} rx={Math.abs(e.width / 2)} ry={Math.abs(e.height / 2)} {...common} />
  if (e.type === 'rectangle') return <rect x={x} y={y} width={e.width} height={e.height} rx={8} {...common} />
  if (e.type === 'line' && Array.isArray(e.points)) return <polyline points={(e.points as number[][]).map(p => `${x + p[0]},${y + p[1]}`).join(' ')} {...common} />
  return null
}

export function StickerArtwork({ parts, origin }: { parts: CanvasElement[]; origin: { x: number; y: number } }) {
  // Keep the native paint order. Contiguous pieces of a wing share one hinge.
  const layers: { name?: string; parts: CanvasElement[] }[] = []
  for (const part of parts) {
    const name = partMeta(part)?.layer, previous = layers.at(-1)
    if (previous && previous.name === name) previous.parts.push(part)
    else layers.push({ name, parts: [part] })
  }
  return <g className="canvas-sticker-motion">{layers.map(layer =>
    <g key={layer.parts[0].id} data-sticker-layer={layer.name}>{layer.parts.map(part =>
      <NativeSticker key={part.id} element={part} origin={origin} />)}</g>)}</g>
}

export function CanvasStickers({ elements, camera, paused,editor }: {editor:ExcalidrawImperativeAPI|null; elements: CanvasElement[]; camera: { x: number; y: number; zoom: number }; paused: boolean }) {
  const stack=usePaintStack(elements.length?editor:null)
  const stickers = useMemo(() => [...animatedStickers(elements).values()].map(({ anchor, meta, parts }) => ({
    anchor, meta, artwork: <StickerArtwork parts={parts} origin={anchor} />,
  })), [elements])
  return <div className="canvas-stickers" data-paused={paused} aria-hidden="true">{stickers.map(({ anchor, meta, artwork }) => {
    const style = { left: (anchor.x + camera.x) * camera.zoom, top: (anchor.y + camera.y) * camera.zoom, width: anchor.width * camera.zoom, height: anchor.height * camera.zoom, '--sticker-phase': `${-Number(anchor.seed || 1) % 7}s` } as CSSProperties
    return <PaintMask key={anchor.id} scene={stack} api={editor} id={anchor.id} x={anchor.x} y={anchor.y} width={anchor.width} height={anchor.height} scale={camera.zoom}>{maskImage=><div className="canvas-sticker" data-motion={resolveMotion(meta.motif, meta.motion)} data-motif={meta.motif} style={{...style,maskImage}}><svg viewBox={`0 0 ${anchor.width} ${anchor.height}`} overflow="visible">{artwork}</svg></div>}</PaintMask>
  })}</div>
}

// Apricot preview of the same editable marks and shapes used in a composition.
const colors: Record<string, string> = { '$accent': '#D48260', '$paper': '#FFFCF4', '$ink': '#484439', '$pink': '#E9A2A6', '$yellow': '#F3CE76', '$green': '#99B79C', '$blue': '#A8C6D5' }
export function BrushSwatch({ brush }: { brush: ArtBrush | 'ink' | 'pencil' | 'marker' }) {
  if (brush === 'ink' || brush === 'pencil' || brush === 'marker') {
    return <svg className="brush-swatch" viewBox="0 0 106 22" aria-hidden="true"><path d="M5 16 Q31 8 54 10 T100 6" fill="none" stroke={brush === 'marker' ? '#E3AE6F' : '#665A4D'} strokeLinecap="round" strokeWidth={brush === 'marker' ? 10 : brush === 'ink' ? 2.7 : 1.3} opacity={brush === 'marker' ? .66 : .9} /></svg>
  }
  return <svg className="brush-swatch" viewBox="-3 -1 106 20" preserveAspectRatio="none" aria-hidden="true">{brushes[brush].marks.map((mark, i) =>
    <polyline key={i} points={mark.points.map(point => point.join(',')).join(' ')} opacity={mark.opacity / 100}
      fill={'fill' in mark && mark.fill ? colors[mark.fill] : 'none'} stroke={'stroke' in mark && mark.stroke ? colors[mark.stroke] : 'none'}
      strokeWidth={'strokeWidth' in mark ? mark.strokeWidth : 0} strokeLinecap="round" strokeLinejoin="round" />)}</svg>
}
export function StickerIllustration({ motif = 'flower', motion = 'none' }: { motif?: StickerMotif; motion?: StickerMotion }) {
  const parts = catalog[motif].map((p, i) => ({ ...p, id: String(i), backgroundColor: colors[p.fill] || p.fill,
    strokeColor: colors[p.stroke] || p.stroke, customData: { officeStickerPart: { layer: 'layer' in p ? p.layer : undefined } },
  } as CanvasElement))
  return <svg viewBox="0 0 64 64" data-motion={resolveMotion(motif, motion)} aria-hidden="true"><StickerArtwork parts={parts} origin={{ x: 0, y: 0 }} /></svg>
}
