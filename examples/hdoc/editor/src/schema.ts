import { Extension, Mark, Node, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Fragment, Slice, type Node as PmNode } from '@tiptap/pm/model'

export type TextFormat = { font?: string; sizeHalfPoints?: number; color?: string; underline?: boolean }
export type Alignment = 'left' | 'center' | 'right' | 'justify'
export type Inline = { text: string; bold?: boolean; italic?: boolean; link?: string | null; nodeId?: string | null; format?: TextFormat }
/** The faces a block carries, in the three script slots `text.font` uses. Only the
 * slots the theme covers are present, which is what the server's `font` object looks
 * like, so a projection can be sent back unchanged. */
export type BlockFont = { latin?: string; eastAsia?: string; bidi?: string }
export type BlockContent = { kind: 'paragraph' | 'heading' | 'list_item' | 'opaque'; level?: number | null; font?: BlockFont | null; alignment?: Alignment; inlines: Inline[] }
export type Block = { blockId: string; blockHash: string; region: string; readOnly: boolean; editableTextNodeIds?: string[]; content: BlockContent; readOnlyHtml?: string; presentationHtml?: string }
export type Projection = { documentId: string; revision: number; blocks: Block[] }

/** The DOM form of a block face: the same `data-hcd-font*` attributes the server
 * writes on the text nodes it renders, so a copy inside or outside the editor keeps
 * the face. */
export function renderBlockFont(font: BlockFont | null | undefined): Record<string, string> {
  if (!font) return {}
  const attributes: Record<string, string> = {}
  if (font.latin) attributes['data-hcd-font-latin'] = font.latin
  if (font.eastAsia) attributes['data-hcd-font-east-asia'] = font.eastAsia
  if (font.bidi) attributes['data-hcd-font-bidi'] = font.bidi
  const primary = font.latin || font.eastAsia || font.bidi
  if (primary) attributes.style = `font-family:'${primary}'`
  return Object.keys(attributes).length ? attributes : {}
}

export function parseBlockFont(element: HTMLElement): BlockFont | null {
  const font: BlockFont = {}
  const latin = element.getAttribute('data-hcd-font-latin')
  const eastAsia = element.getAttribute('data-hcd-font-east-asia')
  const bidi = element.getAttribute('data-hcd-font-bidi')
  if (latin) font.latin = latin
  if (eastAsia) font.eastAsia = eastAsia
  if (bidi) font.bidi = bidi
  return Object.keys(font).length ? font : null
}

function alignment(value: unknown): Alignment | undefined {
  return value === 'left' || value === 'center' || value === 'right' || value === 'justify' ? value : undefined
}

function textFormat(attributes: Record<string, unknown> | undefined): TextFormat {
  const { font, sizeHalfPoints, color } = attributes || {}
  return {
    ...(typeof font === 'string' && /^[\p{L}\p{N} _-]+$/u.test(font) && new TextEncoder().encode(font).length <= 128 ? { font } : {}),
    ...(typeof sizeHalfPoints === 'number' && Number.isInteger(sizeHalfPoints) && sizeHalfPoints >= 2 && sizeHalfPoints <= 512 ? { sizeHalfPoints } : {}),
    ...(typeof color === 'string' && /^[0-9A-F]{6}$/i.test(color) ? { color: color.toUpperCase() } : {}),
  }
}

const HcdTextFormat = Mark.create({
  name: 'hcdTextFormat',
  addAttributes() {
    return { font: { default: null, rendered: false }, sizeHalfPoints: { default: null, rendered: false }, color: { default: null, rendered: false } }
  },
  parseHTML() {
    return [{ tag: 'span[data-hcd-text-format]', getAttrs: element => {
      const style = textFormat({ font: element.getAttribute('data-hcd-font'), sizeHalfPoints: Number(element.getAttribute('data-hcd-size')), color: element.getAttribute('data-hcd-color') })
      return Object.keys(style).length ? style : false
    } }]
  },
  renderHTML({ mark }) {
    const format = textFormat(mark.attrs)
    const css: string[] = []
    const attributes: Record<string, string> = { 'data-hcd-text-format': '' }
    if (format.font) { css.push(`font-family:'${format.font}'`); attributes['data-hcd-font'] = format.font }
    if (format.sizeHalfPoints) { css.push(`font-size:${format.sizeHalfPoints / 2}pt`); attributes['data-hcd-size'] = String(format.sizeHalfPoints) }
    if (format.color) { css.push(`color:#${format.color}`); attributes['data-hcd-color'] = format.color }
    if (css.length) attributes.style = css.join(';')
    return ['span', attributes, 0]
  },
})

