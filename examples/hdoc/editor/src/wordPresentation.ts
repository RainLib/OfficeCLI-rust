import { applyWordGrid } from '../../../../crates/hcd-core/src/docx_layout.js'
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Mapping, StepMap } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import type { Node as PmNode } from '@tiptap/pm/model'
import { api, type Session } from './api.ts'
import type { Projection } from './schema.ts'
import { loadThemeCss } from './themeCss.ts'
import type { SemanticResources } from './semanticResources.ts'

type RunStyle = { from: number; to: number; style: string }
type ParagraphStyle = { style: string; text: string; runs: RunStyle[] }
type ParagraphStyles = Map<string, ParagraphStyle>
export type WordRunningContent = { header: string; footer: string; styles: string }
type Presentation = { paragraphs: ParagraphStyles; page: Record<string, string>; running: WordRunningContent }
type State = { styles: ParagraphStyles; page: Record<string, string>; decorations: DecorationSet; running: WordRunningContent | null }
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
  const body = projection.blocks.filter(block => block.region === 'body')
  const margins = projection.blocks.filter(block => ['header', 'footer'].includes(block.region))
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
    // Only body text is measured. Hidden edge/margin templates resolve section
    // references without loading their assets or changing the text geometry.
    frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data: blob:; base-uri 'none'"><style>body{margin:0;color:#000;font:12pt 'Times New Roman',serif;box-sizing:border-box}${css.replace(/<\/style/gi, '<\\/style')}</style></head><body data-hcd-source-format="docx">${blocks.map(block => `<article class="hcd-chunk">${block.presentationHtml}</article>`).join('')}<div hidden data-word-first>${body[0]?.presentationHtml || body[0]?.readOnlyHtml || ''}</div><div hidden data-word-last>${body.at(-1)?.presentationHtml || body.at(-1)?.readOnlyHtml || ''}</div>${margins.map(block=>`<aside hidden data-word-running="${block.region}">${block.readOnlyHtml || ''}</aside>`).join('')}</body></html>`
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
    const doc = frame.contentDocument!
    const running = (kind: 'header' | 'footer', edge: 'first' | 'last') => {
      const source = doc.querySelector(`[data-word-${edge}] > *`)
      if (!source) return ''
      const style = doc.defaultView!.getComputedStyle(source)
      const variant = edge === 'first' && style.getPropertyValue('--hcd-page-first').trim() === '1' ? 'first' : 'default'
      const part = style.getPropertyValue(`--hcd-page-${kind}-${variant}`).trim()
      if (!part) return ''
      const markup = [...doc.querySelectorAll(`[data-word-running="${kind}"] > *`)].filter(element =>
        (element.getAttribute('data-hcd-part') || element.querySelector('[data-hcd-part]')?.getAttribute('data-hcd-part')) === part,
      ).map(element=>element.outerHTML).join('')
      if (!markup) return ''
      const length = (name: string, fallback: string) => {
        const value = style.getPropertyValue(`--hcd-page-${name}`).trim() || fallback
        return parseFloat(value) * (value.endsWith('pt') ? 4/3 : 1) || 0
      }
      const geometry = { width:length('width',bodyStyle.width), height:length('height',bodyStyle.minHeight),
        left:length('left',bodyStyle.paddingLeft), right:length('right',bodyStyle.paddingRight),
        top:length('top',bodyStyle.paddingTop), bottom:length('bottom',bodyStyle.paddingBottom),
        offset:length(`${kind}-offset`,'24pt') }
      const canvas = doc.createElement('section'), region = doc.createElement('div')
      canvas.className = 'word-running-page'; canvas.dataset.wordPageGeometry = JSON.stringify(geometry)
      canvas.style.cssText = `position:relative;width:100%;height:${geometry.height}px`
      region.className = 'hcd-chunk word-running-content'
      region.style.cssText = `position:absolute;z-index:1;left:${geometry.left}px;right:${geometry.right}px;${kind === 'header' ? 'top' : 'bottom'}:${geometry.offset}px`
      region.innerHTML = markup; canvas.append(region)
      return canvas.outerHTML
    }
    return { paragraphs: result, page, running: { header: running('header', 'first'), footer: running('footer', 'last'), styles: css } }
  } finally { frame.remove() }
}

