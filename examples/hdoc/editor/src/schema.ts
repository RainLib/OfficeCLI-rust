import { Extension, Mark, Node, type JSONContent } from '@tiptap/core'
import { translate, type EditorLocale } from './i18n.tsx'
import { typography, typographyCss, type TextTypography } from './typography.ts'
import StarterKit from '@tiptap/starter-kit'
import CodeBlock from '@tiptap/extension-code-block'
import Code from '@tiptap/extension-code'
import { Fragment, Slice, type Node as PmNode } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'

export type InlineBorder = { color: string; widthPt: number; style: 'solid' | 'dashed' | 'dotted' | 'double' }
export type Inline = { typography?: TextTypography | null; fontSizeExplicit?: boolean; text: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean; hardBreak?: boolean; link?: string | null; nodeId?: string | null; textColor?: string | null; backgroundColor?: string | null; border?: InlineBorder | null }

const borderStyles = new Set(['solid', 'dashed', 'dotted', 'double'])

function borderMark() {
  return Mark.create({
    name: 'textBorder',
    addAttributes() {
      return {
        color: { default: '#1f2328' },
        widthPt: { default: 1 },
        style: { default: 'solid' },
      }
    },
    parseHTML() { return [{ tag: 'span[data-hcd-mark="textBorder"]' }] },
    renderHTML({ HTMLAttributes }) {
      const color = hexColor.test(HTMLAttributes.color || '') ? HTMLAttributes.color : '#1f2328'
      const width = Number(HTMLAttributes.widthPt)
      const style = borderStyles.has(HTMLAttributes.style) ? HTMLAttributes.style : 'solid'
      const value = `${Number.isFinite(width) && width > 0 && width <= 12 ? width : 1}pt ${style} ${color}`
      return ['span', { 'data-hcd-mark': 'textBorder', style: `border-top:${value};border-right:${value};border-bottom:${value};border-left:${value}` }, 0]
    },
  })
}

