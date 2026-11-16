import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { api, type Session } from './api.ts'
import { jsonToSnapshot, type Block, type Inline, type Projection } from './schema.ts'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { useI18n } from './i18n.tsx'
import { FixedPreviewFrame } from './FixedPreviewFrame.tsx'
import { prepareWordPreview } from './prepareWordPreview.ts'
import { applyWordInlineRuns } from './wordInlineRuns.ts'

const sameMarks = (a: Inline, b: Inline) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && (a.link || null) === (b.link || null)
function groups(inlines: Inline[]): Inline[][] {
  const result: Inline[][] = []
  for (const inline of inlines.filter(value => value.text)) {
    const previous = result.at(-1)
    if (previous && sameMarks(previous[0], inline)) previous.push(inline)
    else result.push([inline])
  }
  return result
}

/** Keep canonical run boundaries, explicit breaks and formatting in a text-only
 * local draft, just as the server does at checkpoint. This never writes a patch. */
function draftText(node: Element, original: Block, inlines: Inline[]): boolean {
  const before = groups(original.content.inlines), after = groups(inlines)
  if (node.querySelector('[data-hcd-docx-inline]') || before.length !== after.length || before.some((group, index) => !sameMarks(group[0], after[index][0]))) {
    return applyWordInlineRuns(node, original.content.inlines, inlines)
  }
  for (let index = 0; index < before.length; index++) {
    const old = before[index], next = after[index]
    if (!sameMarks(old[0], next[0])) return false
    const a = [...old.map(run => run.text).join('')], b = [...next.map(run => run.text).join('')]
    let prefix = 0, suffix = 0
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
    while (suffix < a.length - prefix && suffix < b.length - prefix && a.at(-1 - suffix) === b.at(-1 - suffix)) suffix++
    const end = a.length - suffix, inserted = b.slice(prefix, b.length - suffix).join('')
    let offset = 0, placed = false
    for (const run of old) {
      const element = run.nodeId && node.querySelector(`[data-hcd-id="${CSS.escape(run.nodeId)}"]`)
      if (!element) return false
      const characters = [...run.text], finish = offset + characters.length
      let text = characters.slice(0, Math.min(characters.length, Math.max(0, prefix - offset))).join('')
      if (!placed && prefix <= finish) { text += inserted; placed = true }
      text += characters.slice(Math.min(characters.length, Math.max(0, end - offset))).join('')
      element.textContent = text; offset = finish
    }
  }
  return true
}

function overlayDraft(document: Document, projection: Projection, editor: Editor) {
  const originals = new Map(projection.blocks.map(block => [block.blockId, block]))
  const section = document.createElement('section')
  section.className = 'hcd-chunk'; section.dataset.hcdRegion = 'body'
  const liveNodes = editor.view.dom.querySelectorAll(':scope > p,:scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6,:scope > ul > li,:scope > ol > li,:scope > .hcd-opaque')
  let previousSection = '0'
  jsonToSnapshot(editor.getJSON()).forEach((snapshot, index) => {
    const original = snapshot.blockId ? originals.get(snapshot.blockId) : undefined
    const raw = original?.readOnlyHtml || original?.presentationHtml
    const holder = document.createElement('div'); if (raw) holder.innerHTML = raw
    const canonical = holder.firstElementChild
    let node: Element | null = canonical
    if (original && !original.readOnly && canonical) {
      const sameShape = snapshot.content.kind === original.content.kind && snapshot.content.level === original.content.level && (['latin', 'eastAsia', 'bidi'] as const).every(slot => (snapshot.content.font?.[slot] || null) === (original.content.font?.[slot] || null))
      if (!sameShape || !draftText(canonical, original, snapshot.content.inlines)) node = liveNodes[index]?.cloneNode(true) as Element || null
    } else if (!original) node = liveNodes[index]?.cloneNode(true) as Element || null
    if (!node) throw new Error('无法呈现本地段落，请返回编辑重试')
    for (const decoration of node.querySelectorAll('.ProseMirror-widget,.collaboration-carets__caret,.collaboration-cursor__caret')) decoration.remove()
    const sourceSection = canonical?.getAttribute('data-hcd-section') || canonical?.querySelector('[data-hcd-section]')?.getAttribute('data-hcd-section') || previousSection
    node.setAttribute('data-hcd-section', sourceSection); previousSection = sourceSection
    node.removeAttribute('contenteditable')
    if (snapshot.blockId) node.setAttribute('data-hcd-block-id', snapshot.blockId)
    section.append(node)
  })
  const chunks = document.body.querySelectorAll(':scope > section.hcd-chunk[data-hcd-region="body"]')
  for (const chunk of chunks) chunk.remove()
  document.body.prepend(section)
}

