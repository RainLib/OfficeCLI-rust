import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'

export function PdfExportPreview({ sourcePath }: { sourcePath: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [error, setError] = useState('')
  const [rendering, setRendering] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const downloadPath = sourcePath.replace(/\/preview$/, '')

  useEffect(() => {
    let active = true
    let task: ReturnType<typeof import('pdfjs-dist')['getDocument']> | null = null
    void import('pdfjs-dist').then(async pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
      task = pdfjs.getDocument({ url: sourcePath })
      const loaded = await task.promise
      if (active) setDocument(loaded)
    }).catch(cause => { if (active) setError(`无法打开导出 PDF：${String(cause)}`) })
    return () => {
      active = false
      void task?.destroy()
    }
  }, [sourcePath])

  useEffect(() => {
    if (!document) return
    let active = true
    let renderTask: RenderTask | null = null
    setRendering(true)
    void document.getPage(pageNumber).then(page => {
      if (!active || !canvasRef.current) return
      const natural = page.getViewport({ scale: 1 })
      const scale = Math.min(1.5, Math.max(0.5, (window.innerWidth - 96) / natural.width))
      const viewport = page.getViewport({ scale })
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      const canvas = canvasRef.current
      canvas.width = Math.ceil(viewport.width * ratio)
      canvas.height = Math.ceil(viewport.height * ratio)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器无法创建 PDF 画布')
      renderTask = page.render({ canvas, canvasContext: context, viewport: page.getViewport({ scale: scale * ratio }) })
      return renderTask.promise
    }).then(() => { if (active) setRendering(false) })
      .catch(cause => { if (active) setError(`第 ${pageNumber} 页渲染失败：${String(cause)}`) })
    return () => { active = false; renderTask?.cancel() }
  }, [document, pageNumber])

  return <main className="pdf-export-preview">
    <header>
      <div><small>OFFICECLI / HCD</small><h1>导出 PDF 预览</h1><span>显示实际导出的打印版式</span></div>
      <div className="pdf-export-preview-actions">
        <button onClick={() => window.history.back()}>返回工作台</button>
        <button disabled={!document || pageNumber <= 1} onClick={() => setPageNumber(page => page - 1)}>上一页</button>
        <span>{document ? `${pageNumber} / ${document.numPages}` : '加载中…'}</span>
        <button disabled={!document || pageNumber >= document.numPages} onClick={() => setPageNumber(page => page + 1)}>下一页</button>
        <a href={downloadPath} download>下载此 PDF</a>
      </div>
    </header>
    {error && <p role="alert" className="pdf-export-preview-error">{error}</p>}
    <div className="pdf-export-preview-page" aria-busy={rendering}>
      <canvas ref={canvasRef} aria-label={`导出 PDF 第 ${pageNumber} 页`} />
    </div>
  </main>
}
