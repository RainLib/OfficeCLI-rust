import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { SearchHit } from './DocumentSearch.tsx'

export const SEARCH_RESULT_LIMIT = 200

export function findSemanticText(document: ProseMirrorNode, query: string): SearchHit[] {
  const hits: SearchHit[] = []
  if (!query.trim() || query.includes('\0')) return hits
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  document.descendants((node, pos) => {
    if (hits.length > SEARCH_RESULT_LIMIT) return false
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true
    // Inline atoms and hard breaks occupy a position without supplying searchable text.
    const text = node.textBetween(0, node.content.size, undefined, '\0')
    for (const match of text.matchAll(pattern)) {
      const offset = match.index
      const matchLength = match[0].length
      const before = Math.max(0, offset - 32)
      const after = Math.min(text.length, offset + matchLength + 48)
      hits.push({ chunkSequence: 0, region: 'body', nodeId: String(pos), offset,
        position: pos + 1 + offset, matchLength,
        preview: `${before ? '…' : ''}${text.slice(before, after).replaceAll('\0', ' ')}${after < text.length ? '…' : ''}` })
      if (hits.length > SEARCH_RESULT_LIMIT) break
    }
    return false
  })
  return hits
}
