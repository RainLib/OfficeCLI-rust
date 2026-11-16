import { HcdOpaque } from './schema.ts'
import { api, type Session } from './api.ts'
import { createSemanticResources, type SemanticResources } from './semanticResources.ts'
import { localizeSource } from './sourceLocale.tsx'
import type { EditorLocale } from './i18n.tsx'
import { applyWordGrid } from '../../../../crates/hcd-core/src/docx_layout.js'
import { inlineTableEditing } from './inlineTableEditing.ts'
import { tableStructureControls } from './tableStructureControls.ts'
import { patchPreviewDom } from './patchPreviewDom.ts'

/** Display canonical complex blocks without flattening them into editable text.
 * The iframe has no scripts, network access, forms or navigation controls. */
export function opaquePreviewExtension(session: Session, locale: EditorLocale = 'zh-CN', resources: SemanticResources = createSemanticResources(()=>session)) {
  return HcdOpaque.extend({
    addNodeView() {
      return ({ node: initialNode, editor, getPos }) => {
        let node = initialNode
        let disposed = false
        const urls: string[] = []
        let observer: ResizeObserver | undefined
        let table: ReturnType<typeof inlineTableEditing> | undefined
        const dom = document.createElement('div')
        dom.className = 'hcd-opaque hcd-opaque-preview'
        dom.dataset.hcdBlockId = node.attrs.hcdBlockId || ''
        dom.contentEditable = 'false'
        dom.setAttribute('aria-busy', 'true')
        const frame = document.createElement('iframe')
        frame.title = '复杂内容预览'
        frame.setAttribute('sandbox', 'allow-same-origin')
        frame.referrerPolicy = 'no-referrer'
        frame.tabIndex = -1
        frame.inert = true
        frame.style.cssText = 'width:100%;height:1px;border:0;display:block;pointer-events:none;background:transparent'
        dom.append(frame)
        let controls: ReturnType<typeof tableStructureControls> | undefined
        let ready = false, generation = 0
        let installed: { hash: string; styles: string } | undefined
        const assets = new Map<string, Promise<string>>()
        const refresh = async () => {
          const ticket = ++generation
          const revision = Number.isSafeInteger(node.attrs.previewRevision) ? node.attrs.previewRevision as number : null
          try {
            const { projection, styles } = await resources.load(revision)
            if (disposed || ticket !== generation) return
            const block = projection.blocks.find(block => block.blockId === node.attrs.hcdBlockId)
            if (!block?.readOnlyHtml) throw new Error('未找到复杂内容预览')
            if (installed?.hash === block.blockHash && installed.styles === styles) {
              table?.sync(); dom.setAttribute('aria-busy', 'false'); return
            }
            let html = block.readOnlyHtml
            const hashes = [...new Set([...html.matchAll(/asset:\/\/sha256\/([0-9a-f]{64})/g)].map(match => match[1]))]
            if (hashes.length > 64) throw new Error('复杂内容资产过多，请使用导出预览')
            const resolved = await Promise.all(hashes.map(hash => {
              let asset = assets.get(hash)
              if (!asset) {
                asset = api(session, `/assets/${hash}${revision === null ? '' : `?revision=${revision}`}`).then(response => response.blob()).then(blob => {
                  if (blob.size > 64 * 1024 * 1024) throw new Error('预览图片过大')
                  if (disposed) return ''
                  const url = URL.createObjectURL(blob); urls.push(url); return url
                })
                assets.set(hash, asset); asset.catch(() => assets.delete(hash))
              }
              return asset.then(url => [hash, url] as const)
            }))
            if (disposed || ticket !== generation || !ready) return
            for (const [hash, url] of resolved) html = html.replaceAll(`asset://sha256/${hash}`, url)
            const doc = frame.contentDocument!, content = doc.querySelector<HTMLElement>('.hcd-opaque-content')!
            table?.destroy(); controls?.destroy(); table = undefined; controls = undefined
            const desired = doc.createElement('section'); desired.className = content.className; desired.innerHTML = html
            patchPreviewDom(content, desired)
            const sheet = doc.querySelector('#canonical-styles')!
            if (sheet.textContent !== styles) sheet.textContent = styles
            const hasTable = !!content.querySelector('table')
            frame.title = localizeSource(locale, hasTable ? '文档表格' : '复杂内容预览')
            frame.inert = !hasTable; frame.style.pointerEvents = hasTable ? 'auto' : 'none'
            if (block.editableTextNodeIds?.length) table = inlineTableEditing({ editor, getNode: () => node, getPos, doc,
              editableIds: block.editableTextNodeIds,
              label: (cell, paragraph) => `${localizeSource(locale, '单元格')} ${cell} · ${localizeSource(locale, '段落')} ${paragraph}`,
            })
            if (hasTable) controls = tableStructureControls({ editor, doc, frame, host: dom, blockId: block.blockId,
              onFocus: () => editor.view.dom.dispatchEvent(new CustomEvent('hcd-inline-table-focus', { detail: { blockId: block.blockId } })),
              label: text => localizeSource(locale, text),
            })
            if (session.format === 'docx') applyWordGrid(doc)
            measure(); dom.setAttribute('aria-busy', 'false')
            installed = { hash: block.blockHash, styles }
            void doc.fonts.ready.then(() => { if (disposed || ticket !== generation) return; if (session.format === 'docx') applyWordGrid(doc); measure() })
            dom.querySelector('[role="alert"]')?.remove()
          } catch (cause) {
            if (disposed || ticket !== generation) return
            dom.setAttribute('aria-busy', 'false')
            let fallback = dom.querySelector<HTMLElement>('[role="alert"]')
            if (!fallback) { fallback = document.createElement('p'); fallback.setAttribute('role', 'alert'); dom.append(fallback) }
            fallback.textContent = `${node.attrs.preview || '复杂内容'}（${String(cause)}）`
          }
        }
        const measure = () => {
          const content = frame.contentDocument?.querySelector('.hcd-opaque-content')
          if (!content || disposed) return
          const height = `${Math.max(1, Math.ceil(content.getBoundingClientRect().height))}px`
          if (frame.style.height !== height) frame.style.height = height
        }
        frame.onload = () => {
          if (disposed) return
          const doc = frame.contentDocument!, content = doc.querySelector('.hcd-opaque-content')
          if (!content) return
          doc.body.dataset.hcdSourceFormat = session.format; doc.body.dataset.hcdProfile = 'semantic-flow'
          doc.body.dataset.hcdTextHitboxes = 'off'; doc.body.dataset.hcdImageHitboxes = 'off'
          ready = true
          observer = new ResizeObserver(measure); observer.observe(content)
          void refresh()
          void doc.fonts.ready.then(measure)
        }
        const typography = session.format === 'docx' ? 'font:12pt "Times New Roman",serif;line-height:normal' : 'font:16px/1.6 HCDSans,HCDEmoji,HCDFallback,"Noto Sans SC","PingFang SC","Microsoft YaHei",Arial,sans-serif'
        const embeddedPage = 'margin:0!important;padding:0!important;width:100%!important;min-width:0!important;max-width:none!important;height:auto!important;min-height:0!important;background:transparent!important;box-shadow:none!important'
        frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src data: blob:; base-uri 'none'; form-action 'none'"><style>body{${typography}}html{margin:0;padding:0;background:transparent}.hcd-opaque-content{display:flow-root;content-visibility:visible;contain:none}</style><style id="canonical-styles"></style><style>.hcd-opaque-content{display:flow-root!important;content-visibility:visible!important;contain:none!important}</style></head><body style="${embeddedPage}"><section class="hcd-chunk hcd-opaque-content"></section></body></html>`
        return { dom, ignoreMutation: () => true,
          stopEvent: event => event.target === frame || event.target instanceof Node && !!dom.querySelector('[data-hcd-table-controls]')?.contains(event.target),
          update(next) {
            if (next.type !== node.type || next.attrs.hcdBlockId !== node.attrs.hcdBlockId) return false
            // Keep the iframe and reconcile canonical nodes on structural changes.
            const ids = (value: typeof node) => Array.from({ length: value.childCount }, (_, index) => value.child(index).attrs.nodeId).join(',')
            const changed = ids(next) !== ids(node) || next.attrs.previewRevision !== node.attrs.previewRevision
            node = next
            if (changed && ready) void refresh()
            else table?.sync()
            return true
          },
          destroy() { disposed = true; generation++; table?.destroy(); controls?.destroy(); observer?.disconnect(); frame.onload = null; urls.forEach(url => URL.revokeObjectURL(url)) },
        }
      }
    },
  })
}
