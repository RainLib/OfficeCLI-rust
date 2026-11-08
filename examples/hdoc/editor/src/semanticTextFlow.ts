import {referenceEditIndex,storageReferenceNode} from './referenceEdits.ts'
import {extensionEditIndex,storageExtensionNode} from './extensionEdits.ts'
import * as Y from 'yjs'
import {Fragment, type Node as PmNode, type Schema} from '@tiptap/pm/model'
import {readSemanticInline, writeSemanticInline, validateSemanticSplice, validateSemanticEdits, writeSemanticEdits, type SemanticInlineEdit, type SemanticInlineSplice, type SemanticInlineDelta, type SemanticInlineText} from './semanticInlineContent.ts'
import type {SemanticInlineContainers,InlineContainerEdits} from './semanticInlineContainers.ts'

export const textFlowFields = {
  metadata: 'hcd-text-flow/1/meta',
  segments: 'hcd-text-flow/1/segments',
  links: 'hcd-text-flow/1/links',
  order: 'hcd-text-flow/1/order',
} as const
export const textFlowOrigin = Object.freeze({kind: 'hcd-text-flow-edit/1'})
const allocationOrigin = Object.freeze({kind: 'hcd-text-flow-allocation/1'})
type Relative = ReturnType<typeof Y.relativePositionToJSON>
type Segment = {carrier: string; boundary?: Relative; route?: string[]}
type Link = {parent: string; reference: string}
type Reference = Link & {key: string}
export type TextFlowPart = {key: string; carrier: string; from: number; to: number}
type Layout = {parts: Map<string, TextFlowPart>; parents: Map<string, string>; children: Map<string, string[]>}
export type TextFlowPoint = {carrier: string; relative: Relative}
const documentVersions = new WeakMap<Y.Doc, {version: number}>()
function documentVersion(document: Y.Doc) {
  let state = documentVersions.get(document)
  if (!state) {
    state = {version: 0}; documentVersions.set(document, state)
    const shared = state, invalidate = () => { shared.version++ }
    // One watcher per document, not one retained listener per editor instance.
    document.on('beforeTransaction', invalidate)
    document.on('beforeObserverCalls', invalidate)
  }
  return state
}
const boundary = (key: string) => ({hcdTextBoundary: {version: 1, key}})
function boundaryKey(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('hcdTextBoundary' in value)) return null
  const candidate = value.hcdTextBoundary as {version?: unknown; key?: unknown}
  if (Object.keys(value).length !== 1 || !candidate || candidate.version !== 1 ||
      typeof candidate.key !== 'string' || candidate.key.length > 256 || Object.keys(candidate).length !== 2) {
    throw new Error('invalidTextBoundary')
  }
  return candidate.key
}

/** Explicit experimental text layer. It uses the supplied permanent carriers as
 * its ONLY body storage. No active room is initialized or migrated by reading.
 * Splits insert invisible boundaries; joins link flows, never copy their text. */
export class SemanticTextFlow {
  readonly metadata: Y.Map<unknown>
  readonly segments: Y.Map<Segment>
  readonly links: Y.Map<Link>
  readonly order: Y.Array<Reference>
  private cached?: {version: number; layout: Layout}
  private readonly revision: {version: number}

