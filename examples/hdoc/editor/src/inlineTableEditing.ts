import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Mapping, StepMap } from '@tiptap/pm/transform'
import { editTextRuns, type TextRun } from './textRunEdits.ts'

type Run = TextRun & { from: number }
type Host = { element: HTMLElement; ids: string[]; template: HTMLElement; rendered: Run[] }
type Selection = { anchor: number; focus: number }

/** UTF-16 offsets match both DOM ranges and ProseMirror. Never split a surrogate. */
function difference(before: string, after: string) {
  let from = 0, suffix = 0
  while (from < before.length && from < after.length && before[from] === after[from]) from++
  if (from > 0 && /[\uD800-\uDBFF]/.test(before[from - 1])) from--
  while (suffix < before.length - from && suffix < after.length - from && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  if (suffix > 0 && /[\uDC00-\uDFFF]/.test(before[before.length - suffix])) suffix--
  return { from, to: before.length - suffix, insert: after.slice(from, after.length - suffix) }
}

function selection(host: HTMLElement): Selection | null {
  const selected = host.ownerDocument.getSelection()
  if (!selected?.anchorNode || !selected.focusNode || !host.contains(selected.anchorNode) || !host.contains(selected.focusNode)) return null
  const offset = (node: Node, end: number) => {
    const range = host.ownerDocument.createRange()
    range.selectNodeContents(host); range.setEnd(node, end)
    return range.toString().length
  }
  return { anchor: offset(selected.anchorNode, selected.anchorOffset), focus: offset(selected.focusNode, selected.focusOffset) }
}

function restoreSelection(host: HTMLElement, selected: Selection) {
  const point = (offset: number): [Node, number] => {
    const walker = host.ownerDocument.createTreeWalker(host, 4 /* SHOW_TEXT */)
    let node = walker.nextNode()
    while (node) {
      if (offset <= (node.textContent?.length || 0)) return [node, offset]
      offset -= node.textContent?.length || 0; node = walker.nextNode()
    }
    return [host, host.childNodes.length]
  }
  host.ownerDocument.getSelection()?.setBaseAndExtent(...point(selected.anchor), ...point(selected.focus))
}

/** Edit the actual canonical cell paragraphs, with no replacement cards or
 * overlay. Source runs live inside the outer atom as collaborative PM text. */
export function inlineTableEditing({ editor, getNode, getPos, doc, editableIds, label }: {
  editor: Editor; getNode: () => PmNode; getPos: () => number | undefined;
  doc: Document; editableIds: string[]; label: (cell: number, paragraph: number) => string;
}) {
  const allowed = new Set(editableIds), hosts: Host[] = [], cleanups: Array<() => void> = []
  let composition: { host: Host; runs: Run[]; mappings: Map<string, Mapping>; previous: Map<string, string> } | null = null
  let writing = false
  let syncedNode: PmNode | undefined, syncedEditable: boolean | undefined, syncedPos: number | undefined
  const runs = (): Run[] => {
    const pos = getPos()
    if (pos === undefined) return []
    const result: Run[] = []
    getNode().forEach((run, offset) => result.push({ nodeId: run.attrs.nodeId, text: run.textContent, from: pos + offset + 2 }))
    return result
  }
  const hostRuns = (host: Host, byId = new Map(runs().map(run => [run.nodeId, run]))) => {
    return host.ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
  }
  const render = (host: Host, next: Run[], reset = false) => {
    if (!reset && host.rendered.length === next.length && host.rendered.every((run, index) => run.text === next[index].text)) {
      host.rendered = next; return
    }
    const selected = selection(host.element)
    const before = host.rendered.map(run => run.text).join(''), after = next.map(run => run.text).join('')
    if (reset) host.element.replaceChildren(...Array.from(host.template.cloneNode(true).childNodes))
    for (const run of next) {
      const element = host.element.querySelector(`[data-hcd-node-hash][data-hcd-id="${CSS.escape(run.nodeId)}"]`)
      if (!element || element.textContent === run.text) continue
      if (element.childNodes.length === 1 && element.firstChild?.nodeType === 3) element.firstChild.textContent = run.text
      else element.replaceChildren(doc.createTextNode(run.text))
    }
    host.rendered = next
    if (selected && (reset || before !== after)) {
      const change = difference(before, after)
      const map = (offset: number) => offset <= change.from ? offset : offset >= change.to ? offset + change.insert.length - (change.to - change.from) : change.from + change.insert.length
      restoreSelection(host.element, { anchor: map(selected.anchor), focus: map(selected.focus) })
    }
  }
  const sync = () => {
    const node = getNode(), pos = getPos()
    if (node === syncedNode && editor.isEditable === syncedEditable && pos === syncedPos) return
    syncedNode = node; syncedEditable = editor.isEditable; syncedPos = pos
    const byId = new Map(runs().map(run => [run.nodeId, run]))
    for (const host of hosts) {
      const next = hostRuns(host, byId), editable = editor.isEditable && next.length === host.ids.length
      if (host.element.contentEditable !== (editable ? 'plaintext-only' : 'false')) {
        host.element.contentEditable = editable ? 'plaintext-only' : 'false'
        host.element.setAttribute('aria-readonly', String(!editable))
        host.element.tabIndex = editable ? 0 : -1
      }
      if (composition?.host !== host) {
        render(host, next)
      }
    }
  }
  const commit = (host: Host, value: string, selected: Selection | null, base = hostRuns(host), mappings = new Map<string, Mapping>(), reset = false) => {
    if (!editor.isEditable || !base.length) { render(host, hostRuns(host), true); return }
    const next = editTextRuns(base, value)
    const transaction = editor.state.tr
    const currentRuns = new Map(hostRuns(host).map(run => [run.nodeId, run]))
    next.forEach((run, index) => {
      const old = base[index]
      if (run.text === old.text) return
      const change = difference(old.text, run.text)
      const current = currentRuns.get(run.nodeId), mapping = mappings.get(run.nodeId)
      if (!current) return
      const from = transaction.mapping.map(current.from + (mapping?.map(change.from, 1) ?? change.from), 1)
      const to = transaction.mapping.map(current.from + (mapping?.map(change.to, -1) ?? change.to), -1)
      // A remote structural edit may remove a run. Never write into its neighbour.
      const start = transaction.doc.resolve(from), end = transaction.doc.resolve(Math.max(from, to))
      if (start.parent.type.name !== 'hcdOpaqueRun' || start.parent.attrs.nodeId !== run.nodeId || end.parent !== start.parent) return
      transaction.insertText(change.insert, from, Math.max(from, to))
    })
    writing = true
    try { if (transaction.docChanged) editor.view.dispatch(transaction) }
    finally { writing = false }
    render(host, hostRuns(host), reset)
    if (selected) {
      const merged = hostRuns(host).map(run => run.text).join(''), remote = difference(value, merged)
      const map = (offset: number) => offset < remote.from ? offset : offset >= remote.to ? offset + remote.insert.length - (remote.to - remote.from) : remote.from + remote.insert.length
      restoreSelection(host.element, { anchor: map(selected.anchor), focus: map(selected.focus) })
    }
  }
  const listen = <K extends keyof HTMLElementEventMap>(host: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void) => {
    host.addEventListener(type, handler); cleanups.push(() => host.removeEventListener(type, handler))
  }
  const groups = new Map<HTMLElement, string[]>()
  for (const element of doc.querySelectorAll<HTMLElement>('td [data-hcd-node-hash][data-hcd-id],th [data-hcd-node-hash][data-hcd-id]')) {
    const host = element.closest<HTMLElement>('p,li,h1,h2,h3,h4,h5,h6,td,th')
    if (!host) continue
    const ids = groups.get(host) || []; ids.push(element.dataset.hcdId!); groups.set(host, ids)
  }
  const cells = [...doc.querySelectorAll('td,th')]
  const initialRuns = new Map(runs().map(run => [run.nodeId, run]))
  for (const [element, ids] of groups) {
    if (!ids.length || ids.some(id => !allowed.has(id))) continue
    const mapped = ids.flatMap(id => initialRuns.has(id) ? [initialRuns.get(id)!] : [])
    // Unmapped labels or generated fields must not be flattened into editable text.
    if (element.textContent !== mapped.map(run => run.text).join('') && element.textContent !== ids.map(id => element.querySelector(`[data-hcd-id="${CSS.escape(id)}"]`)?.textContent || '').join('')) continue
    const cell = element.closest('td,th')!
    const host: Host = { element, ids, template: element.cloneNode(true) as HTMLElement, rendered: [] }
    hosts.push(host)
    element.dataset.hcdInlineTableText = ''
    element.setAttribute('role', 'textbox'); element.setAttribute('aria-multiline', 'true')
    element.setAttribute('aria-label', label(cells.indexOf(cell) + 1, hosts.filter(item => item.element.closest('td,th') === cell).length))
    element.style.outline = 'none'
    element.style.whiteSpace = 'pre-wrap'
    listen(element, 'focus', () => {
      // The enclosing PM selection still belongs to the last body paragraph.
      // Tell its toolbar that a protected table surface owns input instead.
      editor.view.dom.dispatchEvent(new CustomEvent('hcd-inline-table-focus', { detail: { blockId: getNode().attrs.hcdBlockId } }))
    })
    listen(element, 'beforeinput', event => {
      if (!editor.isEditable) { event.preventDefault(); return }
      if (event.isComposing || composition?.host === host || !event.cancelable) return
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault(); editor.commands[event.inputType === 'historyUndo' ? 'undo' : 'redo'](); return
      }
      const selected = selection(element)
      if (!selected) return
      const text = hostRuns(host).map(run => run.text).join('')
      let from = Math.min(selected.anchor, selected.focus), to = Math.max(selected.anchor, selected.focus), inserted = event.data || ''
      const target = event.getTargetRanges?.()[0]
      if (target && element.contains(target.startContainer) && element.contains(target.endContainer)) {
        const range = doc.createRange(); range.selectNodeContents(element); range.setEnd(target.startContainer, target.startOffset); from = range.toString().length
        range.setEnd(target.endContainer, target.endOffset); to = range.toString().length
      }
      if (event.inputType.startsWith('delete')) {
        inserted = ''
        if (from === to && /Backward$/.test(event.inputType)) from -= [...text.slice(0, from)].at(-1)?.length || 0
        if (from === to && /Forward$/.test(event.inputType)) to += [...text.slice(to)][0]?.length || 0
      } else if (['insertParagraph', 'insertLineBreak'].includes(event.inputType)) { event.preventDefault(); return }
      else if (!['insertText', 'insertReplacementText', 'insertFromYank'].includes(event.inputType)) return
      event.preventDefault()
      const cursor = from + inserted.length
      // Keep the original spans; only their text nodes change on ordinary input.
      commit(host, text.slice(0, from) + inserted + text.slice(to), { anchor: cursor, focus: cursor })
    })
    listen(element, 'input', () => {
      if (!composition) commit(host, element.innerText.replace(/[\r\n\t]+/g, ' '), selection(element), undefined, undefined, true)
    })
    listen(element, 'paste', event => {
      event.preventDefault()
      if (!editor.isEditable) return
      const selected = selection(element)
      if (!selected) return
      const text = hostRuns(host).map(run => run.text).join(''), from = Math.min(selected.anchor, selected.focus), to = Math.max(selected.anchor, selected.focus)
      const insert = event.clipboardData?.getData('text/plain').replace(/[\r\n\t]+/g, ' ') || '', cursor = from + insert.length
      commit(host, text.slice(0, from) + insert + text.slice(to), { anchor: cursor, focus: cursor })
    })
    listen(element, 'compositionstart', () => {
      const base = hostRuns(host)
      composition = { host, runs: base, mappings: new Map(), previous: new Map(base.map(run => [run.nodeId, run.text])) }
    })
    listen(element, 'compositionend', () => {
      const pending = composition
      if (!pending || pending.host !== host) return
      const value = element.innerText.replace(/[\r\n\t]+/g, ' '), selected = selection(element)
      composition = null
      commit(host, value, selected, pending.runs, pending.mappings, true)
    })
    listen(element, 'keydown', event => {
      if (event.isComposing || composition || !editor.isEditable) return
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault()
        editor.commands[event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo']()
      }
      if (event.key === 'Tab') {
        const index = hosts.indexOf(host), target = hosts[index + (event.shiftKey ? -1 : 1)]
        if (target) { event.preventDefault(); target.element.focus(); restoreSelection(target.element, { anchor: 0, focus: target.element.textContent?.length || 0 }) }
      }
    })
  }
  const transaction = () => {
    if (composition && !writing) for (const run of hostRuns(composition.host)) {
      const before = composition.previous.get(run.nodeId)
      if (before === undefined || before === run.text) continue
      const change = difference(before, run.text), mapping = composition.mappings.get(run.nodeId) || new Mapping()
      // y-prosemirror can express remote changes as a whole-document replace.
      // Map IME offsets within each stable source run instead of that PM step.
      mapping.appendMap(new StepMap([change.from, change.to - change.from, change.insert.length]))
      composition.mappings.set(run.nodeId, mapping); composition.previous.set(run.nodeId, run.text)
    }
    sync()
  }
  editor.on('transaction', transaction)
  editor.on('update', sync)
  // Prevent navigation out of the sandbox while retaining text selection.
  const click = (event: MouseEvent) => { if ((event.target as Element).closest('a')) event.preventDefault() }
  doc.addEventListener('click', click)
  sync()
  return {
    sync,
    destroy() {
      editor.off('transaction', transaction); editor.off('update', sync)
      doc.removeEventListener('click', click); cleanups.forEach(cleanup => cleanup())
    },
  }
}
