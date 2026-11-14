import { HcdOpaque, type Projection } from './schema.ts'
import { api, type Session } from './api.ts'
import { loadThemeCss } from './themeCss.ts'

/** Display canonical complex blocks without flattening them into editable text.
 * The iframe has no scripts, network access, forms or navigation controls. */
export function opaquePreviewExtension(session: Session) {
  const resources = new Map<number | null, Promise<{ projection: Projection; styles: string }>>()
  const load = (revision: number | null) => {
    let promise = resources.get(revision)
    if (!promise) {
      const query = revision === null ? '' : `?revision=${revision}`
      promise = Promise.all([
        api(session, `/editor${query}`).then(response => response.json() as Promise<Projection>),
        api(session, `/styles${query}`).then(response => response.text()),
        loadThemeCss(session, revision),
      ]).then(([projection, css, theme]) => ({ projection, styles: `${css}\n${theme}` }))
      resources.set(revision, promise)
      promise.catch(() => resources.delete(revision))
    }
    return promise
  }
  return HcdOpaque.extend({
    addNodeView() {
      return ({ node }) => {
        let disposed = false
        const urls: string[] = []
        let observer: ResizeObserver | undefined
        const dom = document.createElement('div')
        dom.className = 'hcd-opaque hcd-opaque-preview'
        dom.dataset.hcdBlockId = node.attrs.hcdBlockId || ''
        dom.contentEditable = 'false'
        const label = document.createElement('small')
        label.textContent = '复杂内容 · 保留版式（只读）'
        const frame = document.createElement('iframe')
        frame.title = '复杂内容预览'
        frame.setAttribute('sandbox', 'allow-same-origin')
        frame.referrerPolicy = 'no-referrer'
        frame.tabIndex = -1
        frame.inert = true
        frame.style.cssText = 'width:100%;height:100px;border:0;display:block;pointer-events:none;background:white'
        dom.append(label, frame)
        const revision = Number.isSafeInteger(node.attrs.previewRevision) ? node.attrs.previewRevision as number : null
        void load(revision).then(async ({ projection, styles }) => {
          const block = projection.blocks.find(block => block.blockId === node.attrs.hcdBlockId)
          if (!block?.readOnlyHtml) throw new Error('未找到复杂内容预览')
          let html = block.readOnlyHtml
          const hashes = [...new Set([...html.matchAll(/asset:\/\/sha256\/([0-9a-f]{64})/g)].map(match => match[1]))]
          if (hashes.length > 64) throw new Error('复杂内容资产过多，请使用导出预览')
          for (const hash of hashes) {
            const asset = await api(session, `/assets/${hash}${revision === null ? '' : `?revision=${revision}`}`)
            const blob = await asset.blob()
            if (blob.size > 64 * 1024 * 1024) throw new Error('预览图片过大')
            if (disposed) return
            const url = URL.createObjectURL(blob)
            urls.push(url)
            html = html.replaceAll(`asset://sha256/${hash}`, url)
          }
          if (disposed) return
          frame.onload = () => {
            const body = frame.contentDocument?.body
            if (!body || disposed) return
            const measure = () => { frame.style.height = `${Math.min(2400, Math.max(60, body.scrollHeight + 16))}px` }
            observer = new ResizeObserver(measure)
            observer.observe(body)
            measure()
          }
          frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src data: blob:; base-uri 'none'; form-action 'none'"><style>${styles.replace(/<\/style/gi, '<\\/style')}\nbody{margin:0;padding:8px;background:white;overflow-wrap:anywhere}.hcd-editor-block{max-width:100%}</style></head><body>${html}</body></html>`
        }).catch(cause => {
          if (!disposed) { frame.remove(); const fallback = document.createElement('p'); fallback.textContent = `${node.attrs.preview || '复杂内容'}（${String(cause)}）`; dom.append(fallback) }
        })
        return { dom, ignoreMutation: () => true, destroy() { disposed = true; observer?.disconnect(); frame.onload = null; urls.forEach(url => URL.revokeObjectURL(url)) } }
      }
    },
  })
}
