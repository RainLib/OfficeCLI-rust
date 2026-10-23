import { api, type Session } from './api.ts'
import { translate, type EditorLocale } from './i18n.tsx'
import type { ImageNode } from './ImagePanel.tsx'
import type { TextRun } from './textDrafts.ts'

export type Manifest = { chunkCount: number; indexPageCount: number; revision: number; source: { format: string } }
export type Descriptor = { sequence: number; region: string; continuation: boolean }
export type PageGroup = { firstSequence: number; region: string; sequences: number[] }
export type PageSize = { width: number; height: number }

export function groupPages(descriptors: Descriptor[]): PageGroup[] {
  const groups: PageGroup[] = []
  for (const chunk of descriptors) {
    const previous = groups[groups.length - 1]
    if (chunk.continuation && previous && previous.region === chunk.region) {
      previous.sequences.push(chunk.sequence)
    } else {
      groups.push({ firstSequence: chunk.sequence, region: chunk.region, sequences: [chunk.sequence] })
    }
  }
  return groups
}

export function cssPixels(value: string): number {
  const match = /^(-?[0-9.]+)(px|pt)$/.exec(value)
  if (!match) return 0
  const amount = Number(match[1]) * (match[2] === 'pt' ? 4 / 3 : 1)
  return Number.isFinite(amount) ? amount : 0
}

export function composePage(chunks: string[], locale: EditorLocale): { html: string; size: PageSize } {
  const parser = new DOMParser()
  const first = parser.parseFromString(chunks[0], 'text/html').body.firstElementChild
  if (!(first instanceof HTMLElement)) throw new Error(translate(locale, 'missingPageRoot'))
  const identity = first.getAttribute('data-hcd-source-part') || first.getAttribute('data-hcd-page')
  for (const chunk of chunks.slice(1)) {
    const next = parser.parseFromString(chunk, 'text/html').body.firstElementChild
    if (!(next instanceof HTMLElement) || next.tagName !== first.tagName ||
        (next.getAttribute('data-hcd-source-part') || next.getAttribute('data-hcd-page')) !== identity) {
      throw new Error(translate(locale, 'wrongPageChunk'))
    }
    for (const child of Array.from(next.childNodes)) first.appendChild(first.ownerDocument.importNode(child, true))
  }
  const width = cssPixels(first.style.width)
  const height = cssPixels(first.style.height)
  if (width <= 0 || height <= 0) throw new Error(translate(locale, 'invalidPageSize'))
  return { html: first.outerHTML, size: { width, height } }
}

