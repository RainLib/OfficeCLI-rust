import type { RenderRequest } from './imageRender.ts'
let cachedSource: Blob | undefined, cachedBitmap: ImageBitmap | undefined
let queue = Promise.resolve()
// Serialize requests so a newer source cannot overtake an earlier export.
self.onmessage = (event: MessageEvent<RenderRequest>) => { queue = queue.then(() => render(event.data)).catch(() => {}) }
async function render(r: RenderRequest) {
  try {
    if (r.source && r.source !== cachedSource) { cachedBitmap?.close(); cachedSource = r.source; cachedBitmap = await createImageBitmap(r.source) }
    if (!cachedBitmap) throw new Error('图片尚未载入')
    const e = r.edits, src = cachedBitmap
    const crop = e.crop || [0, 0, src.width, src.height]
    if (crop.some(n => !Number.isFinite(n)) || crop[2] < 1 || crop[3] < 1 || crop[0] < 0 || crop[1] < 0 || crop[0] + crop[2] > src.width + 0.5 || crop[1] + crop[3] > src.height + 0.5) throw new Error('裁剪范围无效')
    const width = Math.round(e.width), height = Math.round(e.height)
    if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 32_000_000) throw new Error('输出尺寸不得超过 8192 px 或 3200 万像素')
    const scale = r.preview ? Math.min(1, 1600 / Math.max(width, height)) : 1
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale))
    const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d')!
    if (r.format === 'image/jpeg' || r.transparent === false) { ctx.fillStyle = r.background || '#ffffff'; ctx.fillRect(0, 0, w, h) }
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.scale(e.flipX ? -1 : 1, e.flipY ? -1 : 1); ctx.rotate(e.rotation * Math.PI / 180)
    const sideways = Math.abs(e.rotation % 180) === 90
    ctx.drawImage(src, ...crop as [number, number, number, number], -(sideways ? h : w) / 2, -(sideways ? w : h) / 2, sideways ? h : w, sideways ? w : h); ctx.restore()
    if ([e.exposure, e.contrast, e.highlights, e.shadows, e.warmth, e.saturation].some(Boolean)) {
      const pixels = ctx.getImageData(0, 0, w, h), data = pixels.data
      const exposure = 2 ** (e.exposure / 50), contrast = (1 + e.contrast / 100) ** 2, saturation = 1 + e.saturation / 100
      for (let i = 0; i < data.length; i += 4) {
        const luma = (data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722) / 255
        const tone = e.shadows * (1 - luma) ** 2 * .65 + e.highlights * luma ** 2 * .65
        for (let c = 0; c < 3; c++) { const value = (data[i + c] * exposure + tone - 127.5) * contrast + 127.5; data[i + c] = luma * 255 + (value - luma * 255) * saturation + (c === 0 ? e.warmth * .45 : c === 2 ? -e.warmth * .45 : 0) }
      }
      ctx.putImageData(pixels, 0, 0)
    }
    const format = r.format || 'image/png', blob = await canvas.convertToBlob({ type: format, quality: (r.quality ?? 90) / 100 })
    if (blob.type !== format) throw new Error('当前浏览器没有此格式编码器')
    self.postMessage({ id: r.id, blob })
  } catch (e) { self.postMessage({ id: r.id, error: String(e) }) }
}
