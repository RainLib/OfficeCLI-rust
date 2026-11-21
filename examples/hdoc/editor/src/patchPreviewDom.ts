/** Reconcile prepared, sandboxed preview markup without navigating the frame.
 * Stable document IDs survive text edits, insertions and pagination moves. */
function key(node: Node): string | null {
  if (node.nodeType !== 1) return null
  const element = node as Element
  for (const name of ['data-hcd-id', 'data-hcd-block-id', 'id']) {
    const value = element.getAttribute(name)
    if (value) return `${element.namespaceURI}:${element.localName}:${name}:${value}`
  }
  return null
}
const owned = (node: Node) => node.nodeType === 1 && (node as Element).matches('.hcd-direct-editor,.hcd-draft-text,[data-agent-canvas-layer]')
const compatible = (a: Node, b: Node) => a.nodeType === b.nodeType && (a.nodeType !== 1 || (a as Element).localName === (b as Element).localName && (a as Element).namespaceURI === (b as Element).namespaceURI)

export function patchPreviewDom(current: Element, next: Element) {
  const indexed = new Map<string, Element>()
  const duplicates = new Set<string>()
  for (const element of current.querySelectorAll('*')) {
    const id = key(element)
    if (id) { if (indexed.has(id)) duplicates.add(id); else indexed.set(id, element) }
  }
  for (const id of duplicates) indexed.delete(id)
  const used = new Set<Node>()
  // Keep removals until the entire tree is patched: a paragraph may have moved
  // to a later page, and must be moved there rather than cloned and remounted.
  const removals: Node[] = []
  const patch = (live: Node, desired: Node) => {
    if (owned(live) || live.isEqualNode(desired)) return
    if (live.nodeType === 3 || live.nodeType === 8) { if (live.nodeValue !== desired.nodeValue) live.nodeValue = desired.nodeValue; return }
    if (live.nodeType !== 1) return
    const element = live as Element, source = desired as Element
    for (const attribute of [...element.attributes]) if (!source.hasAttribute(attribute.name)) element.removeAttribute(attribute.name)
    for (const attribute of [...source.attributes]) if (element.getAttribute(attribute.name) !== attribute.value) element.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
    const oldChildren = [...element.childNodes]
    const local = new Map(oldChildren.flatMap(node => { const id = key(node); return id ? [[id, node] as const] : [] }))
    let cursor = element.firstChild
    for (const child of [...source.childNodes]) {
      const id = key(child)
      let match = id ? local.get(id) ?? indexed.get(id) : undefined
      if (match && (used.has(match) || !compatible(match, child) || match.contains(element))) match = undefined
      if (!match && !id) match = oldChildren.find(node => !used.has(node) && !key(node) && !owned(node) && compatible(node, child))
      if (!match) match = element.ownerDocument.importNode(child, false)
      used.add(match)
      if (match !== cursor) element.insertBefore(match, cursor)
      patch(match, child)
      cursor = match.nextSibling
    }
    for (const child of oldChildren) if (!used.has(child) && !owned(child)) removals.push(child)
  }
  patch(current, next)
  for (const node of removals) if (!used.has(node)) node.parentNode?.removeChild(node)
}
