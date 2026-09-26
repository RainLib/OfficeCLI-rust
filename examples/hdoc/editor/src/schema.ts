import { Extension, Node, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Fragment, Slice, type Node as PmNode } from '@tiptap/pm/model'

export type Inline = { text: string; bold?: boolean; italic?: boolean; link?: string | null; nodeId?: string | null }
export type BlockContent = { kind: 'paragraph' | 'heading' | 'list_item' | 'opaque'; level?: number | null; inlines: Inline[] }
export type Block = { blockId: string; blockHash: string; region: string; readOnly: boolean; content: BlockContent; readOnlyHtml?: string }
export type Projection = { documentId: string; revision: number; blocks: Block[] }

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
  selectable: true,
  addAttributes() {
    return {
      hcdBlockId: { default: null },
      hcdContent: { default: null },
      preview: { default: '' },
    }
  },
  parseHTML() { return [{ tag: 'div[data-hcd-opaque]' }] },
  renderHTML({ node }) { return ['div', { 'data-hcd-opaque': '', 'data-hcd-block-id': node.attrs.hcdBlockId, contenteditable: 'false', class: 'hcd-opaque' }, node.attrs.preview || '只读复杂内容'] },
})

export const schemaExtensions = [StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }), HcdIdentity, HcdOpaque]

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
  if (inline.link) marks.push({ type: 'link', attrs: { href: inline.link } })
  return { type: 'text', text: inline.text, ...(marks.length ? { marks } : {}) }
}

function blockJson(block: Block): JSONContent {
  if (block.readOnly || block.content.kind === 'opaque') {
    return { type: 'hcdOpaque', attrs: { hcdBlockId: block.blockId, hcdContent: block.content, preview: block.content.inlines.map(part => part.text).join('').slice(0, 160) || '只读复杂内容' } }
  }
  const content = block.content.inlines.filter(part => part.text.length > 0).map(inlineJson)
  const attrs = { hcdBlockId: block.blockId }
  if (block.content.kind === 'heading') return { type: 'heading', attrs: { ...attrs, level: block.content.level || 1 }, content }
  if (block.content.kind === 'list_item') return { type: 'listItem', attrs, content: [{ type: 'paragraph', content }] }
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
      result.push({
        text: current.text || '',
        bold: current.marks?.some(mark => mark.type === 'bold') || false,
        italic: current.marks?.some(mark => mark.type === 'italic') || false,
        link: current.marks?.find(mark => mark.type === 'link')?.attrs?.href || null,
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
      result.push({ blockId: node.attrs?.hcdBlockId || null, content: node.attrs?.hcdContent || { kind: 'opaque', inlines: [] } })
    } else if (node.type === 'paragraph' || node.type === 'heading') {
      result.push({ blockId: node.attrs?.hcdBlockId || null, content: { kind: node.type, ...(node.type === 'heading' ? { level: node.attrs?.level || 1 } : {}), inlines: inlinesFromNode(node) } })
    } else if (node.type === 'listItem') {
      result.push({ blockId: node.attrs?.hcdBlockId || null, content: { kind: 'list_item', level: 0, inlines: inlinesFromNode(node) } })
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
