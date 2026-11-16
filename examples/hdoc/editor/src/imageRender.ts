export type ImageEdits = { crop: [number, number, number, number] | null; rotation: number; flipX: boolean; flipY: boolean; width: number; height: number; exposure: number; contrast: number; highlights: number; shadows: number; warmth: number; saturation: number }
export const blankEdits = (width: number, height: number): ImageEdits => ({ crop: null, rotation: 0, flipX: false, flipY: false, width, height, exposure: 0, contrast: 0, highlights: 0, shadows: 0, warmth: 0, saturation: 0 })
export type RenderRequest = { id: number; source?: Blob; edits: ImageEdits; preview?: boolean; format?: string; quality?: number; background?: string; transparent?: boolean }
export class ImageRenderer {
  private worker = new Worker(new URL('./imageRender.worker.ts', import.meta.url), { type: 'module' })
  private source?: Blob
  private next = 0
  private pending = new Map<number, { resolve: (v: Blob) => void; reject: (e: Error) => void }>()
  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
      const request = this.pending.get(data.id); this.pending.delete(data.id)
      if (data.blob) request?.resolve(data.blob); else request?.reject(new Error(data.error || '图片处理失败'))
    }
    this.worker.onerror = () => { for (const p of this.pending.values()) p.reject(new Error('图片处理线程异常')); this.pending.clear() }
  }
  render(request: Omit<RenderRequest, 'id'>) {
    const id = ++this.next
    return new Promise<Blob>((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ ...request, source: request.source === this.source ? undefined : request.source, id }); if (request.source) this.source = request.source })
  }
  close() { this.worker.terminate(); for (const p of this.pending.values()) p.reject(new Error('图片工作区已关闭')); this.pending.clear() }
}
export async function base64Blob(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()); let data = ''
  for (let i = 0; i < bytes.length; i += 16384) data += String.fromCharCode(...bytes.subarray(i, i + 16384))
  return btoa(data)
}
export function downloadImage(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
export const imageFileSize = (n: number) => n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
