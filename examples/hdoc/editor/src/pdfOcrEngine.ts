import type { Worker } from 'tesseract.js'
import { api, type Session } from './api'

export type PdfOcrPage = { page: number; sequence: number; recognized: boolean; hasSourceText: boolean }
export type PdfOcrLine = {
  text: string
  bounds: { left: number; top: number; right: number; bottom: number }
  confidence: number
}

export async function getRecognitionImage(session: Session, page: PdfOcrPage, signal: AbortSignal) {
  try {
    return await (await api(session, '/pdf-render/' + page.page + '?dpi=288', { signal })).blob()
  } catch {
    signal.throwIfAborted()
    // Source-free HCD bundles still have their canonical raster preview.
    const { html } = await (await api(session, '/chunks/' + page.sequence, { signal })).json() as { html: string }
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const source = doc.querySelector('img.hcd-pdf-page-raster')?.getAttribute('src')
    const hash = source?.match(/^asset:\/\/sha256\/([0-9a-f]{64})$/)?.[1]
    if (!hash) throw new Error('本页缺少可用于识别的扫描图像。')
    return (await api(session, '/assets/' + hash, { signal })).blob()
  }
}

const assetFolder = 'pdf-ocr-assets/'

export async function startPdfOcr(language: string, signal: AbortSignal, progress: (value: number) => void) {
  const { createWorker, OEM, PSM } = await import('tesseract.js')
  signal.throwIfAborted()
  const assets = new URL(assetFolder, import.meta.url)
  let fail: ((reason?: unknown) => void) | undefined
  const interrupted = new Promise<never>((_, reject) => { fail = reject })
  let stopped = false
  let worker: Worker | undefined
  const abort = () => {
    stopped = true
    fail?.(signal.reason)
    void worker?.terminate().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  const timer = window.setTimeout(() => fail?.(new Error('识别引擎加载超时，请重试。')), 40_000)
  try {
    const pending = createWorker(language, OEM.LSTM_ONLY, {
      workerPath: new URL('worker.min.js', assets).href,
      corePath: assets.href,
      langPath: assets.href.replace(/\/$/, ''),
      workerBlobURL: false,
      cacheMethod: 'none',
      errorHandler: error => fail?.(error),
      logger: status => {
        if (status.status === 'recognizing text' && !stopped) progress(status.progress)
      },
    }).then(async initialized => {
      if (stopped) await initialized.terminate()
      return initialized
    })
    worker = await Promise.race([pending, interrupted])
    await Promise.race([worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO }), interrupted])
  } catch (error) {
    stopped = true
    signal.removeEventListener('abort', abort)
    await worker?.terminate().catch(() => undefined)
    throw error
  } finally {
    window.clearTimeout(timer)
  }
  const engine = worker
  return {
    async lines(blob: Blob): Promise<PdfOcrLine[]> {
      signal.throwIfAborted()
      const image = await createImageBitmap(blob)
      const { width, height } = image
      image.close()
      const { data } = await Promise.race([
        engine.recognize(blob, {}, { blocks: true, text: false }),
        interrupted,
      ])
      const clamp = (value: number) => Math.max(0, Math.min(1, value))
      return (data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines)).flatMap(line => {
        const text = line.text.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/g, ' ')
          .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, '$1').trim()
        const left = clamp(line.bbox.x0 / width), right = clamp(line.bbox.x1 / width)
        const top = clamp(line.bbox.y0 / height), bottom = clamp(line.bbox.y1 / height)
        if (!text || [...text].length > 1024 || !(right - left >= .00001 && bottom - top >= .00001)) return []
        return [{
          text, bounds: { left, top, right, bottom },
          confidence: Math.round(clamp(line.confidence / 100 || 0) * 100),
        }]
      })
    },
    async close() {
      stopped = true
      signal.removeEventListener('abort', abort)
      if (!signal.aborted) await engine.terminate().catch(() => undefined)
    },
  }
}