const TextTypographyMark = Mark.create({
  name: 'textTypography',
  addAttributes() {
    return { explicitSize: { default: false, parseHTML: (element: HTMLElement) => element.getAttribute('data-explicit-size') === 'true', renderHTML: () => ({}) }, ...Object.fromEntries(['family', 'sizePt', 'latin', 'eastAsia', 'bidi'].map(key => [key, {
      default: null,
      parseHTML: (element: HTMLElement) => key === 'sizePt'
        ? Number(element.getAttribute('data-size-pt')) || null
        : element.getAttribute(`data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`),
      renderHTML: () => ({}),
    }])) }
  },
  parseHTML() { return [{ tag: 'span[data-hcd-mark="textTypography"]' }] },
  renderHTML({ mark }) {
    const value = typography(mark.attrs)
    return ['span', { 'data-hcd-mark': 'textTypography', 'data-explicit-size': String(mark.attrs.explicitSize === true), style: typographyCss(value),
      ...(value ? Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [`data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, item])) : {}),
    }, 0]
  },
})

// Code blocks retain source typography, while other formatting stays disallowed.
const CodeTypography = CodeBlock.extend({ marks: 'textTypography hcdSource' })

const sourceId = /^n_[0-9a-f]{32}$/
const SourceIdentity = Mark.create({
  name: 'hcdSource',
  addAttributes() { return { nodeId: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute('data-hcd-source-text') } } },
  parseHTML() { return [{ tag: 'span[data-hcd-source-text]' }] },
  renderHTML({ mark }) { return ['span', sourceId.test(mark.attrs.nodeId || '') ? { 'data-hcd-source-text': mark.attrs.nodeId } : {}, 0] },
  addProseMirrorPlugins() {
    return [new Plugin({ appendTransaction: (transactions, before, state) => {
      if (!transactions.some(transaction => transaction.docChanged)) return null
      const transaction = state.tr
      state.doc.descendants((node, position) => {
        if (!node.isTextblock) return
        const context = state.doc.resolve(position)
        const ancestors = [node, ...Array.from({length:context.depth}, (_, index) => context.node(context.depth - index))]
        const owner = ancestors.find(ancestor => ancestor.attrs.hcdBlockId)
        const defaults = sourceId.test(node.attrs.hcdSourceId || '') ? node.attrs : owner?.attrs
        if (!owner || !sourceId.test(defaults?.hcdSourceId || '')) return
        const previous = position <= before.doc.content.size ? before.doc.nodeAt(position) : null
        const wasEmpty = previous?.isTextblock && previous.attrs.hcdBlockId === node.attrs.hcdBlockId && previous.content.size === 0
        const fallbackFont = typography(defaults?.hcdSourceTypography)
        node.forEach((child, offset, index) => {
          if (!child.isText || child.marks.some(mark => mark.type.name === 'hcdSource')) return
          const neighbor = (index > 0 ? node.child(index - 1).marks : []).find(mark => mark.type.name === 'hcdSource')
            || (index + 1 < node.childCount ? node.child(index + 1).marks : []).find(mark => mark.type.name === 'hcdSource')
          const id = neighbor?.attrs.nodeId || defaults?.hcdSourceId
          const start = position + 1 + offset, end = start + child.nodeSize
          transaction.addMark(start, end, state.schema.marks.hcdSource.create({ nodeId: id }))
          if (wasEmpty && fallbackFont && !child.marks.some(mark => mark.type.name === 'textTypography')) transaction.addMark(start, end, state.schema.marks.textTypography.create({ ...fallbackFont, explicitSize: defaults?.hcdSourceSizeExplicit === true }))
        })
      })
      return transaction.docChanged ? transaction.setMeta('hcd-source-defaults', true) : null
    } })]
  },
})

const hexColor = /^#[0-9a-fA-F]{6}$/

function colorMark(name: string, cssProperty: 'color' | 'background-color') {
  return Mark.create({
    name,
    addAttributes() {
      return {
        color: {
          default: null,
          parseHTML: element => element.style.getPropertyValue(cssProperty) || null,
          renderHTML: attributes => hexColor.test(attributes.color || '') ? { style: `${cssProperty}:${attributes.color}` } : {},
        },
      }
    },
    parseHTML() { return [{ tag: `span[data-hcd-mark="${name}"]` }] },
    renderHTML({ HTMLAttributes }) { return ['span', { ...HTMLAttributes, 'data-hcd-mark': name }, 0] },
  })
}
export type BlockContent = { kind: 'paragraph' | 'heading' | 'list_item' | 'opaque' | 'code_block' | 'blockquote' | 'bullet_list' | 'ordered_list' | 'horizontal_rule'; level?: number | null; inlines: Inline[]; children?: BlockContent[]; language?: string | null; listStart?: number | null }
export type Block = { blockId: string; blockHash: string; region: string; readOnly: boolean; content: BlockContent; readOnlyHtml?: string }
export const editorSurfaceRegions = ['body', 'header', 'footer', 'footnote', 'endnote'] as const
const marginalRegions = new Set(['header', 'footer', 'footnote', 'endnote'])

export function editorSurface(blocks: Block[]): Block[] {
  return blocks.filter(block => (editorSurfaceRegions as readonly string[]).includes(block.region))
}

function regionLabel(region: string, locale: EditorLocale): string {
  if (region === 'header') return translate(locale, 'headerRegion')
  if (region === 'footer') return translate(locale, 'footerRegion')
  if (region === 'footnote') return translate(locale, 'footnoteRegion')
  if (region === 'endnote') return translate(locale, 'endnoteRegion')
  return ''
}
export type TrackedChange = { changeId: string; kind: string; author?: string; date?: string; text: string; blockId: string }
export type CommentNote = { blockId: string; nodeId?: string; nodeHash?: string; text: string }
export type Projection = { documentId: string; revision: number; blocks: Block[]; trackedChanges?: TrackedChange[]; comments?: CommentNote[] }

export const HcdIdentity = Extension.create({
  name: 'hcdIdentity',
  addStorage() { return { locale: 'en-US' as EditorLocale } },
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'horizontalRule'],
      attributes: {
        hcdBlockId: { default: null, parseHTML: el => el.getAttribute('data-hcd-block-id'), renderHTML: attrs => attrs.hcdBlockId ? { 'data-hcd-block-id': attrs.hcdBlockId } : {} },
        hcdSourceId: { default: null, renderHTML: () => ({}) },
        hcdSourceTypography: { default: null, renderHTML: () => ({}) },
        hcdSourceSizeExplicit: { default: false, renderHTML: () => ({}) },
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
      hcdRegion: { default: 'body' },
      preview: { default: '' },
    }
  },
  parseHTML() { return [{ tag: 'div[data-hcd-opaque]' }] },
  renderHTML({ node }) { return ['div', { 'data-hcd-opaque': '', 'data-hcd-block-id': node.attrs.hcdBlockId, contenteditable: 'false', class: 'hcd-opaque' }, node.attrs.preview || '▣'] },
  addNodeView() {
    return ({ node: initial, editor, getPos }) => {
      let current = initial
      const dom = document.createElement('div')
      dom.className = 'hcd-opaque'
      dom.contentEditable = 'false'
      const preview = document.createElement('div')
      preview.className = 'hcd-opaque-preview'
      dom.append(preview)
      const fields: HTMLTextAreaElement[] = []
      const paint = (node: typeof initial) => {
        current = node
        const content = node.attrs.hcdContent as BlockContent | null
        const marginal = marginalRegions.has(String(node.attrs.hcdRegion || ''))
        const label = regionLabel(String(node.attrs.hcdRegion || ''), (editor.storage as unknown as { hcdIdentity: { locale: EditorLocale } }).hcdIdentity.locale)
        preview.textContent = label ? `${label} · ${node.attrs.preview || content?.inlines.map(part => part.text).join('').slice(0, 160) || '▣'}` : (node.attrs.preview || content?.inlines.map(part => part.text).join('').slice(0, 160) || '▣')
        const editable = editor.isEditable && content !== null && content.inlines.some(part => part.nodeId) && (content.kind === 'opaque' || marginal)
        const count = editable && content ? content.inlines.filter(part => part.nodeId).length : 0
        while (fields.length > count) fields.pop()?.remove()
        if (!editable || !content) return
        let fieldIndex = 0
        content.inlines.forEach((inline, index) => {
          if (!inline.nodeId) return
          let field = fields[fieldIndex]
          if (!field) {
            field = document.createElement('textarea')
            field.rows = 2
            field.addEventListener('input', () => {
              const pos = getPos()
              const source = current.attrs.hcdContent as BlockContent | null
              if (!editor.isEditable || typeof pos !== 'number' || !source) return
              const next = { ...source, inlines: source.inlines.map((item, itemIndex) => itemIndex === index ? { ...item, text: field?.value || '' } : item) }
              const text = next.inlines.map(item => item.text).join('').slice(0, 160)
              editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, hcdContent: next, preview: text || '▣' }))
            })
            fields.push(field)
            dom.append(field)
          }
          if (document.activeElement !== field && field.value !== inline.text) field.value = inline.text
          field.disabled = false
          fieldIndex += 1
        })
      }
      paint(initial)
      const localeChanged = ({ transaction }: { transaction: { getMeta: (key: string) => unknown } }) => {
        if (transaction.getMeta('hcd-ui-locale')) paint(current)
      }
      editor.on('transaction', localeChanged)
      return {
        destroy() { editor.off('transaction', localeChanged) },
        dom,
        update(node) {
          if (node.type.name !== 'hcdOpaque') return false
          paint(node)
          return true
        },
        stopEvent: () => true,
      }
    }
  },
})

export const schemaExtensions = [StarterKit.configure({ undoRedo: false, codeBlock: false, code: false, link: { openOnClick: false } }), Code.extend({ excludes: 'bold italic underline strike link textColor textBackground textBorder code' }), colorMark('textColor', 'color'), colorMark('textBackground', 'background-color'), borderMark(), TextTypographyMark, SourceIdentity, CodeTypography, HcdIdentity, HcdOpaque]

// A pasted or split block must receive its own HCD identity at the next checkpoint.
export function clearPastedBlockIds(slice: Slice, targetSourceId?: string): Slice {
  const inlinePaste = slice.content.childCount === 1 && (slice.content.firstChild?.isInline || slice.openStart > 0 && slice.openEnd > 0 && slice.content.firstChild?.isTextblock)
  const source = inlinePaste && sourceId.test(targetSourceId || '') ? targetSourceId : null
  const marksFor = (node: PmNode) => {
    const marks = node.marks.filter(mark => mark.type.name !== 'hcdSource').map(mark => mark.type.name === 'textTypography' && mark.attrs.sizePt != null ? mark.type.create({...mark.attrs,explicitSize:true}) : mark)
    const type = node.type.schema.marks.hcdSource
    return source && node.isText && type ? [...marks, type.create({ nodeId: source })] : marks
  }
  const clear = (fragment: Fragment): Fragment => {
    const nodes: PmNode[] = []
    fragment.forEach(node => {
      if (node.isText) { nodes.push(node.mark(marksFor(node))); return }
      const content = clear(node.content)
      nodes.push(node.attrs.hcdBlockId
        ? node.type.create({ ...node.attrs, hcdBlockId: null, hcdSourceId: null, hcdSourceTypography: null, hcdSourceSizeExplicit: false }, content, marksFor(node))
        : node.copy(content).mark(marksFor(node)))
    })
    return Fragment.fromArray(nodes)
  }
  return new Slice(clear(slice.content), slice.openStart, slice.openEnd)
}

function inlineJson(inline: Inline): JSONContent {
  const marks: Array<{ type: string; attrs?: Record<string, unknown> }> = []
  if (sourceId.test(inline.nodeId || '')) marks.push({ type: 'hcdSource', attrs: { nodeId: inline.nodeId } })
  const font = typography(inline.typography)
  if (font) marks.push({ type: 'textTypography', attrs: { ...font, explicitSize: inline.fontSizeExplicit === true } })
  if (inline.bold) marks.push({ type: 'bold' })
  if (inline.italic) marks.push({ type: 'italic' })
  if (inline.underline) marks.push({ type: 'underline' })
  if (inline.strike) marks.push({ type: 'strike' })
  if (inline.code) marks.push({ type: 'code' })
  if (inline.link) marks.push({ type: 'link', attrs: { href: inline.link } })
  if (inline.textColor && hexColor.test(inline.textColor)) marks.push({ type: 'textColor', attrs: { color: inline.textColor } })
  if (inline.backgroundColor && hexColor.test(inline.backgroundColor)) marks.push({ type: 'textBackground', attrs: { color: inline.backgroundColor } })
  if (inline.border && hexColor.test(inline.border.color) && borderStyles.has(inline.border.style)) marks.push({ type: 'textBorder', attrs: { color: inline.border.color, widthPt: inline.border.widthPt, style: inline.border.style } })
  return { type: inline.hardBreak ? 'hardBreak' : 'text', ...(inline.hardBreak ? {} : { text: inline.text }), ...(marks.length ? { marks } : {}) }
}

function contentSourceAttrs(block: BlockContent): Record<string, unknown> {
  const source = block.inlines.find(inline => sourceId.test(inline.nodeId || ''))
  return {hcdSourceId:source?.nodeId ?? null,hcdSourceTypography:source?.typography ?? null,hcdSourceSizeExplicit:source?.fontSizeExplicit === true}
}

function contentJson(block: BlockContent): JSONContent {
  const children = block.children?.map(contentJson) ?? []
  const inlines = block.inlines.filter(part => part.text.length > 0).map(inlineJson)
  if (block.kind === 'heading') return { type: 'heading', attrs: { ...contentSourceAttrs(block),level: block.level || 1 }, content: inlines }
  if (block.kind === 'list_item') return { type: 'listItem', content: children.length ? children : [{ type: 'paragraph', attrs:contentSourceAttrs(block),content: inlines }] }
  if (block.kind === 'code_block') return { type: 'codeBlock', attrs: { ...contentSourceAttrs(block),language: block.language ?? null }, content: block.inlines.filter(part => part.text).map(part => inlineJson({ text: part.text, nodeId: part.nodeId, typography: part.typography, fontSizeExplicit: part.fontSizeExplicit })) }
  if (block.kind === 'blockquote') return { type: 'blockquote', content: children }
  if (block.kind === 'bullet_list' || block.kind === 'ordered_list') return { type: block.kind === 'bullet_list' ? 'bulletList' : 'orderedList', attrs: { start: block.listStart ?? 1 }, content: children }
  if (block.kind === 'horizontal_rule') return { type: 'horizontalRule' }
  return { type: 'paragraph',attrs:contentSourceAttrs(block), content: inlines }
}

function blockJson(block: Block): JSONContent {
  if (block.readOnly || block.content.kind === 'opaque') {
    return { type: 'hcdOpaque', attrs: { hcdBlockId: block.blockId, hcdContent: block.content, hcdRegion: block.region, preview: block.content.inlines.map(part => part.text).join('').slice(0, 160) || '▣' } }
  }
  const node = contentJson(block.content)
  const source = block.content.inlines.find(inline => sourceId.test(inline.nodeId || ''))
  return { ...node, attrs: { ...node.attrs, hcdBlockId: block.blockId,
    hcdSourceId: source?.nodeId ?? null, hcdSourceTypography: source?.typography ?? null, hcdSourceSizeExplicit: source?.fontSizeExplicit === true,
  } }
}

export function projectionToJson(projection: Projection): JSONContent {
  const body = editorSurface(projection.blocks)
  const content: JSONContent[] = []
  let pending: JSONContent | null = null
  for (const block of body) {
    if (!block.readOnly && block.content.kind === 'list_item') {
      const type = block.content.level === 1 ? 'orderedList' : 'bulletList'
      if (!pending || pending.type !== type || (type === 'orderedList' && block.content.listStart != null
          && block.content.listStart !== (pending.attrs?.start ?? 1) + (pending.content?.length ?? 0))) {
        pending = { type, attrs: type === 'orderedList' ? { start: block.content.listStart ?? 1 } : undefined, content: [] }
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
      const textColor = current.marks?.find(mark => mark.type === 'textColor')?.attrs?.color
      const backgroundColor = current.marks?.find(mark => mark.type === 'textBackground')?.attrs?.color
      const borderAttrs = current.marks?.find(mark => mark.type === 'textBorder')?.attrs
      const borderColor = borderAttrs?.color
      const borderStyle = borderAttrs?.style
      const borderWidth = Number(borderAttrs?.widthPt)
      const border: InlineBorder | null = typeof borderColor === 'string' && hexColor.test(borderColor) && typeof borderStyle === 'string' && borderStyles.has(borderStyle) && borderWidth > 0 && borderWidth <= 12
        ? { color: borderColor, widthPt: borderWidth, style: borderStyle as InlineBorder['style'] }
        : null
      result.push({
        ...(sourceId.test(current.marks?.find(mark => mark.type === 'hcdSource')?.attrs?.nodeId || '') ? { nodeId: current.marks!.find(mark => mark.type === 'hcdSource')!.attrs!.nodeId } : {}),
        ...(current.marks?.find(mark => mark.type === 'textTypography')?.attrs?.explicitSize === true ? { fontSizeExplicit: true } : {}),
        underline: current.marks?.some(mark => mark.type === 'underline') || false,
        strike: current.marks?.some(mark => mark.type === 'strike') || false,
        code: current.marks?.some(mark => mark.type === 'code') || false,
        hardBreak: false,
        text: current.text || '',
        bold: current.marks?.some(mark => mark.type === 'bold') || false,
        italic: current.marks?.some(mark => mark.type === 'italic') || false,
        link: current.marks?.find(mark => mark.type === 'link')?.attrs?.href || null,
        textColor: typeof textColor === 'string' && hexColor.test(textColor) ? textColor : null,
        backgroundColor: typeof backgroundColor === 'string' && hexColor.test(backgroundColor) ? backgroundColor : null,
        border,
        typography: typography(current.marks?.find(mark => mark.type === 'textTypography')?.attrs),
      })
    }
    if (current.type === 'hardBreak') result.push({ text: '\n', hardBreak: true, typography: typography(current.marks?.find(mark => mark.type === 'textTypography')?.attrs) })
    else if (current.type !== 'text') throw new Error(`Unsupported inline node: ${current.type}`)
  }
  node.content?.forEach(walk)
  return result
}

function nodeContent(node: JSONContent): BlockContent {
  if (node.type === 'paragraph' || node.type === 'heading') return { kind: node.type, ...(node.type === 'heading' ? { level: node.attrs?.level || 1 } : {}), inlines: inlinesFromNode(node) }
  if (node.type === 'listItem') {
    const simple = node.content?.length === 1 && node.content[0].type === 'paragraph'
    return { kind: 'list_item', level: 0, inlines: simple ? inlinesFromNode(node.content![0]) : [], ...(simple ? {} : { children: node.content?.map(nodeContent) ?? [] }) }
  }
  if (node.type === 'codeBlock') return { kind: 'code_block', inlines: inlinesFromNode(node), ...(node.attrs?.language ? { language: node.attrs.language } : {}) }
  if (node.type === 'blockquote' || node.type === 'bulletList' || node.type === 'orderedList') return {
    kind: node.type === 'blockquote' ? 'blockquote' : node.type === 'bulletList' ? 'bullet_list' : 'ordered_list',
    inlines: [], children: node.content?.map(nodeContent) ?? [],
    ...(node.type === 'orderedList' ? { listStart: node.attrs?.start ?? 1 } : {}),
  }
  if (node.type === 'horizontalRule') return { kind: 'horizontal_rule', inlines: [] }
  throw new Error(`Unsupported block node: ${node.type}`)
}

export function jsonToSnapshot(json: JSONContent): Array<{ blockId: string | null; content: BlockContent }> {
  const result: Array<{ blockId: string | null; content: BlockContent }> = []
  const push = (node: JSONContent) => {
    result.push({ blockId: node.attrs?.hcdBlockId || null, content: node.type === 'hcdOpaque'
      ? node.attrs?.hcdContent || { kind: 'opaque', inlines: [] }
      : nodeContent(node) })
  }
  for (const node of json.content || []) {
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      for (const [index, item] of (node.content ?? []).entries()) {
        if (item.type !== 'listItem') throw new Error('List contains a non-list item')
        push(item)
        result[result.length - 1].content.level = node.type === 'orderedList' ? 1 : 0
        if (node.type === 'orderedList') result[result.length - 1].content.listStart = (node.attrs?.start ?? 1) + index
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
