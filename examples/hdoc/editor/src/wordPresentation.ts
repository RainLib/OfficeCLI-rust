import { applyWordGrid } from '../../../../crates/hcd-core/src/docx_layout.js'
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PmNode } from '@tiptap/pm/model'
import { api, type Session } from './api.ts'
import type { Projection } from './schema.ts'
import { loadThemeCss } from './themeCss.ts'

type RunStyle = { from: number; to: number; style: string }
type ParagraphStyle = { style: string; text: string; runs: RunStyle[] }
type ParagraphStyles = Map<string, ParagraphStyle>
type Presentation = { paragraphs: ParagraphStyles; page: Record<string, string> }
type State = { styles: ParagraphStyles; page: Record<string, string>; decorations: DecorationSet }
const key = new PluginKey<State>('wordPresentation')
const typography = ['font-family', 'font-size', 'color', 'line-height', 'letter-spacing', 'direction']
const paragraphProperties = [...typography, 'font-weight', 'font-style', 'text-align', 'text-indent', 'white-space', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'min-height', 'break-before', 'break-after']
const runProperties = [...typography, 'background-color', 'vertical-align', 'text-decoration-line']

function declarations(element: Element, properties: string[]): string {
  const computed = element.ownerDocument.defaultView!.getComputedStyle(element)
  return properties.map(property => `${property}:${computed.getPropertyValue(property)}`).join(';')
}

/** Resolve Word's stylesheet cascade in an isolated document. None of the
 * document's CSS reaches the application chrome or another document tab. */
async function measure(projection: Projection, css: string, signal: AbortSignal): Promise<Presentation> {
  const blocks = projection.blocks.filter(block => block.region === 'body' && !block.readOnly && block.presentationHtml)
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-same-origin')
  frame.setAttribute('aria-hidden', 'true')
  frame.inert = true
  frame.style.cssText = 'position:fixed;left:-100000px;top:0;width:800px;height:1px;border:0;visibility:hidden;pointer-events:none'
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve()
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
    // Only editable text blocks enter this frame; image/table previews use their
    // own bounded asset resolver. CSP also prevents external resource requests.
    frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data: blob:; base-uri 'none'"><style>body{margin:0;color:#000;font:12pt 'Times New Roman',serif;box-sizing:border-box}${css.replace(/<\/style/gi, '<\\/style')}</style></head><body data-hcd-source-format="docx">${blocks.map(block => `<article class="hcd-chunk">${block.presentationHtml}</article>`).join('')}</body></html>`
    document.body.append(frame)
    await loaded
    await frame.contentDocument!.fonts.ready
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    applyWordGrid(frame.contentDocument!)
    const result: ParagraphStyles = new Map()
    const articles = frame.contentDocument!.querySelectorAll('article.hcd-chunk')
    blocks.forEach((block, index) => {
      const article = articles[index], paragraph = article?.firstElementChild
      if (!paragraph) return
      let offset = 0
      const runs: RunStyle[] = []
      for (const inline of block.content.inlines) {
        const element = inline.nodeId ? article.querySelector(`[data-hcd-id="${CSS.escape(inline.nodeId)}"]`) : null
        const to = offset + inline.text.length // ProseMirror uses UTF-16 offsets.
        if (element && to > offset) runs.push({ from: offset, to, style: declarations(element, runProperties) })
        offset = to
      }
      result.set(block.blockId, { style: `${declarations(paragraph, paragraphProperties)};content-visibility:visible;contain-intrinsic-size:none`, text: block.content.inlines.map(inline => inline.text).join(''), runs })
    })
    const bodyStyle = frame.contentWindow!.getComputedStyle(frame.contentDocument!.body)
    const page = Object.fromEntries(['width', 'min-height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left']
      .map(property => [property, bodyStyle.getPropertyValue(property)]))
    return { paragraphs: result, page }
  } finally { frame.remove() }
}

function decorate(doc: PmNode, styles: ParagraphStyles, only?: Set<string>): { decorations: Decoration[] } {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    const id = node.attrs.hcdBlockId as string | undefined
    const presentation = id && styles.get(id)
    if (!id || !presentation || node.type.name === 'hcdOpaque') return
    if (only?.has(id)) return false
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { style: presentation.style, 'data-word-presentation': 'true' }, { blockId: id }))
    // A dirty local paragraph keeps mapped decorations; a late fetch must not
    // assign old run boundaries to unrelated draft text.
    if (node.textContent === presentation.text) for (const run of presentation.runs) {
      decorations.push(Decoration.inline(pos + 1 + run.from, pos + 1 + run.to, { style: run.style }, { inclusiveStart: true, inclusiveEnd: true }))
    }
    return false
  })
  return { decorations }
}

export const wordPresentation = Extension.create({
  name: 'wordPresentation',
  addProseMirrorPlugins() {
    return [new Plugin<State>({ key,
      state: {
        init: () => ({ styles: new Map(), page: {}, decorations: DecorationSet.empty }),
        apply(transaction, previous) {
          const presentation = transaction.getMeta(key) as Presentation | undefined
          if (presentation) {
            const next = decorate(transaction.doc, presentation.paragraphs)
            return { styles: presentation.paragraphs, page: presentation.page, decorations: DecorationSet.create(transaction.doc, next.decorations) }
          }
          if (!transaction.docChanged) return previous
          const mapped = previous.decorations.map(transaction.mapping, transaction.doc)
          const existing = new Set<string>(mapped.find().map(decoration => decoration.spec.blockId).filter((id): id is string => typeof id === 'string'))
          const added = decorate(transaction.doc, previous.styles, existing)
          return { styles: previous.styles, page: previous.page, decorations: mapped.add(transaction.doc, added.decorations) }
        },
      },
      view(view) {
        const applyPage = () => {
          const page = key.getState(view.state)?.page
          const paper = view.dom.closest<HTMLElement>('.document, .revision-paper')
          if (!paper || !page?.width) return
          paper.dataset.wordPage = 'true'
          for (const [property, value] of Object.entries(page)) paper.style.setProperty(`--word-page-${property}`, value)
        }
        applyPage()
        return { update: applyPage }
      },
      props: { decorations: state => key.getState(state)?.decorations },
    })]
  },
})

export async function loadWordPresentation(editor: Editor, session: Session, revision: number, signal: AbortSignal) {
  const [projection, css, theme] = await Promise.all([
    api(session, `/editor?revision=${revision}`, { signal }).then(response => response.json() as Promise<Projection>),
    api(session, `/styles?revision=${revision}`, { signal }).then(response => response.text()),
    loadThemeCss(session, revision),
  ])
  if (signal.aborted || editor.isDestroyed) return
  const styles = await measure(projection, `${css}\n${theme}`, signal)
  if (!signal.aborted && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(key, styles).setMeta('addToHistory', false))
}
