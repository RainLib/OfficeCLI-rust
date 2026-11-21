import * as Y from 'yjs'
import type { CanvasElement } from './model'

export const specRemote = Symbol('Spec remote')
export type SpecRecord = { version: 1; update: string; blocks: string[] }
type Tagged = {
  officeBoard?: { kind: string; root: string; part?: string }
  officeSpec?: SpecRecord
}
export const specTag = (e: CanvasElement) =>
  (e.customData as Tagged | undefined)?.officeBoard
export function isSpecText(el: CanvasElement) {
  const tag = specTag(el)
  return el.type === 'text' && tag?.kind === 'spec' && (tag.part === 'title' || tag.part === 'body')
}
export const specRecord = (e?: CanvasElement) =>
  (e?.customData as Tagged | undefined)?.officeSpec
export const toBase64 = (bytes: Uint8Array) => {
  let value = ''
  for (let start = 0; start < bytes.length; start += 8192)
    value += String.fromCharCode(...bytes.subarray(start, start + 8192))
  return btoa(value)
}
export const fromBase64 = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
export function decodeSpec(encoded: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, fromBase64(encoded), specRemote)
  return doc
}
export function openSpec(el?: CanvasElement) {
  const existing = specRecord(el)
  if (existing) return decodeSpec(existing.update)
  const document = new Y.Doc()
  const text = String(el?.originalText ?? el?.text ?? '')
  const seed = new Y.Doc()
  seed.clientID = 1
  const fragment = seed.getXmlFragment('spec')
  seed.transact(() => {
    for (const line of (text === ' ' ? '' : text).split('\n')) {
      const p = new Y.XmlElement('paragraph')
      fragment.push([p])
      if (line) {
        const run = new Y.XmlText()
        p.push([run])
        run.insert(0, line)
      }
    }
  })
  Y.applyUpdate(document, Y.encodeStateAsUpdate(seed), specRemote)
  seed.destroy()
  return document
}
export const isTextBlock = (name: string) =>
  name === 'paragraph' || name === 'heading' || name === 'codeBlock'
export function specBlocks(doc: Y.Doc) {
  const blocks: string[] = []
  function visit(node: Y.XmlElement | Y.XmlText | Y.XmlHook) {
    if (!(node instanceof Y.XmlElement)) return
    if (isTextBlock(node.nodeName)) {
      blocks.push(
        node
          .toArray()
          .map((child) =>
            child instanceof Y.XmlText
              ? child
                  .toDelta()
                  .map((run: { insert: string }) => run.insert)
                  .join('')
              : '',
          )
          .join(''),
      )
      return
    }
    node.toArray().forEach((child) => {
      if (child instanceof Y.XmlElement) visit(child)
    })
  }
  doc.getXmlFragment('spec').toArray().forEach(visit)
  return blocks
}
export function specSnapshot(doc: Y.Doc): SpecRecord {
  return {
    version: 1,
    update: toBase64(Y.encodeStateAsUpdate(doc)),
    blocks: specBlocks(doc),
  }
}
export function optimisticSpec(el: CanvasElement, delta: string) {
  const doc = openSpec(el)
  try {
    Y.applyUpdate(doc, fromBase64(delta), specRemote)
    const stored = specSnapshot(doc),
      text = stored.blocks.join('\n') || ' '
    return {
      ...el,
      text,
      originalText: text,
      height:
        Math.max(1, text.split('\n').length) *
        Number(el.fontSize || 17) *
        Number(el.lineHeight || 1.25),
      customData: { ...(el.customData as Tagged), officeSpec: stored },
    }
  } finally {
    doc.destroy()
  }
}
export function mergeSpecUpdates(first: string, second: string) {
  return toBase64(Y.mergeUpdates([fromBase64(first), fromBase64(second)]))
}
export function changeTitle(doc: Y.Doc, value: string) {
  const frag = doc.getXmlFragment('spec'),
    prior = specBlocks(doc)[0] || ''
  const old = Array.from(prior),
    next = Array.from(value)
  let start = 0,
    last = 0
  while (
    start < old.length &&
    start < next.length &&
    old[start] === next[start]
  )
    start++
  while (
    last < old.length - start &&
    last < next.length - start &&
    old[old.length - last - 1] === next[next.length - last - 1]
  )
    last++
  if (start === old.length && start === next.length) return
  doc.transact(() => {
    let p = frag.get(0) as Y.XmlElement | undefined
    if (!p) {
      p = new Y.XmlElement('paragraph')
      frag.push([p])
    }
    let run = p.get(0) as Y.XmlText | undefined
    if (!run) {
      run = new Y.XmlText()
      p.push([run])
    }
    const pos = old.slice(0, start).join('').length,
      remove = old.slice(start, old.length - last).join('').length
    if (remove) run.delete(pos, remove)
    const added = next.slice(start, next.length - last).join('')
    if (added) run.insert(pos, added)
  })
}
