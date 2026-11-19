import type { CanvasScene, ReactionKind } from './model'
import { emojiFor } from './emojiCatalog'

const source = import.meta.glob(['./stamp-art/*.svg', '!./stamp-art/tool-*.svg'], {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>
export function stampSvg(kind: ReactionKind, person = '') {
  if (kind !== 'profile') return source['./stamp-art/' + kind + '.svg']
  const initial = Array.from(person.trim())[0]
  const safe = initial ? '&#' + initial.codePointAt(0) + ';' : ''
  const portrait = safe
    ? '<text x="32" y="42" text-anchor="middle" font-family="system-ui,sans-serif" font-size="29" font-weight="650" fill="#4f4766">' +
      safe +
      '</text>'
    : '<g fill="#726982"><circle cx="32" cy="25" r="8"/><path d="M17 46q3-15 15-15t15 15z"/></g>'
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="33" r="25" fill="#ded6ee" stroke="#fff" stroke-width="4"/>' +
    portrait +
    '</svg>'
  )
}
// Stock stamps have semantic IDs. Use their current artwork even on boards saved with the old PNG.
const okayPreview = 'data:image/svg+xml;base64,' + btoa(stampSvg('okay'))
export function displayedStampFiles(scene: CanvasScene): CanvasScene['files'] {
  const stock = new Set<string>(),
    sharedWithUploads = new Set<string>()
  for (const el of scene.elements) {
    if (el.type !== 'image' || typeof el.fileId !== 'string' || el.isDeleted) continue
    const data = el.customData as { officeStamp?: { kind?: string } } | undefined
    if (data?.officeStamp?.kind === 'okay') stock.add(el.fileId)
    else sharedWithUploads.add(el.fileId)
  }
  let files = scene.files
  for (const id of stock) {
    if (!files[id] || sharedWithUploads.has(id) || files[id].dataURL === okayPreview) continue
    if (files === scene.files) files = { ...files }
    files[id] = { ...files[id], mimeType: 'image/svg+xml', dataURL: okayPreview }
  }
  return files
}
async function decodeStampImage(src: string) {
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('印章图片加载失败。'))
    image.src = src
  })
  await image.decode()
  return image
}

// Each native editor has a separate image cache. Register transparent stamp
// elements first so Excalidraw can start its own image load before this fence.
export type StampPaintCache = Map<string, 'pending' | 'ready' | 'failed'>
export function prepareStampPaint(
  scene: CanvasScene,
  files: CanvasScene['files'],
  cache: StampPaintCache,
  repaint: () => void,
) {
  for (const el of scene.elements) {
    if (
      el.type !== 'image' ||
      el.isDeleted ||
      !(el.customData as { officeStamp?: unknown } | undefined)?.officeStamp ||
      typeof el.fileId !== 'string' ||
      !files[el.fileId] ||
      cache.has(el.fileId)
    )
      continue
    const id = el.fileId
    cache.set(id, 'pending')
    void decodeStampImage(files[id].dataURL).then(
      () => {
        // The native load handler for the same source is already queued. Reveal
        // on the following paint, after the renderer has populated its image cache.
        requestAnimationFrame(() => {
          cache.set(id, 'ready')
          repaint()
        })
      },
      () => cache.set(id, 'failed'),
    )
  }
}

const rasters = new Map<string, Promise<HTMLImageElement>>()
export async function stampPng(kind: ReactionKind, person = '') {
  const key = kind === 'profile' ? kind + person : kind
  const cached = rasters.get(key)
  if (cached) return (await cached).src
  const task = (async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const ctx = canvas.getContext('2d')
    if (!ctx) throw Error('无法渲染印章。')
    const emoji = emojiFor(kind)
    if (emoji) {
      ctx.font = '192px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(emoji.glyph, 128, 138, 238)
    } else {
      const url = URL.createObjectURL(new Blob([stampSvg(kind, person)], { type: 'image/svg+xml' }))
      try {
        const img = new Image()
        img.src = url
        await img.decode()
        ctx.drawImage(img, 0, 0, 256, 256)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    return decodeStampImage(canvas.toDataURL('image/png'))
  })().catch((error) => {
    rasters.delete(key)
    throw error
  })
  if (rasters.size >= 64) rasters.delete(rasters.keys().next().value!)
  rasters.set(key, task)
  return (await task).src
}