  constructor(readonly document: Y.Doc, readonly carriers: Y.Map<Y.XmlFragment>, readonly schema: Schema,
    readonly origin: unknown = textFlowOrigin, readonly containers?:SemanticInlineContainers) {
    if(containers&&(carriers.doc!==document||containers.document!==document||containers.schema!==schema||containers.origin!==origin))throw new Error('inlineContainerFlowMismatch')
    this.metadata = document.getMap(textFlowFields.metadata)
    this.segments = document.getMap(textFlowFields.segments)
    this.links = document.getMap(textFlowFields.links)
    this.order = document.getArray(textFlowFields.order)
    this.revision = documentVersion(document)
  }
  get initialized() { return this.metadata.get('version') === 1 }
  private ready() { if (!this.initialized) throw new Error('uninitializedTextFlow') }
  private text(carrier: string): Y.XmlText {
    const fragment = this.carriers.get(carrier), text = fragment?.get(0)
    if (!(fragment instanceof Y.XmlFragment) || fragment.length !== 1 || !(text instanceof Y.XmlText)) {
      throw new Error('invalidTextCarrier')
    }
    return text
  }
  initialize(keys: readonly string[]) {
    if (this.metadata.size || this.segments.size || this.links.size || this.order.length) throw new Error('alreadyInitializedTextFlow')
    if (new Set(keys).size !== keys.length) throw new Error('duplicateTextCarrier')
    // Validate every carrier before changing any shared metadata.
    keys.forEach(key => this.containers?this.containers.readText(this.text(key)):readSemanticInline(this.text(key), this.schema))
    this.document.transact(() => {
      keys.forEach(key => this.segments.set(key, {carrier: key}))
      this.metadata.set('version', 1)
    }, allocationOrigin)
  }
  register(key: string) {
    this.ready()
    if (this.segments.has(key)) throw new Error('duplicateTextSegment')
    if(this.containers)this.containers.readText(this.text(key));else readSemanticInline(this.text(key), this.schema)
    this.segments.set(key, {carrier: key})
  }
  private layout(): Layout {
    this.ready()
    // Yjs exposes the active transaction in its Doc type. Do not reuse a
    // layout between direct carrier mutations inside the same transaction.
    if (!this.document._transaction && this.cached?.version === this.revision.version) return this.cached.layout
    const parts = new Map<string, TextFlowPart>(), scanned = new Set<string>()
    for (const [key, record] of this.segments) {
      if (!record || typeof record.carrier !== 'string' || key.length > 256) throw new Error('invalidTextSegment')
      if (scanned.has(record.carrier)) continue
      scanned.add(record.carrier)
      const initial = this.segments.get(record.carrier)
      if (!initial || initial.carrier !== record.carrier || initial.boundary) throw new Error('invalidTextSegment')
      let offset = 0, part: TextFlowPart = {key: record.carrier, carrier: record.carrier, from: 0, to: 0}
      parts.set(part.key, part)
      for (const delta of this.text(record.carrier).toDelta()) {
        const marker = boundaryKey(delta.insert)
        if (marker) {
          const definition = this.segments.get(marker)
          if (!definition || definition.carrier !== record.carrier || !definition.boundary || parts.has(marker)) throw new Error('invalidTextBoundary')
          part.to = offset
          part = {key: marker, carrier: record.carrier, from: offset + 1, to: offset + 1}
          parts.set(marker, part)
        }
        offset += typeof delta.insert === 'string' ? delta.insert.length : 1
      }
      part.to = offset
    }
    const parents = new Map<string, string>(), references = new Set(this.order.toArray().map(ref => JSON.stringify(ref)))
    for (const key of parts.keys()) {
      const link = this.links.get(key)
      if (!link) continue
      if (typeof link.parent !== 'string' || typeof link.reference !== 'string' ||
          !references.has(JSON.stringify({key, parent: link.parent, reference: link.reference}))) throw new Error('invalidTextLink')
      const parent = this.resolveSegment(link.parent, parts)
      if (parent !== key) parents.set(key, parent)
    }
    // Concurrent opposite joins can create a cycle. Break exactly one edge at
    // the stable minimum key, retaining every segment in the resulting flow.
    const done = new Set<string>()
    for (const key of parts.keys()) {
      let at: string | undefined = key
      const path: string[] = [], indices = new Map<string, number>()
      while (at !== undefined && !done.has(at)) {
        const cycle = indices.get(at)
        if (cycle !== undefined) { parents.delete(path.slice(cycle).sort()[0]); break }
        indices.set(at, path.length); path.push(at); at = parents.get(at)
      }
      path.forEach(item => done.add(item))
    }
    const children = new Map<string, string[]>()
    for (const reference of this.order.toArray()) {
      const link = this.links.get(reference.key)
      if (!parts.has(reference.key) || link?.reference !== reference.reference) continue
      const parent = parents.get(reference.key)
      if (!parent) continue
      const list = children.get(parent) ?? []
      if (list.includes(reference.key)) throw new Error('duplicateTextLink')
      list.push(reference.key); children.set(parent, list)
    }
    const layout = {parts, parents, children}
    if (!this.document._transaction) this.cached = {version: this.revision.version, layout}
    return layout
  }
  private resolveSegment(key: string, parts: Map<string, TextFlowPart>): string {
    if (parts.has(key)) return key
    const record = this.segments.get(key)
    if (!record?.boundary) throw new Error('missingTextSegment')
    const absolute = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(record.boundary), this.document)
    if (!absolute || absolute.type !== this.text(record.carrier)) throw new Error('invalidTextBoundary')
    // Undo can remove a split marker while a peer has joined another flow to
    // it. Route that peer's link to the still-live interval at the old boundary.
    const previous = [...parts.values()].filter(part => part.carrier === record.carrier && part.from <= absolute.index).at(-1)
    if (!previous) throw new Error('missingTextSegment')
    return previous.key
  }
  private root(key: string, layout: Layout) {
    let result = this.resolveSegment(key, layout.parts)
    while (layout.parents.has(result)) result = layout.parents.get(result)!
    return result
  }
  rootFor(key: string) { const layout = this.layout(); return this.root(key, layout) }
  roots() { const layout = this.layout(); return [...layout.parts.keys()].filter(key => !layout.parents.has(key)) }
  private ordered(root: string, layout: Layout): TextFlowPart[] {
    if (!layout.parts.has(root) || layout.parents.has(root)) throw new Error('notTextFlowRoot')
    const result: TextFlowPart[] = [], pending = [root]
    while (pending.length) {
      const key = pending.pop()!
      result.push(layout.parts.get(key)!)
      pending.push(...[...(layout.children.get(key) ?? [])].reverse())
    }
    return result
  }
  parts(root: string) { return this.ordered(root, this.layout()) }
  private delta(root: string): SemanticInlineDelta[] {
    const result: SemanticInlineDelta[] = []
    for (const part of this.parts(root)) {
      let offset = 0
      for (const delta of this.text(part.carrier).toDelta()) {
        const length = typeof delta.insert === 'string' ? delta.insert.length : 1
        const from = Math.max(part.from, offset), to = Math.min(part.to, offset + length)
        if (to > from) result.push({...delta, insert: typeof delta.insert === 'string' ? delta.insert.slice(from - offset, to - offset) : delta.insert})
        offset += length
      }
    }
    return result
  }
  private ranges(root: string, index: number, length: number) {
    if (!Number.isInteger(index) || !Number.isInteger(length) || index < 0 || length < 0) throw new Error('invalidTextRange')
    const result: Array<{text: Y.XmlText; index: number; length: number}> = []
    let offset = 0
    for (const part of this.parts(root)) {
      const size = part.to - part.from, from = Math.max(index, offset), to = Math.min(index + length, offset + size)
      if (to > from) result.push({text: this.text(part.carrier), index: part.from + from - offset, length: to - from})
      offset += size
    }
    if (index + length > offset) throw new Error('invalidTextRange')
    return result
  }
  private position(root: string, index: number) {
    if (!Number.isInteger(index) || index < 0) throw new Error('invalidTextRange')
    const parts = this.parts(root)
    let offset = 0
    for (const part of parts) {
      const size = part.to - part.from
      if (index <= offset + size) return {part, index: part.from + index - offset}
      offset += size
    }
    throw new Error('invalidTextRange')
  }
  private adapter(root: string): SemanticInlineText {
    const remove = (index: number, length: number) => {
      const ranges = this.ranges(root, index, length)
      // Logical flow order can differ from physical order within one carrier.
      // Delete from the highest physical offset in each carrier first.
      const grouped = new Map<Y.XmlText, typeof ranges>()
      ranges.forEach(range => { const list = grouped.get(range.text) ?? []; list.push(range); grouped.set(range.text, list) })
      grouped.forEach(list => list.sort((a, b) => b.index - a.index).forEach(range => range.text.delete(range.index, range.length)))
    }
    return {
      toDelta: () => this.delta(root),
      delete: remove,
      applyDelta: delta => {
        let offset = 0
        for (const operation of delta) {
          if (operation.retain !== undefined) {
            if (operation.attributes) this.ranges(root, offset, operation.retain).forEach(range => range.text.format(range.index, range.length, operation.attributes!))
            offset += operation.retain
          }
          if (operation.delete !== undefined) remove(offset, operation.delete)
          if (operation.insert !== undefined) {
            const position = this.position(root, offset), text = this.text(position.part.carrier)
            if (typeof operation.insert === 'string') text.insert(position.index, operation.insert, operation.attributes ?? {})
            else text.insertEmbed(position.index, operation.insert, operation.attributes ?? {})
            offset += typeof operation.insert === 'string' ? operation.insert.length : 1
          }
        }
      },
    }
  }
  read(root: string): Fragment { return this.containers?this.containers.readText(this.adapter(root)):readSemanticInline(this.adapter(root), this.schema) }
  validateSplice(root:string,node:PmNode,splice:SemanticInlineSplice){
    if(this.containers)throw new Error('unsupportedContainerTextSplice')
    const edits=extensionEditIndex(this.document),references=referenceEditIndex(this.document)
    validateSemanticSplice(this.adapter(root),node,splice,value=>storageReferenceNode(storageExtensionNode(value,edits),references))
  }
  validateEdits(root:string,node:PmNode,operations:readonly SemanticInlineEdit[],bodies:readonly InlineContainerEdits[]=[]){
    const edits=extensionEditIndex(this.document),references=referenceEditIndex(this.document)
    const storage=(value:Record<string,unknown>)=>storageReferenceNode(storageExtensionNode(value,edits),references)
    if(this.containers)this.containers.validateTextEdits(this.adapter(root),node,operations,bodies,storage)
    else{if(bodies.length)throw new Error('unsupportedContainerTextEdits');validateSemanticEdits(this.adapter(root),node,operations,storage)}
  }
  writeEdits(root:string,node:PmNode,operations:readonly SemanticInlineEdit[],bodies:readonly InlineContainerEdits[]=[]){
    this.validateEdits(root,node,operations,bodies)
    const edits=extensionEditIndex(this.document),references=referenceEditIndex(this.document)
    const storage=(value:Record<string,unknown>)=>storageReferenceNode(storageExtensionNode(value,edits),references)
    if(this.containers)this.containers.writeTextEdits(this.adapter(root),node,operations,bodies,storage)
    else this.document.transact(()=>writeSemanticEdits(this.adapter(root),node,operations,storage),this.origin)
  }
  write(root: string, node: PmNode,splice?:SemanticInlineSplice) {
    const edits=extensionEditIndex(this.document),references=referenceEditIndex(this.document)
    const storage=(value:Record<string,unknown>)=>storageReferenceNode(storageExtensionNode(value,edits),references)
    if(splice)this.validateSplice(root,node,splice)
    if(this.containers)this.containers.writeText(this.adapter(root),this.read(root),node,storage)
    else this.document.transact(() => writeSemanticInline(this.adapter(root), node,storage,undefined,splice), this.origin)
  }
  private attach(key: string, parent: string) {
    const reference = crypto.randomUUID()
    this.order.push([{key, parent, reference}]); this.links.set(key, {parent, reference})
  }
  join(target: string, source: string, separator = '') {
    if (target === source) throw new Error('sameTextFlow')
    const layout = this.layout(), targetParts = this.ordered(target, layout)
    this.ordered(source, layout)
    const last = targetParts.at(-1)!
    this.document.transact(() => {
      if (separator) this.text(last.carrier).insert(last.to, separator, {})
      this.attach(source, last.key)
    }, this.origin)
  }
  split(root: string, index: number, key: string) {
    if (!key || key.length > 256 || this.segments.has(key)) throw new Error('duplicateTextSegment')
    const location=this.containers?.locate(this.adapter(root),index)
    // A paragraph boundary cannot cut an inline subtree in half. The editor
    // must choose an explicit container operation (or an internal soft break).
    if(location?.containerId)throw new Error('cannotSplitInlineContainer')
    const layout = this.layout(), ordered = this.ordered(root, layout), position = this.position(root, location?.offset??index)
    const at = ordered.findIndex(part => part.key === position.part.key), prefix = new Set(ordered.slice(0, at + 1).map(part => part.key))
    const frontier = ordered.slice(at + 1).filter(part => prefix.has(layout.parents.get(part.key)!))
    const route = [...(this.segments.get(root)?.route ?? [])], edges: string[] = []
    for (let at = position.part.key; at !== root; at = layout.parents.get(at)!) edges.unshift(this.links.get(at)!.reference)
    route.push(...edges)
    this.document.transact(() => {
      const text = this.text(position.part.carrier)
      text.insertEmbed(position.index, boundary(key), {})
      this.segments.set(key, {carrier: position.part.carrier, boundary: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, position.index, 0)), route})
      frontier.forEach(part => this.attach(part.key, key))
    }, this.origin)
  }
  compareBoundaries(a: string, b: string) {
    const left = this.segments.get(a), right = this.segments.get(b)
    if (!left?.boundary || !right?.boundary) return a < b ? -1 : a === b ? 0 : 1
    const l = left.route ?? [], r = right.route ?? [], references = new Map(this.order.toArray().map((ref, index) => [ref.reference, index]))
    for (let index = 0; index < Math.min(l.length, r.length); index++) {
      if (l[index] !== r[index]) return (references.get(l[index]) ?? -1) - (references.get(r[index]) ?? -1) || l[index].localeCompare(r[index])
    }
    if (l.length !== r.length) return l.length - r.length
    if (left.carrier === right.carrier) {
      const la = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(left.boundary), this.document)
      const ra = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(right.boundary), this.document)
      if (la && ra && la.index !== ra.index) return la.index - ra.index
    }
    return a < b ? -1 : a === b ? 0 : 1
  }
  capture(root: string, index: number, assoc = 0): TextFlowPoint {
    const location=this.containers?.locate(this.adapter(root),index)
    // A body reference at the first position of a joined carrier belongs to
    // that carrier, rather than the preceding carrier's insertion boundary.
    const position=this.position(root,location?location.outerOffset+(location.containerId?1:0):index)
    if(location?.containerId)return{carrier:position.part.carrier,relative:this.containers!.bodyRelative(location.containerId,location.offset,assoc)}
    return {carrier: position.part.carrier, relative: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.text(position.part.carrier), position.index, assoc))}
  }
  resolve(point: TextFlowPoint,visibleRoots?:readonly string[]): {root: string; offset: number} | null {
    const layout = this.layout(), absolute = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(point.relative), this.document)
    const body=this.containers?.relativeBody(point.relative)
    if(body){
      const roots=visibleRoots??[...layout.parts.keys()].filter(root=>!layout.parents.has(root)),matches:Array<{root:string;offset:number}>=[]
      for(const root of new Set(roots)){const offset=this.containers!.projectOffset(this.adapter(root),body.containerId,body.offset);if(offset!==null)matches.push({root,offset})}
      if(matches.length>1)throw new Error('duplicateInlineContainerIdentity')
      return matches[0]??null
    }
    if (!absolute || absolute.type !== this.text(point.carrier)) return null
    const part = [...layout.parts.values()].find(part => part.carrier === point.carrier && absolute.index >= part.from && absolute.index <= part.to)
    if (!part) return null
    const root = this.root(part.key, layout), ordered = this.ordered(root, layout)
    if(visibleRoots&&!visibleRoots.includes(root))return null
    let offset = 0
    for (const current of ordered) {
      if (current.key === part.key){const stored=offset+absolute.index-part.from,projected=this.containers?this.containers.projectOffset(this.adapter(root),null,stored):stored;return projected===null?null:{root,offset:projected}}
      offset += current.to - current.from
    }
    return null
  }
  undoManager() {
    // Segment definitions are immutable recovery metadata. Undo removes a
    // boundary/link, never the metadata needed to route a peer's later join.
    return new Y.UndoManager([this.carriers, this.links, this.order,...(this.containers?[this.containers.bodies]:[])], {trackedOrigins: new Set([this.origin])})
  }
}
