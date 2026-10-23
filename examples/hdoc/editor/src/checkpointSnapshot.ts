import type { BlockContent, Inline } from './schema.ts'

export type SnapshotBlock = { blockId: string | null; content: BlockContent }
const orderedJson = (input: unknown): string => JSON.stringify(input, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)

/** Text source IDs, like block IDs, are internal canonical receipts. V2's
 * semantic digest ignores them; the exact request body is separately signed,
 * and the API checks source membership/order before any source rewrite.
 * The frozen legacy form retains IDs for verification of v1 receipts. */
function normalizedContent(content: BlockContent, keepSourceIds: boolean): BlockContent {
  const inlines: Inline[] = []
  for (const source of content.inlines) {
    const { nodeId: _sourceId, ...withoutSourceId } = source
    const inline = keepSourceIds ? source : withoutSourceId
    const previous = inlines.at(-1)
    const { text: _text, ...style } = inline
    const { text: _previousText, ...previousStyle } = previous ?? { text: '' }
    if (previous && !previous.hardBreak && !inline.hardBreak && orderedJson(style) === orderedJson(previousStyle)) previous.text += inline.text
    else inlines.push({ ...inline })
  }
  return { ...content, inlines, ...(content.children ? { children: content.children.map(child => normalizedContent(child, keepSourceIds)) } : {}) }
}
/** Block IDs are canonical receipts, not edits; their assignment must not
 * invalidate an acknowledgement for the same text and modeled formatting. */
export function checkpointContents(blocks: SnapshotBlock[]): string {
  return orderedJson(blocks.map(block => normalizedContent(block.content, false)))
}
/** Frozen v1 receipt semantics, used only to verify a signed legacy baseline. */
export function legacyCheckpointContents(blocks: SnapshotBlock[]): string {
  return orderedJson(blocks.map(block => normalizedContent(block.content, true)))
}
export async function checkpointDigest(blocks: SnapshotBlock[]): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(checkpointContents(blocks)))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** A save acknowledgement covers the captured snapshot, not subsequent edits. */
export function sameCheckpointContents(before: Array<{ blockId?: string | null; content: BlockContent }>, current: Array<{ blockId?: string | null; content: BlockContent }>): boolean {
  return before.length === current.length && before.every((block, index) => (!block.blockId || !current[index].blockId || block.blockId === current[index].blockId)) && checkpointContents(before.map(block => ({ ...block, blockId: block.blockId ?? null }))) === checkpointContents(current.map(block => ({ ...block, blockId: block.blockId ?? null })))
}