const HcdAlignment = Extension.create({
  name: 'hcdAlignment',
  addGlobalAttributes() {
    return [{ types: ['paragraph', 'heading'], attributes: { hcdAlignment: {
      default: null,
      parseHTML: element => alignment(element.style.textAlign),
      renderHTML: attributes => {
        const value = alignment(attributes.hcdAlignment)
        return value ? { style: `text-align:${value}` } : {}
      },
    } } }]
  },
})

export const HcdIdentity = Extension.create({
  name: 'hcdIdentity',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading', 'listItem'],
      attributes: {
        hcdBlockId: { default: null, parseHTML: el => el.getAttribute('data-hcd-block-id'), renderHTML: attrs => attrs.hcdBlockId ? { 'data-hcd-block-id': attrs.hcdBlockId } : {} },
        // The face pinned on this block. A block-level property, so it rides on the
        // node, not on a mark: every text in the block takes the same three slots.
        hcdFont: { default: null, parseHTML: el => parseBlockFont(el), renderHTML: attrs => renderBlockFont(attrs.hcdFont) },
      },
    }]
  },
})

export const HcdOpaque = Node.create({
  name: 'hcdOpaque',
  group: 'block',
  atom: true,
  // The canonical DOM is owned by the NodeView, while these mapped runs carry
  // character-level collaborative edits and undo in the main Y.Doc.
  content: 'hcdOpaqueRun*',
  selectable: true,
  addAttributes() {
    return {
      hcdBlockId: { default: null },
      hcdContent: { default: null },
      preview: { default: '' },
      previewRevision: { default: null },
    }
  },
  parseHTML() { return [{ tag: 'div[data-hcd-opaque]' }] },
  renderHTML({ node }) { return ['div', { 'data-hcd-opaque': '', 'data-hcd-block-id': node.attrs.hcdBlockId, contenteditable: 'false', class: 'hcd-opaque' }, node.attrs.preview || '▣'] },
})

export const HcdOpaqueRun = Node.create({
  name: 'hcdOpaqueRun',
  content: 'text*',
  selectable: false,
  addAttributes() { return { nodeId: { default: null } } },
  parseHTML() { return [{ tag: 'span[data-hcd-opaque-run]' }] },
  renderHTML({ node }) { return ['span', { 'data-hcd-opaque-run': node.attrs.nodeId }, 0] },
})

export const schemaExtensions = [// Imported documents must not gain an implicit empty paragraph on checkpoint.
  StarterKit.configure({ undoRedo: false, trailingNode: false, link: { openOnClick: false } }), HcdIdentity, HcdAlignment, HcdTextFormat, HcdOpaque, HcdOpaqueRun]

// A pasted or split block must receive its own HCD identity at the next checkpoint.
export function clearPastedBlockIds(slice: Slice): Slice {
  const clear = (fragment: Fragment): Fragment => {
    const nodes: PmNode[] = []
    fragment.forEach(node => {
      if (node.isText) { nodes.push(node); return }
      const content = clear(node.content)
      nodes.push(node.attrs.hcdBlockId
        ? node.type.create({ ...node.attrs, hcdBlockId: null }, content, node.marks)
        : node.copy(content))
    })
    return Fragment.fromArray(nodes)
  }
  return new Slice(clear(slice.content), slice.openStart, slice.openEnd)
}

function inlineJson(inline: Inline): JSONContent {
  const marks: Array<{ type: string; attrs?: Record<string, unknown> }> = []
  if (inline.bold) marks.push({ type: 'bold' })
  if (inline.italic) marks.push({ type: 'italic' })
  const format = textFormat(inline.format)
  if (Object.keys(format).length) marks.push({ type: 'hcdTextFormat', attrs: format })
  if (inline.format?.underline) marks.push({ type: 'underline' })
  if (inline.link) marks.push({ type: 'link', attrs: { href: inline.link } })
  return { type: 'text', text: inline.text, ...(marks.length ? { marks } : {}) }
}

function blockJson(block: Block, revision: number): JSONContent {
  if (block.readOnly || block.content.kind === 'opaque') {
    return { type: 'hcdOpaque', attrs: { hcdBlockId: block.blockId, hcdContent: block.content, previewRevision: revision, preview: block.content.inlines.map(part => part.text).join('').slice(0, 160) || '▣' }, content: opaqueRunJson(block.content) }
  }
  const content = block.content.inlines.filter(part => part.text.length > 0).map(inlineJson)
  const attrs = { hcdBlockId: block.blockId, hcdAlignment: block.content.alignment, ...(block.content.font ? { hcdFont: block.content.font } : {}) }
  if (block.content.kind === 'heading') return { type: 'heading', attrs: { ...attrs, level: block.content.level || 1 }, content }
  if (block.content.kind === 'list_item') return { type: 'listItem', attrs, content: [{ type: 'paragraph', attrs: { hcdAlignment: block.content.alignment }, content }] }
  return { type: 'paragraph', attrs, content }
}

