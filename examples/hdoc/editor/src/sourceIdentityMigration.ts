import * as Y from 'yjs'
import type { JSONContent } from '@tiptap/core'
import { editorSurface, jsonToSnapshot, projectionToJson, type Block, type BlockContent, type Projection } from './schema.ts'
import { typography } from './typography.ts'
import { yBlocks } from './typographyMigration.ts'

const sourceId = /^n_[0-9a-f]{32}$/
const parts = (content: BlockContent): BlockContent['inlines'] => [...content.inlines, ...(content.children || []).flatMap(parts)]

function blockJsons(projection: Projection): JSONContent[] {
  return (projectionToJson(projection).content || []).flatMap(node => node.type === 'bulletList' || node.type === 'orderedList' ? node.content || [] : [node])
}

function defaultActions(node: Y.XmlElement, expected: JSONContent, actions: Array<() => void>, depth = 0): void {
  if (depth > 128 || node.nodeName !== expected.type || ['level','language','start'].some(key => (node.getAttribute(key) ?? null) !== (expected.attrs?.[key] ?? null))) throw new Error('Source block structure differs; retain draft for recovery')
  const children = node.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement)
  const expectedChildren = (expected.content || []).filter(child => child.type !== 'text')
  if (children.length !== expectedChildren.length) throw new Error('Source block structure differs; retain draft for recovery')
  for (const key of ['hcdSourceId','hcdSourceTypography','hcdSourceSizeExplicit']) {
    if (expected.attrs && Object.hasOwn(expected.attrs,key)) actions.push(()=>node.setAttribute(key,expected.attrs![key] as never))
  }
  children.forEach((child,index)=>defaultActions(child,expectedChildren[index],actions,depth+1))
}

/** The previous signed protocol had neither ordinary text IDs nor the explicit
 * size bit. Opaque source IDs were already part of its digest and must remain. */
export function legacySnapshot(json: JSONContent) {
  const cleanContent = (content: BlockContent): BlockContent => ({ ...content,
    inlines: content.inlines.map(({ fontSizeExplicit: _explicit, ...inline }) => inline),
    ...(content.children ? { children: content.children.map(cleanContent) } : {}),
  })
  const clean = (node: JSONContent): JSONContent => ({ ...node,
    ...(node.type === 'hcdOpaque' && node.attrs?.hcdContent ? { attrs: { ...node.attrs, hcdContent: cleanContent(node.attrs.hcdContent) } } : {}),
    ...(node.marks ? { marks: node.marks.filter(mark => mark.type !== 'hcdSource').map(mark => {
      if (mark.type !== 'textTypography' || !mark.attrs) return mark
      const { explicitSize: _explicit, ...attrs } = mark.attrs
      return { ...mark, attrs }
    }) } : {}),
    ...(node.content ? { content: node.content.map(clean) } : {}),
  })
  return jsonToSnapshot(clean(json))
}

/** Only infer missing identities against an already verified immutable base.
 * Existing pending text which cannot be matched stays untouched for recovery.
 * Validate all actions before applying any, retaining CRDT items and marks. */