function decorate(doc: PmNode, styles: ParagraphStyles, only?: Set<string>, refreshBlocks = false): { decorations: Decoration[] } {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    const id = node.attrs.hcdBlockId as string | undefined
    const presentation = id && styles.get(id)
    if (!id || !presentation || node.type.name === 'hcdOpaque') return
    if (only?.has(id) && !refreshBlocks) return false
    // Source CSS supplies layout fidelity, while an explicit semantic alignment
    // is the current editable value (including collaborative undo/redo).
    const alignment = ['left', 'center', 'right', 'justify'].includes(node.attrs.hcdAlignment) ? `;text-align:${node.attrs.hcdAlignment}` : ''
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { style: presentation.style + alignment, 'data-word-presentation': 'true' }, { blockId: id, wordBlock: true }))
    if (only?.has(id)) return false
    // A dirty local paragraph keeps mapped decorations; a late fetch must not
    // assign old run boundaries to unrelated draft text.
    if (node.textContent === presentation.text) for (const run of presentation.runs) {
      decorations.push(Decoration.inline(pos + 1 + run.from, pos + 1 + run.to, { style: run.style }, { blockId: id, wordRun: true, inclusiveStart: true, inclusiveEnd: true }))
    }
    return false
  })
  return { decorations }
}

/** Yjs represents undo and room rebinding as a whole-document replacement.
 * Mapping inclusive run decorations through that replacement stretches every
 * source font across the document, creating huge nested spans and layout shifts.
 * Restore canonical blocks by identity; only map the actual text difference for
 * dirty paragraphs, whose local formatting must survive a collaborative undo. */
function collaborativeDecorations(transaction: Transaction, previous: State) {
  const start = transaction.before.content.findDiffStart(transaction.doc.content)
  const end = transaction.before.content.findDiffEnd(transaction.doc.content)
  const mapping = new Mapping()
  if (start !== null && end) {
    const overlap = Math.max(0, start - Math.min(end.a, end.b))
    mapping.appendMap(new StepMap([start, end.a + overlap - start, end.b + overlap - start]))
  }
  const restored = decorate(transaction.doc, previous.styles).decorations
  for (const decoration of previous.decorations.map(mapping, transaction.doc).find()) {
    if (!decoration.spec.wordRun) continue
    const position = transaction.doc.resolve(decoration.from), node = position.parent
    const id = node.attrs.hcdBlockId
    if (id === decoration.spec.blockId && decoration.to <= position.end() &&
        node.textContent !== previous.styles.get(id)?.text) restored.push(decoration)
  }
  return DecorationSet.create(transaction.doc, restored)
}

export const wordPresentation = Extension.create({
  name: 'wordPresentation',
  addProseMirrorPlugins() {
    return [new Plugin<State>({ key,
      state: {
        init: () => ({ styles: new Map(), page: {}, decorations: DecorationSet.empty, running: null }),
        apply(transaction, previous) {
          const presentation = transaction.getMeta(key) as Presentation | undefined
          if (presentation) {
            const next = decorate(transaction.doc, presentation.paragraphs)
            const running = previous.running && (['header', 'footer', 'styles'] as const).every(name=>previous.running![name] === presentation.running[name]) ? previous.running : presentation.running
            return { styles: presentation.paragraphs, page: presentation.page, running, decorations: DecorationSet.create(transaction.doc, next.decorations) }
          }
          if (!transaction.docChanged) return previous
          if (transaction.getMeta(ySyncPluginKey)?.isChangeOrigin) {
            return { ...previous, decorations: collaborativeDecorations(transaction, previous) }
          }
          const mapped = previous.decorations.map(transaction.mapping, transaction.doc)
          const existing = new Set<string>(mapped.find().filter(decoration=>decoration.spec.wordBlock).map(decoration => decoration.spec.blockId))
          const current = decorate(transaction.doc, previous.styles, existing, true).decorations
          // Rebuild block styles when attributes change; keep mapped run ranges
          // for dirty local text so a style update cannot restore stale runs.
          const retained = mapped.find().filter(decoration => !decoration.spec.wordBlock)
          const updated = current.filter(decoration => decoration.spec.wordBlock || !existing.has(decoration.spec.blockId))
          return { ...previous, decorations: DecorationSet.create(transaction.doc, [...retained, ...updated]) }
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

export const wordRunningContent = (editor: Editor) => key.getState(editor.state)?.running ?? null

export async function loadWordPresentation(editor: Editor, session: Session, revision: number, signal: AbortSignal, resources?: SemanticResources) {
  if (resources) {
    const { projection, styles } = await resources.load(revision)
    if (signal.aborted || editor.isDestroyed) return
    const presentation = await measure(projection, styles, signal)
    if (!signal.aborted && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(key, presentation).setMeta('addToHistory', false))
    return
  }
  const [projection, css, theme] = await Promise.all([
    api(session, `/editor?revision=${revision}`, { signal }).then(response => response.json() as Promise<Projection>),
    api(session, `/styles?revision=${revision}`, { signal }).then(response => response.text()),
    loadThemeCss(session, revision),
  ])
  if (signal.aborted || editor.isDestroyed) return
  const styles = await measure(projection, `${css}\n${theme}`, signal)
  if (!signal.aborted && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(key, styles).setMeta('addToHistory', false))
}
