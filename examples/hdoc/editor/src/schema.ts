import { Extension, Mark, Node, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Fragment, Slice, type Node as PmNode } from '@tiptap/pm/model'

export type TextFormat = { font?: string; sizeHalfPoints?: number; color?: string; underline?: boolean }
export type Alignment = 'left' | 'center' | 'right' | 'justify'
export type Inline = { text: string; bold?: boolean; italic?: boolean; link?: string | null; nodeId?: string | null; format?: TextFormat }
export type BlockContent = { kind: 'paragraph' | 'heading' | 'list_item' | 'opaque'; level?: number | null; alignment?: Alignment; inlines: Inline[] }
export type Block = { blockId: string; blockHash: string; region: string; readOnly: boolean; editableTextNodeIds?: string[]; editableTableLayout?: boolean; editableEmptyCells?: [number, number][]; content: BlockContent; readOnlyHtml?: string }
export type Projection = { documentId: string; revision: number; blocks: Block[] }

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
      },
    }]
  },
})

export const HcdOpaque = Node.create({
  name: 'hcdOpaque',
  group: 'block',
  atom: true,
  content: 'hcdOpaqueRun*',
  selectable: true,
  addAttributes() {
    return {
      hcdBlockId: { default: null },
      hcdContent: { default: null },
      preview: { default: '' },
      hcdTable: { default: null },
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
  renderHTML() { return ['span', 0] },
})

export const schemaExtensions = [StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }), HcdIdentity, HcdOpaque, HcdOpaqueRun, HcdTextFormat, HcdAlignment]

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
  if (inline.format?.underline) marks.push({ type: 'underline' })
  const format = textFormat(inline.format)
  if (Object.keys(format).length) marks.push({ type: 'hcdTextFormat', attrs: format })
  if (inline.link) marks.push({ type: 'link', attrs: { href: inline.link } })
  return { type: 'text', text: inline.text, ...(marks.length ? { marks } : {}) }
}

function blockJson(block: Block): JSONContent {
  if (block.readOnly || block.content.kind === 'opaque') {
    const ids = new Set(block.editableTextNodeIds)
    const runs = block.content.inlines.filter(inline => inline.nodeId && ids.has(inline.nodeId)).map(inline => ({
      type: 'hcdOpaqueRun', attrs: { nodeId: inline.nodeId }, content: inline.text ? [{ type: 'text', text: inline.text }] : [],
    }))
    return { type: 'hcdOpaque', attrs: { hcdBlockId: block.blockId, hcdContent: block.content, hcdTable: ids.size > 0 || !!block.editableTableLayout, preview: block.content.inlines.map(part => part.text).join('').slice(0, 160) || '▣' }, content: runs }
  }
  const content = block.content.inlines.filter(part => part.text.length > 0).map(inlineJson)
  const attrs = { hcdBlockId: block.blockId, hcdAlignment: block.content.alignment }
  if (block.content.kind === 'heading') return { type: 'heading', attrs: { ...attrs, level: block.content.level || 1 }, content }
  if (block.content.kind === 'list_item') return { type: 'listItem', attrs: { hcdBlockId: block.blockId }, content: [{ type: 'paragraph', attrs: { hcdAlignment: block.content.alignment }, content }] }
  return { type: 'paragraph', attrs, content }
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
      pending.content!.push(blockJson(block))
    } else {
      pending = null
      content.push(blockJson(block))
    }
  }
  return { type: 'doc', content }
}

function inlinesFromNode(node: JSONContent): Inline[] {
  const result: Inline[] = []
  const walk = (current: JSONContent) => {
    if (current.type === 'text') {
      const format = textFormat(current.marks?.find(mark => mark.type === 'hcdTextFormat')?.attrs)
      if (current.marks?.some(mark => mark.type === 'underline')) format.underline = true
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

export function jsonToSnapshot(json: JSONContent): Array<{ blockId: string | null; content: BlockContent }> {
  const result: Array<{ blockId: string | null; content: BlockContent }> = []
  const push = (node: JSONContent) => {
    if (node.type === 'hcdOpaque') {
      const content: BlockContent = node.attrs?.hcdContent || { kind: 'opaque', inlines: [] }
      const edits = new Map(node.content?.map(run => [run.attrs?.nodeId, run.content?.map(item => item.text || '').join('') || '']))
      result.push({ blockId: node.attrs?.hcdBlockId || null, content: { ...content,
        inlines: content.inlines.map(inline => inline.nodeId && edits.has(inline.nodeId) ? { ...inline, text: edits.get(inline.nodeId)! } : inline),
      } })
    } else if (node.type === 'paragraph' || node.type === 'heading') {
      result.push({ blockId: node.attrs?.hcdBlockId || null, content: { kind: node.type, ...(node.type === 'heading' ? { level: node.attrs?.level || 1 } : {}), alignment: alignment(node.attrs?.hcdAlignment), inlines: inlinesFromNode(node) } })
    } else if (node.type === 'listItem') {
      result.push({ blockId: node.attrs?.hcdBlockId || null, content: { kind: 'list_item', level: 0, alignment: alignment(node.content?.[0]?.attrs?.hcdAlignment), inlines: inlinesFromNode(node) } })
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