export function WordPagePreview({ session, revision, editor }: { session: Session; revision: number; editor: Editor }) {
  const { locale } = useI18n()
  const frame = useRef<HTMLIFrameElement>(null)
  const [source, setSource] = useState('<!doctype html><html><head></head><body></body></html>')
  const assets = useRef(new Map<string, Promise<string>>())
  const urls = useRef<string[]>([])
  const resourcesAlive = useRef(true)
  useEffect(() => { resourcesAlive.current = true; return () => { resourcesAlive.current = false; urls.current.forEach(url => URL.revokeObjectURL(url)); assets.current.clear() } }, [])
  const [error, setError] = useState(''), [retry, setRetry] = useState(0), [pages, setPages] = useState(0)
  const measureFrame = () => {
    const element = frame.current, body = element?.contentDocument?.body
    if (!element || !body) return
    if (body.dataset.hcdPaginationError) { setError(body.dataset.hcdPaginationError); return }
    if (!body.dataset.hcdPageCount) return
    const bounds = [...body.querySelectorAll<HTMLElement>('.hcd-virtual-page')].map(page => page.getBoundingClientRect())
    element.style.width = `${Math.max(300, ...bounds.map(rect => rect.width)) + 48}px`
    // Use page extents, not scrollHeight (which is at least the old iframe
    // viewport height and could grow on every ResizeObserver notification).
    element.style.height = `${Math.ceil(Math.max(0, ...bounds.map(rect => rect.bottom)) + (body.ownerDocument.defaultView?.scrollY || 0) + 48)}px`
    setPages(Number(body.dataset.hcdPageCount))
  }
  const measureRef = useRef(measureFrame)
  measureRef.current = measureFrame
  useEffect(() => {
    const request = new AbortController()
    let timer = 0, generation = 0, renderedSnapshot = ''
    let preparation: AbortController | undefined
    const base = Promise.all([
      api(session, `/presentation?revision=${revision}`, { signal: request.signal }).then(response => response.text()),
      api(session, `/editor?revision=${revision}`, { signal: request.signal }).then(response => response.json() as Promise<Projection>),
    ])
    const render = async () => {
      const current = ++generation
      preparation?.abort(); preparation = new AbortController()
      const signal = AbortSignal.any([request.signal, preparation.signal])
      try {
        const [html, projection] = await base
        if (request.signal.aborted || editor.isDestroyed) return
        const snapshot = JSON.stringify(editor.getJSON())
        if (snapshot === renderedSnapshot) return
        const document = new DOMParser().parseFromString(html, 'text/html')
        const scripts = [...document.querySelectorAll('script')]
        const runtime = scripts.find(script => script.id === 'hcd-docx-virtual-pages')
        if (!runtime || scripts.length !== 1) throw new Error('分页预览脚本无效')
        overlayDraft(document, projection, editor)
        const nonce = crypto.randomUUID().replaceAll('-', '')
        runtime.setAttribute('nonce', nonce)
        const policy = document.createElement('meta')
        policy.httpEquiv = 'Content-Security-Policy'
        // Only the server-owned paginator can execute. Canonical content and
        // draft text cannot introduce scripts, forms, network or navigation.
        policy.content = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src data: blob:; img-src data: blob:; base-uri 'none'; form-action 'none'`
        document.head.prepend(policy)
        let source = '<!doctype html>' + document.documentElement.outerHTML
        const hashes = [...new Set([...source.matchAll(/asset:\/\/sha256\/([0-9a-f]{64})/g)].map(match => match[1]))]
        if (hashes.length > 256) throw new Error('分页预览图片过多')
        for (const hash of hashes) {
          let resource = assets.current.get(hash)
          if (!resource) {
            resource = api(session, `/assets/${hash}?revision=${revision}`).then(response => response.blob()).then(blob => {
              if (blob.size > 64 * 1024 * 1024) throw new Error('分页预览图片过大')
              if (!resourcesAlive.current) throw new DOMException('Aborted', 'AbortError')
              const url = URL.createObjectURL(blob); urls.current.push(url); return url
            })
            assets.current.set(hash, resource)
            void resource.catch(() => assets.current.delete(hash))
          }
          source = source.replaceAll(`asset://sha256/${hash}`, await resource)
        }
        if (request.signal.aborted || current !== generation || !frame.current) return
        const prepared = await prepareWordPreview(source, signal)
        if (request.signal.aborted || current !== generation) return
        renderedSnapshot = snapshot
        setError(''); setSource(prepared)
      } catch (cause) { if (!request.signal.aborted && current === generation) setError(String(cause)) }
    }
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void render(), 120) }
    setError(''); void render()
    editor.on('update', schedule)
    return () => { request.abort(); generation++; window.clearTimeout(timer); editor.off('update', schedule) }
  }, [session, revision, editor, retry])
  useEffect(() => {
    const element = frame.current
    if (!element) return
    let resize: ResizeObserver | undefined, mutations: MutationObserver | undefined
    const load = () => {
      resize?.disconnect(); mutations?.disconnect()
      const body = element.contentDocument?.body
      if (!body) return
      const measure = () => measureRef.current()
      resize = new ResizeObserver(measure); resize.observe(body)
      mutations = new MutationObserver(measure); mutations.observe(body, { attributes: true })
      measure()
    }
    element.addEventListener('load', load); load()
    return () => { element.removeEventListener('load', load); resize?.disconnect(); mutations?.disconnect() }
  }, [])
  return <section className="word-page-preview" aria-label={localizeSource(locale, 'Word 分页预览')}>
    <div className="word-preview-status" role="status"><LocalText source="分页预览" />{pages > 0 ? ` · ${pages}` : '…'}</div>
    {error && <div className="word-preview-error" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}><LocalText source="重试" /></button></div>}
    <FixedPreviewFrame frame={frame} title={localizeSource(locale, 'Word 分页内容')} sandbox="allow-same-origin" source={source} height={0} onReady={measureFrame} />
  </section>
}
