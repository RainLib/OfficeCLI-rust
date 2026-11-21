import type { Inline } from './schema.ts'

/** Mirrors the server's scalar offset allocation. Source anchors retain their
 * wrappers; bold/italic belong to the new text, and link changes need rebuilding. */
export function distributeWordInlines(original: Inline[], replacement: Inline[]): Array<{ nodeId: string; inlines: Inline[] }> | null {
  const anchors: Array<{ nodeId: string; text: string; link: string | null; before: Inline }> = []
  for (const inline of original) {
    if (!inline.nodeId) return null
    const previous = anchors.at(-1), link = inline.link || null
    if (previous?.nodeId === inline.nodeId) {
      if (previous.link !== link) return null
      previous.text += inline.text
    } else {
      if (anchors.some(anchor => anchor.nodeId === inline.nodeId)) return null
      anchors.push({ nodeId: inline.nodeId, text: inline.text, link, before: inline })
    }
  }
  if (!anchors.length) return null
  const a = [...anchors.map(anchor => anchor.text).join('')], b = [...replacement.map(inline => inline.text).join('')]
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && suffix < b.length - prefix && a.at(-1 - suffix) === b.at(-1 - suffix)) suffix++
  let offset = 0, placed = false, input = 0, position = 0
  const result: Array<{ nodeId: string; inlines: Inline[] }> = []
  const characters = replacement.map(inline => [...inline.text])
  for (const anchor of anchors) {
    const count = [...anchor.text].length
    let remaining = Math.min(count, Math.max(0, prefix - offset)) + count - Math.min(count, Math.max(0, a.length - suffix - offset))
    if (!placed && prefix <= offset + count) { remaining += b.length - prefix - suffix; placed = true }
    offset += count
    const inlines: Inline[] = []
    while (remaining > 0) {
      if (input >= replacement.length) return null
      const inline = replacement[input], text = characters[input].slice(position, position + remaining).join('')
      if (!text) { input++; position = 0; continue }
      if ((inline.link || null) !== anchor.link) return null
      const length = [...text].length
      position += length; remaining -= length
      inlines.push({ ...inline, nodeId: anchor.nodeId, text })
    }
    result.push({ nodeId: anchor.nodeId, inlines: inlines.length ? inlines : [{ ...anchor.before, text: '' }] })
  }
  return result
}

export function applyWordInlineRuns(node: Element, original: Inline[], replacement: Inline[]): boolean {
  const plan = distributeWordInlines(original, replacement)
  if (!plan) return false
  const targets = plan.map(anchor => node.querySelector(`[data-hcd-id="${CSS.escape(anchor.nodeId)}"]`))
  if (targets.some(target => !target)) return false
  plan.forEach((anchor, index) => {
    targets[index]!.replaceChildren(...anchor.inlines.map(inline => {
      const element = node.ownerDocument.createElement('em')
      element.dataset.hcdDocxInline = `${Number(!!inline.bold)}${Number(!!inline.italic)}`
      element.style.fontWeight = inline.bold ? 'bold' : 'normal'
      element.style.fontStyle = inline.italic ? 'italic' : 'normal'
      element.textContent = inline.text
      return element
    }))
  })
  return true
}
