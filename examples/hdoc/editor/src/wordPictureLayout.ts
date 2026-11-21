export type WordPictureWrap = 'inline' | 'square' | 'topAndBottom' | 'behind' | 'inFront'
export type WordPictureAlignment = 'left' | 'center' | 'right'
export type WordPictureWrapSide = 'bothSides' | 'left' | 'right' | 'largest'

export type WordPictureLayout = {
  wrap: WordPictureWrap
  horizontalAlignment?: WordPictureAlignment
  horizontalOffsetEmu?: number
  verticalOffsetEmu?: number
  textDistanceEmu?: number
  wrapSide?: WordPictureWrapSide
}

export type WordPictureTarget = {
  nodeId: string
  visualHash: string
  alt: string
  source: string
  currentWrap?: WordPictureWrap
  savedLayout?: WordPictureLayout
}

export const WORD_PICTURE_SELECTOR = 'img[data-hcd-source-part="word/document.xml"][data-hcd-drawing-id][data-hcd-visual-hash]'

export function wordPictureTarget(image: HTMLImageElement): WordPictureTarget | null {
  const { hcdId, hcdVisualHash, hcdDrawingId, hcdDrawingLayout, hcdWrap, hcdBehindDocument, hcdDocxPictureLayout } = image.dataset
  const source = image.getAttribute('src') || ''
  if (!hcdId || !hcdVisualHash || !hcdDrawingId || !hcdDrawingLayout || !/^(blob:|data:image\/)/.test(source)) return null
  const currentWrap = hcdDrawingLayout === 'inline' ? 'inline' : hcdWrap === 'square' ? 'square' :
    hcdWrap === 'top-and-bottom' ? 'topAndBottom' : hcdWrap === 'none' ? hcdBehindDocument === 'true' ? 'behind' : 'inFront' : undefined
  let savedLayout: WordPictureLayout | undefined
  if (hcdDocxPictureLayout) {
    try { savedLayout = JSON.parse(hcdDocxPictureLayout) as WordPictureLayout }
    catch { return null }
  }
  return { nodeId: hcdId, visualHash: hcdVisualHash, currentWrap, savedLayout, alt: image.alt, source }
}
