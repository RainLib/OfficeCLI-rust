import {
  FileText,
  Grid2x2,
  Presentation,
  Shapes,
  File,
  Image as Picture,
} from 'lucide-react'
import type { HcdEmbedSelection } from '@officecli/hcd-reference-editor/react'
import type { FileEntry } from './hostApi'

export const kinds = {
  doc: {
    label: '文档',
    extension: 'docx',
    icon: FileText,
  },
  sheet: {
    label: '表格',
    extension: 'xlsx',
    icon: Grid2x2,
  },
  deck: {
    label: '演示',
    extension: 'pptx',
    icon: Presentation,
  },
  board: {
    label: '白板',
    extension: 'excalidraw',
    icon: Shapes,
  },
  pdf: {
    label: 'PDF',
    extension: 'pdf',
    icon: File,
  },
  image: {
    label: '图片',
    extension: 'png',
    icon: Picture,
  },
}
export type FileKind = keyof typeof kinds
export const createKinds: FileKind[] = ['doc', 'sheet', 'deck', 'board']
export function kindOf(format: string): FileKind {
  if (['xlsx', 'csv', 'tsv'].includes(format)) return 'sheet'
  if (format === 'pptx') return 'deck'
  if (format === 'excalidraw') return 'board'
  if (format === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'webp'].includes(format)) return 'image'
  return 'doc'
}
// Color identifies a live writer. The file icons and the surrounding chrome use ink.
const cursorHues: Record<FileKind, number> = {
  doc: 211,
  sheet: 160,
  deck: 29,
  board: 272,
  pdf: 353,
  image: 194,
}
export function fileCursorColors(files: FileEntry[]) {
  const counts = new Map<FileKind, number>(),
    colors = new Map<string, string>()
  for (const file of [...files].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )) {
    const kind = kindOf(file.format),
      index = counts.get(kind) || 0
    const hue = cursorHues[kind] + [0, -12, 10, -5][index % 4]
    const lightness = [39, 33, 43][index % 3]
    counts.set(kind, index + 1)
    colors.set(file.id, 'hsl(' + hue + ' 28% ' + lightness + '%)')
  }
  return colors
}
export function FileGlyph({
  kind,
  size = 18,
}: {
  kind: FileKind
  size?: number
}) {
  const Icon = kinds[kind].icon
  return (
    <span aria-hidden="true" className="desk-format">
      <Icon size={size} strokeWidth={1.8} />
    </span>
  )
}
export function PaperArt({ kind }: { kind: FileKind }) {
  return (
    <svg
      className="desk-paper-art"
      viewBox="0 0 54 44"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'doc' ? (
        <>
          <path className="desk-paper-back" d="M10 9.5 31 6l5.4 30.4-21 3.5z" />
          <path
            className="desk-paper-front"
            d="M19 4h14l8 8v24a2 2 0 0 1-2 2H19a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
          />
          <path d="M32 5v8h8M23 19h12m-12 5h12m-12 5h8" />
        </>
      ) : kind === 'sheet' ? (
        <>
          <rect
            className="desk-paper-back"
            x="7"
            y="11"
            width="36"
            height="26"
            rx="3"
          />
          <rect
            className="desk-paper-front"
            x="11"
            y="7"
            width="37"
            height="27"
            rx="3"
          />
          <path
            className="desk-paper-back"
            d="M14 7h31a3 3 0 0 1 3 3v4H11v-4a3 3 0 0 1 3-3z"
          />
          <path d="M11 21h37m-37 6h37M21 14v20m13-20v20" />
        </>
      ) : kind === 'deck' ? (
        <>
          <rect
            className="desk-paper-front"
            x="8.5"
            y="8"
            width="37"
            height="24"
            rx="2"
          />
          <rect
            className="desk-paper-back"
            x="6.5"
            y="5.5"
            width="41"
            height="4"
            rx="1.6"
          />
          <path d="M27 32v4m-8 4 8-4 8 4M15 25l7-7 6 3 9-7" />
        </>
      ) : (
        <>
          <path d="M19 13h10q3 0 3 3v2q0 3 3 3h2M14 19v7q0 3 3 3h4" />
          <rect
            className="desk-paper-front"
            x="6"
            y="7"
            width="16"
            height="12"
            rx="3"
          />
          <rect
            className="desk-paper-back"
            x="34"
            y="15.5"
            width="15"
            height="12"
            rx="3"
          />
          <rect
            className="desk-paper-front"
            x="20.5"
            y="25.5"
            width="13"
            height="10"
            rx="3"
          />
        </>
      )}
    </svg>
  )
}
export const baseName = (s: string) => s.replace(/\.[^.]+$/, '')
export function selectionKey(selection: HcdEmbedSelection | null) {
  if (!selection) return 'append'
  const t = selection.target
  const range = t.kind === 'document' ? t.spans.map(s => [s.blockId, s.start, s.end, s.textHash])
    : t.kind === 'sheet' ? [t.sheetId, t.top, t.left, t.bottom, t.right]
    : t.kind === 'spec' ? [t.id, t.anchor, t.head, t.expected] : [...t.elementIds].sort()
  return JSON.stringify([selection.documentId, selection.revision, selection.collaborationEpoch, t.kind, range])
}
export function scopeOf(file: FileEntry, selection: HcdEmbedSelection | null) {
  if (!file.canDelegateSelection) return ''
  if (selection?.target.kind === 'spec') return 'Spec 选句 · '+selection.target.expected
  if (selection?.target.kind === 'document')
    return '正文 · ' + selection.target.spans.length + ' 段'
  if (selection?.target.kind === 'canvas')
    return '选中 ' + selection.target.elementIds.length + ' 个对象'
  if (selection?.target.kind === 'sheet') {
    const t = selection.target
    const cell = (r: number, c: number) => {
      let label = ''
      for (let n = c + 1; n; n = Math.floor((n - 1) / 26))
        label = String.fromCharCode(65 + ((n - 1) % 26)) + label
      return label + (r + 1)
    }
    const start = cell(t.top, t.left),
      end = cell(t.bottom, t.right)
    return (
      '工作表 ' +
      (t.sheetIndex + 1) +
      ' · ' +
      start +
      (start === end ? '' : ':' + end)
    )
  }
  return kindOf(file.format) === 'doc'
    ? '追加到文末'
    : kindOf(file.format) === 'board'
      ? '追加到白板空白处'
      : ''
}

export const failText = (e: unknown) =>
  e instanceof Error ? e.message : String(e)