export function upgradeSourceIdentity(document: Y.Doc, projection: Projection, legacyBase = false): void {
  const metadata = document.getMap('hcdSchema')
  const version = metadata.get('sourceIdentity')
  if (version === 1 && !legacyBase) return
  if (version !== undefined && version !== 1) throw new Error('Unsupported source identity protocol')
  const blocks = yBlocks(document), canonical = editorSurface(projection.blocks)
  const expectedBlocks = blockJsons(projection)
  if (blocks.length !== canonical.length) throw new Error('Legacy block structure differs; retain draft for recovery')
  const actions: Array<() => void> = []
  let work = 0
  for (const [index, node] of blocks.entries()) {
    const block = canonical[index]
    if (node.getAttribute('hcdBlockId') !== block.blockId) throw new Error('Legacy block identity differs; retain draft for recovery')
    const source = parts(block.content)
    if (node.nodeName === 'hcdOpaque') {
      const content = node.getAttribute('hcdContent') as unknown as BlockContent | undefined
      if (!content) throw new Error('Legacy opaque content is absent')
      const known = new Map(source.filter(part => part.nodeId).map(part => [part.nodeId, part]))
      const upgrade = (content: BlockContent): BlockContent => ({ ...content, inlines: content.inlines.map(part => {
        if (!part.nodeId) return part
        const original = known.get(part.nodeId)
        if (!original) throw new Error('Legacy opaque source identity differs; retain draft for recovery')
        const size = typography(part.typography)?.sizePt
        return { ...part, ...(size != null && (size !== typography(original.typography)?.sizePt || original.fontSizeExplicit) ? { fontSizeExplicit: true } : {}) }
      }), ...(content.children ? { children: content.children.map(upgrade) } : {}) })
      const upgraded = upgrade(content)
      actions.push(() => node.setAttribute('hcdContent', upgraded as never))
      continue
    }
    defaultActions(node,expectedBlocks[index],actions)
    const leaves: Array<{ leaf?: Y.XmlText; text: string }> = []
    const collect = (parent: Y.XmlElement, depth = 0) => {
      if (depth > 128) throw new Error('Legacy source nesting exceeds limit')
      for (const child of parent.toArray()) {
        if (++work > 1_000_000) throw new Error('Legacy source work exceeds limit')
        if (child instanceof Y.XmlText) leaves.push({ leaf: child, text: child.toDelta().map((item: { insert: unknown }) => {
          if (typeof item.insert !== 'string') throw new Error('Legacy embedded text cannot be assigned a source')
          return item.insert
        }).join('') })
        else if (child instanceof Y.XmlElement && child.nodeName === 'hardBreak') leaves.push({ text: '\n' })
        else if (child instanceof Y.XmlElement) collect(child, depth + 1)
        else throw new Error('Unsupported legacy source element')
      }
    }
    collect(node)
    const currentText = leaves.map(item => item.text).join(''), canonicalText = source.map(part => part.text).join('')
    const expected = expectedBlocks[index]
    const simple = ['paragraph','heading','codeBlock'].includes(expected.type || '') || expected.type === 'listItem' && expected.content?.length === 1 && expected.content[0].type === 'paragraph'
    const single = simple && source.length > 0 && sourceId.test(source[0].nodeId || '') && leaves.every(item=>item.leaf)
      && source.every(part=>part.nodeId === source[0].nodeId && JSON.stringify(typography(part.typography)) === JSON.stringify(typography(source[0].typography)) && !!part.fontSizeExplicit === !!source[0].fontSizeExplicit)
    if (currentText !== canonicalText && !single) throw new Error('Legacy pending text differs; retain draft for recovery')
    let sourceEnd = 0
    const ranges = currentText !== canonicalText
      ? [{start:0,end:currentText.length,part:source[0]}].filter(range=>range.end>0)
      : source.map(part => { const start = sourceEnd; sourceEnd += part.text.length; return {start,end:sourceEnd,part} }).filter(range=>range.end>range.start)
    let leafStart = 0, partIndex = 0
    const scalarBoundary = (text: string, offset: number) => !(offset>0 && offset<text.length && /[\uD800-\uDBFF]/.test(text[offset-1]) && /[\uDC00-\uDFFF]/.test(text[offset]))
    for (const { leaf, text } of leaves) {
      if (leaf) {
        let deltaStart = leafStart
        for (const delta of leaf.toDelta() as Array<{insert:string;attributes?:Record<string,unknown>}>) {
          const deltaEnd = deltaStart + delta.insert.length
          let position = deltaStart
          while (position < deltaEnd) {
            if (++work > 1_000_000) throw new Error('Legacy source work exceeds limit')
            while (partIndex < ranges.length && ranges[partIndex].end <= position) partIndex++
            const range = ranges[partIndex]
            if (!range || range.start > position) throw new Error('Legacy source range is absent')
            const finish = Math.min(deltaEnd,range.end), offset = position-leafStart, count = finish-position
            if (!scalarBoundary(text,offset) || !scalarBoundary(text,offset+count)) throw new Error('Legacy font range splits a surrogate pair; retain draft for recovery')
            const source = sourceId.test(range.part.nodeId || '') ? {nodeId:range.part.nodeId} : null
            actions.push(()=>leaf.format(offset,count,{hcdSource:source}))
            const font = typography(delta.attributes?.textTypography)
            if (font) {
              const current = delta.attributes?.textTypography as {explicitSize?:unknown} | undefined
              const explicitSize = font.sizePt != null && (current?.explicitSize === true || font.sizePt !== typography(range.part.typography)?.sizePt || range.part.fontSizeExplicit === true)
              actions.push(()=>leaf.format(offset,count,{textTypography:{...font,explicitSize}}))
            }
            position = finish
          }
          deltaStart = deltaEnd
        }
      }
      leafStart += text.length
    }
  }
  document.transact(() => {
    actions.forEach(action => action())
    metadata.set('sourceIdentity', 1)
  }, 'hcd-source-identity-migration')
}

/** A structural checkpoint can assign new canonical source IDs. Clear only
 * obsolete receipts on surviving captured blocks, never replace their text or
 * formatting: the user may have kept typing while the save was in flight. */
export function reconcileSourceIdentities(document: Y.Doc, captured: Y.XmlElement[], canonical: Block[], origin: unknown): void {
  const live = new Set(yBlocks(document))
  let work = 0
  const actions: Array<() => void> = []
  const expectedBlocks = blockJsons({documentId:'receipt',revision:0,blocks:canonical})
  captured.forEach((node, index) => {
    if (!live.has(node)) return
    const block = canonical[index], source = parts(block.content)
    const allowed = new Set(source.map(part => part.nodeId).filter(Boolean))
    actions.push(() => {
      if (node.getAttribute('hcdBlockId') !== block.blockId) node.setAttribute('hcdBlockId', block.blockId)
    })
    if (node.nodeName !== 'hcdOpaque') {
      const defaults: Array<()=>void> = []
      try { defaultActions(node,expectedBlocks[index],defaults); actions.push(...defaults) }
      catch { /* A newer structural edit remains in the live CRDT. */ }
    }
    const visit = (parent: Y.XmlElement, depth = 0) => {
      if (depth > 128) throw new Error('Saved source nesting exceeds limit')
      for (const child of parent.toArray()) {
        if (++work > 1_000_000) throw new Error('Saved source work exceeds limit')
        if (child instanceof Y.XmlText) {
          let start = 0
          for (const delta of child.toDelta() as Array<{ insert: string; attributes?: { hcdSource?: {nodeId?: string} } }>) {
            if (typeof delta.insert !== 'string') throw new Error('Unsupported source text')
            const offset = start, count = delta.insert.length, id = delta.attributes?.hcdSource?.nodeId
            if (id && !allowed.has(id)) actions.push(() => child.format(offset, count, { hcdSource: null }))
            start += count
          }
        } else if (child instanceof Y.XmlElement) visit(child, depth + 1)
      }
    }
    visit(node)
  })
  document.transact(() => actions.forEach(action => action()), origin)
}
