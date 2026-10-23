import * as Y from 'yjs'
import type { BlockContent, Projection } from './schema.ts'
import { typography, type TextTypography } from './typography.ts'

export function yBlocks(document: Y.Doc): Y.XmlElement[] {
  const result: Y.XmlElement[] = []
  for (const item of document.getXmlFragment('default').toArray()) {
    if (!(item instanceof Y.XmlElement)) continue
    if (item.nodeName === 'bulletList' || item.nodeName === 'orderedList') {
      for (const nested of item.toArray()) if (nested instanceof Y.XmlElement && nested.nodeName === 'listItem') result.push(nested)
    } else result.push(item)
  }
  return result
}

const inlines = (block: BlockContent): BlockContent['inlines'] => [...block.inlines, ...(block.children || []).flatMap(inlines)]

/** Add marks to existing CRDT text; never recreate the fragment or its item IDs.
 * Ambiguous legacy pending text stays untouched and cannot be checkpointed.
 */
export function upgradeTypography(document: Y.Doc, projection: Projection): void {
  const metadata = document.getMap('hcdSchema')
  const version = metadata.get('typography')
  if (version === 2) return
  if (version !== undefined && version !== 1) throw new Error('Unsupported collaboration typography version')
  const mergeFont = (original: unknown, canonical: TextTypography | null): TextTypography | null => {
    const current = typography(original)
    if (version !== 1 || !current) return canonical
    if (current.family && canonical?.family && current.family !== canonical.family) return current
    return typography({ ...canonical, ...current })
  }
  const canonical = new Map(projection.blocks.map(block => [block.blockId, block]))
  const actions: Array<() => void> = []
  for (const node of yBlocks(document)) {
    const block = canonical.get(String(node.getAttribute('hcdBlockId') || ''))
    if (!block) continue
    const source = inlines(block.content)
    if (!source.some(part => typography(part.typography))) continue
    if (node.nodeName === 'hcdOpaque') {
      const content = node.getAttribute('hcdContent') as unknown as BlockContent | undefined
      if (JSON.stringify(content) !== JSON.stringify(block.content)) {
        // Opaque content has stable inline indices; preserve pending text and all other attrs.
        if (!content || content.kind !== block.content.kind || content.inlines.length !== block.content.inlines.length
          || content.inlines.some((part, index) => part.text !== block.content.inlines[index].text)) {
          throw new Error('Legacy collaboration text differs from canonical content; retain state for recovery')
        }
        actions.push(() => node.setAttribute('hcdContent', { ...content, inlines: content.inlines.map((part, index) => ({ ...part, typography: mergeFont(part.typography, typography(block.content.inlines[index].typography)) })) } as never))
      }
      continue
    }
    const segments: Array<{ leaf?: Y.XmlText; text: string }> = []
    let hasNonText = false, count = 0
    const collect = (parent: Y.XmlElement, depth = 0) => {
      if (depth > 128) throw new Error('Legacy collaboration nesting exceeds limit; retain state for recovery')
      for (const child of parent.toArray()) {
        if (++count > 1_000_000) throw new Error('Legacy collaboration work exceeds limit; retain state for recovery')
        if (child instanceof Y.XmlText) segments.push({ leaf: child, text: child.toDelta().map((part: { insert: unknown }) => typeof part.insert === 'string' ? part.insert : '').join('') })
        else if (child instanceof Y.XmlElement && child.nodeName === 'hardBreak') segments.push({ text: '\n' })
        else if (child instanceof Y.XmlElement) collect(child, depth + 1)
        else hasNonText = true
      }
    }
    collect(node)
    const text = segments.map(segment => segment.text).join('')
    if (hasNonText || source.map(part => part.text).join('') !== text) {
      throw new Error('Legacy collaboration text differs from canonical content; retain state for recovery')
    }
    let leafStart = 0
    for (const segment of segments) {
      const leaf = segment.leaf
      if (!leaf) { leafStart += segment.text.length; continue }
      let start = 0
      for (const part of source) {
        const end = start + part.text.length
        const from = Math.max(start, leafStart), to = Math.min(end, leafStart + leaf.length)
        const font = typography(part.typography)
        if (to > from && font) {
          let deltaStart = leafStart
          for (const delta of leaf.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>) {
            if (typeof delta.insert !== 'string') throw new Error('Unsupported legacy embedded text; retain state for recovery')
            const deltaEnd = deltaStart + delta.insert.length
            const begin = Math.max(from, deltaStart), finish = Math.min(to, deltaEnd)
            if (finish > begin) {
              const merged = mergeFont(delta.attributes?.textTypography, font)
              const offset = begin - leafStart
              actions.push(() => leaf.format(offset, finish - begin, { textTypography: merged }))
            }
            deltaStart = deltaEnd
          }
        }
        start = end
      }
      leafStart += leaf.length
    }
  }
  document.transact(() => {
    actions.forEach(action => action())
    metadata.set('typography', 2)
  }, 'hcd-typography-migration')
}
