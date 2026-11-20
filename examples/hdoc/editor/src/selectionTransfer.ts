import type { Editor } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Composition, Region } from './canvas/model.ts'
import type { Session } from './api.ts'
import { workspaceIdentity } from './tabState.ts'

export type TextSpan = { blockId: string; start: number; end: number; textHash: string }
export type TransferSelection =
  | { kind: 'document'; spans: TextSpan[] }
  | { kind: 'canvas'; elementIds: string[]; region: Region; revision: number }
export type TransferTarget =
  | { kind: 'existing'; documentId: string; afterBlockId?: string }
  | { kind: 'new'; title: string }
export type TransferLocation =
  | { kind: 'document'; blockIds: string[] }
  | { kind: 'text'; spans: TextSpan[] }
  | { kind: 'canvas'; elementIds: string[]; region?: Region | null }
export type TransferReceipt = { documentId: string; revision: number; location: TransferLocation }
export type TransferDraft =
  | { kind: 'document'; title: string; sections: { heading: string; paragraphs: string[]; bullets: string[]; sources: string[] }[] }
  | { kind: 'canvas'; title: string; sections: { composition: Composition; sources: string[] }[] }
export type TransferRun = {
  id: string; sourceDocumentId: string; sourceRevision: number; target: TransferTarget
  status: 'generating' | 'ready' | 'applied' | 'failed' | 'cancelled' | 'interrupted'
  draft?: TransferDraft | null; error?: string | null; receipt?: TransferReceipt | null; targetToken?: string
}
export type TransferForm = {
  id: string; sourceEpoch: number; selection: TransferSelection; instructions: string
  targetId: string; title: string; afterBlockId: string; submitted?: boolean
}

const textFormats = new Set(['docx', 'md', 'html', 'txt'])
export const supportsTransfer = (session: Session) => !!workspaceIdentity(session) &&
  (session.hostIntegration
    ? textFormats.has(session.format) && ['document.copy', 'document.ai'].every(op => session.operations?.includes(op))
    : textFormats.has(session.format) || session.format === 'excalidraw')

export function sameTransferWorkspace(a: Session, b: Session) {
  const identity = workspaceIdentity(a)
  return !!identity && !!a.hostIntegration === !!b.hostIntegration && JSON.stringify(identity) === JSON.stringify(workspaceIdentity(b))
}

export function transferTarget(source: Session, target: Session) {
  return source.documentId !== target.documentId && sameTransferWorkspace(source, target) && target.scope === 'write'
    && (source.format === 'excalidraw' ? textFormats.has(target.format) : target.format === 'excalidraw')
}

export function decodeTransferLink(link: string) {
  const match = /^#officecli-transfer\/([\w-]{1,128})\/([0-9a-f-]{36})\/([0-5])$/.exec(link)
  return match && { documentId: match[1], id: match[2], section: Number(match[3]) }
}

async function textHash(text: string) {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** ProseMirror offsets count UTF-16 units; HCD uses Unicode scalar offsets
 * into the canonical plain text of each selected semantic block. */
export async function captureDocumentTransfer(editor: Editor, from = editor.state.selection.from, to = editor.state.selection.to) {
  if (from >= to) throw new Error('请先选择需要讲解的正文。')
  const selected: { blockId: string; start: number; text: string }[] = []
  let unsupported = false
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'hcdOpaque') { unsupported = true; return false }
    if (!node.isTextblock && node.type.name !== 'listItem') return true
    const blockId = node.attrs.hcdBlockId
    const start = Math.max(0, from - pos - 1), end = Math.min(node.content.size, to - pos - 1)
    if (end <= start) return false
    const text = node.textBetween(start, end, '')
    if (!text) return false
    if (typeof blockId !== 'string' || !blockId) { unsupported = true; return false }
    selected.push({ blockId, start: Array.from(node.textBetween(0, start, '')).length, text })
    return false
  })
  if (unsupported) throw new Error('请先保存新增段落，或选择已映射的正文文字。')
  if (!selected.length || selected.length > 64) throw new Error('请选择 1 至 64 个有内容的段落。')
  const spans = await Promise.all(selected.map(async ({ blockId, start, text }) => ({
    blockId, start, end: start + Array.from(text).length, textHash: await textHash(text),
  })))
  return { kind: 'document' as const, spans }
}

function textPosition(node: ProseMirrorNode, start: number, scalar: number, isEnd: boolean) {
  let count = 0, result: number | undefined
  node.descendants((child, offset) => {
    if (result !== undefined || !child.isText) return
    const chars = Array.from(child.text || '')
    const within = scalar - count
    if (within >= 0 && (within < chars.length || isEnd && within === chars.length)) {
      result = start + offset + chars.slice(0, within).join('').length
    }
    count += chars.length
  })
  return result
}

export function documentTransferRange(doc: ProseMirrorNode, location: Extract<TransferLocation, { kind: 'document' | 'text' }>) {
  const span = location.kind === 'text' ? location.spans[0] : undefined
  const blockId = location.kind === 'document' ? location.blockIds[0] : span?.blockId
  if (!blockId) throw new Error('找不到需要定位的段落。')
  let selected: { from: number; to: number } | undefined
  doc.descendants((node, pos) => {
    if (node.attrs.hcdBlockId !== blockId) return
    const from = textPosition(node, pos + 1, span?.start ?? 0, false)
    const to = span ? textPosition(node, pos + 1, span.end, true) : from
    if (from !== undefined && to !== undefined) selected = { from, to }
    return false
  })
  if (!selected) throw new Error('选区所在的段落已变化。')
  return selected
}

export function locateDocumentTransfer(editor: Editor, location: Extract<TransferLocation, { kind: 'document' | 'text' }>) {
  const selected = documentTransferRange(editor.state.doc, location)
  const blockId = location.kind === 'document' ? location.blockIds[0] : location.spans[0]?.blockId
  if (!blockId) throw new Error('找不到需要定位的段落。')
  editor.commands.setTextSelection(selected)
  editor.view.dom.querySelector(`[data-hcd-block-id="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' })
}
