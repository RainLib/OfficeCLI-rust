import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { selectedRegion } from './changes.ts'
import { resolveMotion, StickerArtwork, stickerMeta, stickerParts } from './CanvasStickers.tsx'
import fluent from '../../../../../crates/canvas-core/assets/fluent-materials.json'
import type { CanvasElement } from './model.ts'
import motionCss from './sticker-motion.css?inline'

const names = {
  petals: '春樱花瓣', butterfly: '折纸蝶', paperPlane: '纸飞机', mascot: 'AI 搭子', flower: '小花',
  spark: '星芒', leaf: '绿叶', heart: '爱心', tape: '胶带', book: '书本',
  peelDot:'折角圆贴', firefly: '萤火微光', moonPal: '月牙团子', starPal: '星点伙伴',
}
const exportNames=new Map([...Object.entries(names),...fluent.map(row=>[row.id,row.name] as const)])

export function exportSticker(elements: readonly CanvasElement[], id: string) {
  const anchor = elements.find(e => e.id === id)
  const meta = anchor && stickerMeta(anchor), parts = stickerParts(elements, id)
  if (!anchor || !meta || !parts.length) throw new Error('贴纸已更改，请重新选中后导出。')
  const shapes = [anchor, ...parts]
  const { region } = selectedRegion(shapes, shapes.map(e => e.id))!
  const pad = Math.max(6, Math.max(anchor.width, anchor.height) * .12, ...parts.map(part => Number(part.strokeWidth || 0)))
  const width = region.width + 2 * pad, height = region.height + 2 * pad
  const viewBox = [region.x - anchor.x - pad, region.y - anchor.y - pad, width, height].join(' ')
  const name = exportNames.get(meta.motif) || meta.motif
  const container = document.createElement('div'), root = createRoot(container)
  try {
    // Serialize the same SVG tree the editor paints, including hand edits.
    // A nested viewport keeps wing hinges aligned even when the bounds grow.
    flushSync(() => root.render(<svg xmlns="http://www.w3.org/2000/svg" viewBox={viewBox} width={width} height={height} role="img" aria-label={name}>
      <title>{name}</title><style>{motionCss}</style>
      <svg width={anchor.width} height={anchor.height} viewBox={`0 0 ${anchor.width} ${anchor.height}`} overflow="visible" data-motion={resolveMotion(meta.motif, meta.motion)}>
        <StickerArtwork parts={parts} origin={anchor} />
      </svg>
    </svg>))
    const xml = new XMLSerializer().serializeToString(container.firstElementChild!)
    return { blob: new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }), name: `${name}.svg` }
  } finally { root.unmount() }
}