export function textRuns(root: HTMLElement): TextRun[] {
  const runs: TextRun[] = []
  const seen = new Set<string>()
  for (const element of root.querySelectorAll('[data-hcd-node-hash]')) {
    if (!(element instanceof HTMLElement)) continue
    const kind = element.getAttribute('data-hcd-node-kind') || ''
    if (kind === 'image' || kind === 'chart' || kind === 'picture' || kind.startsWith('pdf-image')) continue
    if (element.getAttribute('data-hcd-editable') === 'false') continue
    if (element.querySelector('[data-hcd-node-hash]')) continue
    const nodeId = element.getAttribute('data-hcd-id')
    const nodeHash = element.getAttribute('data-hcd-node-hash')
    if (!nodeId || !nodeHash || seen.has(nodeId)) continue
    seen.add(nodeId)
    const inherited = (property: string) => {
      let node: HTMLElement | null = element
      while (node) { const value = node.style.getPropertyValue(property); if (value) return value; if (node === root) break; node = node.parentElement }
      return ''
    }
    const weight = inherited('font-weight')
    runs.push({ nodeId, nodeHash, text: element.textContent ?? '', font: {
      family: inherited('font-family').split(',')[0].replaceAll(/["']/g, '').trim(), sizePt: cssPixels(inherited('font-size')) * 3 / 4,
      bold: weight === 'bold' || Number(weight) >= 600, italic: inherited('font-style') === 'italic',
    } })
  }
  return runs
}

export type SlideObject = { kind: 'text' | 'image'; nodeIds: string[]; label: string; x: number; y: number; width: number; height: number; transform: string }
export type RenderedPage = { html: string; size: PageSize; runs: TextRun[]; nodeIds: string[]; images: ImageNode[]; objects: SlideObject[]; revision: number; approximateText: boolean }

export function fitSlide(size: PageSize, viewport: PageSize, padding = 48): number {
  return Math.max(0.05, Math.min((viewport.width - padding) / size.width, (viewport.height - padding) / size.height, 2))
}

/** Shared by the active canvas and visible thumbnails. Caches are bounded and
 * owned by one workspace; document credentials and assets never enter storage. */
export function createPageLoader(session: Session, locale: EditorLocale) {
  const pages = new Map<string, Promise<RenderedPage>>()
  const assets = new Map<string, Promise<string>>()
  const asset = (hash: string): Promise<string> => {
    const cached = assets.get(hash)
    if (cached) return cached
    const request = api(session, `/assets/${hash}`).then(async response => {
      const blob = await response.blob()
      if (blob.size > 64 * 1024 * 1024) throw new Error(translate(locale, 'assetTooLarge'))
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
    })
    assets.set(hash, request)
    if (assets.size > 32) assets.delete(assets.keys().next().value!)
    void request.catch(() => { if (assets.get(hash) === request) assets.delete(hash) })
    return request
  }
  return (page: PageGroup, revision: number): Promise<RenderedPage> => {
    const key = `${revision}:${page.sequences.join(',')}`
    const cached = pages.get(key)
    if (cached) return cached
    const request = (async () => {
      const chunks = await Promise.all(page.sequences.map(async sequence =>
        (await (await api(session, `/chunks/${sequence}?revision=${revision}`)).json() as { html: string }).html))
      const composed = ['pdf', 'pptx'].includes(session.format) ? composePage(chunks, locale) : { html: `<div class="hcd-flow-chunk">${chunks.join('')}</div>`, size: { width: 794, height: 1123 } }
      const root = new DOMParser().parseFromString(composed.html, 'text/html').body.firstElementChild as HTMLElement
      const runs = textRuns(root)
      const objects: SlideObject[] = []
      for (const shape of root.querySelectorAll<HTMLElement>('[data-hcd-shape-id]')) {
        const ids = new Set(Array.from(shape.querySelectorAll('[data-hcd-node-hash]'), node => node.getAttribute('data-hcd-id')))
        const nodeIds = runs.filter(run => ids.has(run.nodeId)).map(run => run.nodeId)
        if (!nodeIds.length) continue
        objects.push({ kind: 'text', nodeIds, label: shape.getAttribute('data-hcd-shape-name') || '',
          x: cssPixels(shape.style.left), y: cssPixels(shape.style.top), width: cssPixels(shape.style.width), height: cssPixels(shape.style.height), transform: shape.style.transform })
      }
      for (const text of root.querySelectorAll<HTMLElement>('.hcd-pdf-text')) {
        const nodeId = text.getAttribute('data-hcd-text-node')
        if (!nodeId || !runs.some(run => run.nodeId === nodeId && run.text.trim())) continue
        objects.push({ kind: 'text', nodeIds: [nodeId], label: text.textContent?.trim() || '',
          x: cssPixels(text.style.left), y: cssPixels(text.style.top),
          width: Number(text.getAttribute('data-hcd-width') || 0) * 4 / 3,
          height: Number(text.getAttribute('data-hcd-height') || 0) * 4 / 3, transform: text.style.transform })
      }
      const hashes = [...new Set(Array.from(composed.html.matchAll(/asset:\/\/sha256\/([0-9a-f]{64})/g), match => match[1]))]
      const resolved = new Map(await Promise.all(hashes.map(async hash => [hash, await asset(hash)] as const)))
      const images: ImageNode[] = Array.from(root.querySelectorAll<HTMLElement>('[data-hcd-visual-hash][data-hcd-editable="true"]'))
        .filter(node => node.hasAttribute('data-hcd-id') && node.hasAttribute('data-hcd-visual-hash'))
        .map(node => ({ nodeId: node.getAttribute('data-hcd-id')!, visualHash: node.getAttribute('data-hcd-visual-hash')!,
          assetHash: node.getAttribute('data-hcd-asset-hash'), preview: resolved.get(node.getAttribute('data-hcd-asset-hash') || ''),
          label: node.querySelector('img')?.getAttribute('alt') || undefined,
          geometry: ['emu', 'pt'].includes(node.getAttribute('data-hcd-geometry-unit') || '') ? {
            x: Number(node.getAttribute('data-hcd-x')), y: Number(node.getAttribute('data-hcd-y')),
            width: Number(node.getAttribute('data-hcd-width')), height: Number(node.getAttribute('data-hcd-height')),
            unit: node.getAttribute('data-hcd-geometry-unit') as 'emu' | 'pt',
          } : undefined }))
      for (const node of root.querySelectorAll<HTMLElement>('[data-hcd-visual-hash][data-hcd-editable="true"]')) {
        const nodeId = node.getAttribute('data-hcd-id')
        if (!nodeId || !images.some(image => image.nodeId === nodeId)) continue
        objects.push({ kind: 'image', nodeIds: [nodeId], label: node.querySelector('img')?.getAttribute('alt') || '',
          x: cssPixels(node.style.left), y: cssPixels(node.style.top), width: cssPixels(node.style.width),
          height: cssPixels(node.style.height), transform: node.style.transform })
      }
      return { html: composed.html.replace(/asset:\/\/sha256\/([0-9a-f]{64})/g, (_, hash: string) => resolved.get(hash) || ''),
        size: composed.size, runs, objects, images, revision,
        approximateText: session.format === 'pdf' && !!root.querySelector('[data-hcd-patched="true"]'),
        nodeIds: Array.from(root.querySelectorAll('[data-hcd-id]'), node => node.getAttribute('data-hcd-id')!),
      }
    })()
    pages.set(key, request)
    if (pages.size > 16) pages.delete(pages.keys().next().value!)
    void request.catch(() => { if (pages.get(key) === request) pages.delete(key) })
    return request
  }
}

/** Draft preview keeps the original run styling and uses textContent so input
 * cannot inject HTML into the isolated preview document. */
export function pageDocument(page: RenderedPage, stylesheet: string, locale: EditorLocale, edits?: ReadonlyMap<string, string>): string {
  let html = page.html
  if (edits?.size) {
    const root = new DOMParser().parseFromString(html, 'text/html').body
    for (const element of root.querySelectorAll('[data-hcd-node-hash]')) {
      const id = element.getAttribute('data-hcd-id')
      if (id && edits.has(id) && !element.querySelector('[data-hcd-node-hash]')) element.textContent = edits.get(id)!
    }
    html = root.innerHTML
  }
  const css = stylesheet.replace(/<\/style/gi, '<\\/style')
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;padding:0;overflow:hidden}${css}</style></head><body data-hcd-image-hitboxes="off" data-hcd-text-hitboxes="off">${html}</body></html>`
}
