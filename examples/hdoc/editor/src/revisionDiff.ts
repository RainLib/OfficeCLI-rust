import type { Block, BlockContent, Projection } from './schema.ts'

export type TextRange = { from: number; to: number }
export type RevisionChange = { id: string; kind: 'added' | 'removed' | 'modified' | 'moved'; detail: 'text' | 'format' | 'complex'; oldRanges: TextRange[]; newRanges: TextRange[] }
export const blockText = (block: Block) => block.content.inlines.map(inline => inline.text).join('')
export function contentKey(content: BlockContent): string {
  // Inline node IDs and the splitting of equal runs are storage details.
  const runs: Array<{ text: string; bold: boolean; italic: boolean; link: string | null }> = []
  for (const inline of content.inlines) {
    if (!inline.text) continue
    const run = { text: inline.text, bold: !!inline.bold, italic: !!inline.italic, link: inline.link || null }
    const previous = runs.at(-1)
    if (previous && previous.bold === run.bold && previous.italic === run.italic && previous.link === run.link) previous.text += run.text
    else runs.push(run)
  }
  return JSON.stringify([content.kind, content.level ?? null, content.font?.latin || null, content.font?.eastAsia || null, content.font?.bidi || null, runs])
}

/** Bounded word/character LCS. Large replacements use common edges so comparing
 * long documents cannot allocate an unbounded quadratic matrix. */
export function textDifference(before: string, after: string): [TextRange[], TextRange[]] {
  const tokens = (text: string) => text.match(/[\p{Script=Han}]|[\p{L}\p{N}_]+|\s+|[^\s]/gu) || []
  const left = tokens(before), right = tokens(after)
  let prefix = 0, suffix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++
  const a = left.slice(prefix, left.length - suffix), b = right.slice(prefix, right.length - suffix)
  const offset = left.slice(0, prefix).join('').length
  if ((a.length + 1) * (b.length + 1) > 200_000) return [a.length ? [{ from: offset, to: offset + a.join('').length }] : [], b.length ? [{ from: offset, to: offset + b.join('').length }] : []]
  const width = b.length + 1, table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
  const removed: TextRange[] = [], added: TextRange[] = []
  const append = (ranges: TextRange[], from: number, length: number) => {
    if (ranges.at(-1)?.to === from) ranges[ranges.length - 1].to += length
    else ranges.push({ from, to: from + length })
  }
  let i = 0, j = 0, oldOffset = offset, newOffset = offset
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { oldOffset += a[i++].length; newOffset += b[j++].length }
    else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) { append(removed, oldOffset, a[i].length); oldOffset += a[i++].length }
    else { append(added, newOffset, b[j].length); newOffset += b[j++].length }
  }
  return [removed, added]
}

export function compareRevisions(before: Projection, after: Projection): RevisionChange[] {
  const left = before.blocks.filter(block => block.region === 'body'), right = after.blocks.filter(block => block.region === 'body')
  const old = new Map(left.map((block, index) => [block.blockId, { block, index }]))
  const next = new Map(right.map(block => [block.blockId, block]))
  // Longest increasing subsequence distinguishes reordered blocks from blocks
  // merely shifted by an insertion or deletion.
  const common = right.filter(block => old.has(block.blockId))
  const tails: number[] = [], tailIndices: number[] = [], parents: number[] = []
  common.forEach((block, index) => {
    const value = old.get(block.blockId)!.index
    let lo = 0, hi = tails.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (tails[mid] < value) lo = mid + 1; else hi = mid }
    parents[index] = lo ? tailIndices[lo - 1] : -1
    tails[lo] = value; tailIndices[lo] = index
  })
  const stationary = new Set<string>()
  for (let index = tailIndices.at(-1) ?? -1; index >= 0; index = parents[index]) stationary.add(common[index].blockId)
  const changes: RevisionChange[] = []
  for (const block of left) if (!next.has(block.blockId)) changes.push({ id: block.blockId, kind: 'removed', detail: 'text', oldRanges: [], newRanges: [] })
  for (const block of right) {
    const previous = old.get(block.blockId)?.block
    if (!previous) { changes.push({ id: block.blockId, kind: 'added', detail: 'text', oldRanges: [], newRanges: [] }); continue }
    const textChanged = blockText(previous) !== blockText(block)
    const complex = block.readOnly || previous.readOnly || block.content.kind === 'opaque'
    const changed = textChanged || contentKey(previous.content) !== contentKey(block.content) || (complex && (previous.blockHash !== block.blockHash || previous.readOnlyHtml !== block.readOnlyHtml))
    if (changed || !stationary.has(block.blockId)) {
      const [oldRanges, newRanges] = textChanged && !complex ? textDifference(blockText(previous), blockText(block)) : [[], []]
      changes.push({ id: block.blockId, kind: changed ? 'modified' : 'moved', detail: complex ? 'complex' : textChanged ? 'text' : 'format', oldRanges, newRanges })
    }
  }
  return changes
}