export function opaqueRunJson(content: BlockContent): JSONContent[] {
  return content.inlines.filter(inline => inline.nodeId).map(inline => ({
    type: 'hcdOpaqueRun', attrs: { nodeId: inline.nodeId },
    content: inline.text ? [{ type: 'text', text: inline.text }] : [],
  }))
}

export function projectionToJson(projection: Projection): JSONContent {
  const body = projection.blocks.filter(block => block.region === 'body')
  const content: JSONContent[] = []
  let pending: JSONContent | null = null
  for (const block of body) {
    if (!block.readOnly && block.content.kind === 'list_item') {
      const type = block.content.level === 1 ? 'orderedList' : 'bulletList'
      if (!pending || pending.type !== type) {
        pending = { type, content: [] }
        content.push(pending)
      }
      pending.content!.push(blockJson(block, projection.revision))
    } else {
      pending = null
      content.push(blockJson(block, projection.revision))
    }
  }
  return { type: 'doc', content }
}

function inlinesFromNode(node: JSONContent): Inline[] {
  const result: Inline[] = []
  const walk = (current: JSONContent) => {
    if (current.type === 'text') {
      const format = { ...textFormat(current.marks?.find(mark => mark.type === 'hcdTextFormat')?.attrs),
        ...(current.marks?.some(mark => mark.type === 'underline') ? { underline: true } : {}) }
      result.push({
        text: current.text || '',
        bold: current.marks?.some(mark => mark.type === 'bold') || false,
        italic: current.marks?.some(mark => mark.type === 'italic') || false,
        link: current.marks?.find(mark => mark.type === 'link')?.attrs?.href || null,
        ...(Object.keys(format).length ? { format } : {}),
      })
    }
    current.content?.forEach(walk)
  }
  node.content?.forEach(walk)
  return result
}

/** The snapshot form of a node's `hcdFont` attribute: only the slots that name a
 * family, so a block with no face sends no `font` at all and the server reads the
 * object exactly as its own projection wrote it. */
export function blockFontAttribute(attrs: Record<string, unknown> | undefined): { font?: BlockFont } {
  const font = attrs?.hcdFont as BlockFont | null | undefined
  const slots: BlockFont = {}
  if (font?.latin) slots.latin = font.latin
  if (font?.eastAsia) slots.eastAsia = font.eastAsia
  if (font?.bidi) slots.bidi = font.bidi
  return Object.keys(slots).length ? { font: slots } : {}
}

export function jsonToSnapshot(json: JSONContent): Array<{ blockId: string | null; content: BlockContent }> {
  const result: Array<{ blockId: string | null; content: BlockContent }> = []
  const push = (node: JSONContent) => {
    if (node.type === 'hcdOpaque') {
      const content: BlockContent = node.attrs?.hcdContent || { kind: 'opaque', inlines: [] }
      const runs = new Map(node.content?.map(run => [run.attrs?.nodeId, (run.content || []).map(text => text.text || '').join('')]))
      result.push({ blockId: node.attrs?.hcdBlockId || null, content: {
        ...content, inlines: content.inlines.map(inline => inline.nodeId && runs.has(inline.nodeId) ? { ...inline, text: runs.get(inline.nodeId)! } : inline),
      } })
    } else if (node.type === 'paragraph' || node.type === 'heading') {
      result.push({ blockId: node.attrs?.hcdBlockId || null, content: { kind: node.type, ...(node.type === 'heading' ? { level: node.attrs?.level || 1 } : {}), ...blockFontAttribute(node.attrs), alignment: alignment(node.attrs?.hcdAlignment ?? node.content?.[0]?.attrs?.hcdAlignment), inlines: inlinesFromNode(node) } })
    } else if (node.type === 'listItem') {
      result.push({ blockId: node.attrs?.hcdBlockId || null, content: { kind: 'list_item', level: 0, ...blockFontAttribute(node.attrs), alignment: alignment(node.attrs?.hcdAlignment ?? node.content?.[0]?.attrs?.hcdAlignment), inlines: inlinesFromNode(node) } })
    }
  }
  for (const node of json.content || []) {
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      for (const item of node.content || []) {
        if (item.type === 'listItem') {
          push(item)
          result[result.length - 1].content.level = node.type === 'orderedList' ? 1 : 0
        }
      }
    } else push(node)
  }
  const seen = new Set<string>()
  for (const block of result) {
    if (!block.blockId) continue
    if (seen.has(block.blockId)) block.blockId = null
    else seen.add(block.blockId)
  }
  return result
}
