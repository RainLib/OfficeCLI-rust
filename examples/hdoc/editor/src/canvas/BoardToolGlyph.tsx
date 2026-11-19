import {
  Circle,
  Hand,
  MessageCircle,
  MousePointer2,
  NotepadText,
  Plus,
  Shapes,
  Stamp,
  Table2,
  Type,
} from 'lucide-react'
export type BoardTool =
  | 'select'
  | 'hand'
  | 'pen'
  | 'sticky'
  | 'shapes'
  | 'text'
  | 'section'
  | 'table'
  | 'spec'
  | 'stamp'
  | 'comment'
  | 'actions'
  | 'insert'
export const boardTools: { id: BoardTool; name: string; key?: string }[][] = [
  [
    { id: 'select', name: '选择', key: 'V' },
    { id: 'hand', name: '手形', key: 'H' },
  ],
  [
    { id: 'pen', name: '画笔', key: 'M' },
    { id: 'sticky', name: '便利贴', key: 'S' },
    { id: 'shapes', name: '形状与连接线', key: 'X' },
  ],
  [
    { id: 'text', name: '文字', key: 'T' },
    { id: 'section', name: '分区', key: '⇧S' },
    { id: 'table', name: '表格' },
    { id: 'spec', name: 'Spec 文档' },
    { id: 'stamp', name: '盖章与即时表情', key: 'E' },
    { id: 'comment', name: '评论', key: 'C' },
    { id: 'actions', name: '操作', key: '⌘K / Ctrl+K' },
  ],
  [{ id: 'insert', name: '插入素材与模板', key: '+' }],
]
export type Brush = 'marker' | 'highlighter' | 'tape' | 'eraser'

export function BrushGlyph({ brush, ink }: { brush: Brush; ink: string }) {
  if (brush === 'marker')
    return (
      <svg className="board-tool-art" viewBox="0 0 52 48" aria-hidden="true">
        <path
          d="M16 48V31l5-15 4-12h3l5 12 4 15v17"
          fill="#e7e7e6"
          stroke="#a4a4a4"
          strokeWidth="1.2"
        />
        <path d="m21 16 4-13q1-2 3 0l5 13z" fill={ink} />
        <path d="m20.4 18 5-1-2 17-4 13h-2z" fill="#fafafa" />
        <path d="M16.5 33h20M17 36h19" stroke="#b5b5b4" />
        <path d="m33 19 3.4 13v16h-4z" fill="#d1d1d0" />
      </svg>
    )
  if (brush === 'highlighter')
    return (
      <svg className="board-tool-art" viewBox="0 0 52 48" aria-hidden="true">
        <path d="m19 17 2-12 10-4v16z" fill={ink} />
        <path d="m27 3 4-2v16h-4z" fill="#282437" opacity=".22" />
        <path d="M19 15h13l2 7 4 5v22H14V27l4-5z" fill="#ecece8" stroke="#94958f" strokeLinejoin="round" />
        <path d="M20 17h3l-3 11v21h-4V28l4-6z" fill="#fffefa" />
        <path d="m31 17 2 6 4 5v21h-5V28z" fill="#c5c7bf" />
        <path d="M15 29h22v5H15z" fill={ink} />
        <path d="M16 30h16" stroke="#fff" opacity=".48" />
      </svg>
    )
  if (brush === 'tape')
    return (
      <svg className="board-tool-art" viewBox="0 0 52 48" aria-hidden="true">
        <path d="M16 29c6 9 16 10 22 4l11 9-9 4-21-9z" fill={ink} />
        <path d="m32 35 12 9m-17-8 11 8m-2-9 10 7" stroke="#fff5dd" strokeWidth="2.4" />
        <g transform="rotate(-20 24 27)">
          <path d="M9 25c0-8 7-14 15-14s15 6 15 14v8c0 8-7 13-15 13S9 41 9 33z" fill={ink} stroke="#655a65" strokeWidth=".9" />
          <path d="M11 30v6m6-1v7m8-5v7m8-9v6" stroke="#fff8df" strokeWidth="3.4" />
          <ellipse cx="24" cy="24" rx="15" ry="13" fill="#fff4d9" stroke="#8e877a" />
          <ellipse cx="24" cy="24" rx="7.7" ry="6.8" fill="#e0d0aa" stroke="#b6a584" />
          <path d="M17 26c.7-7 11-10 14-4-1-8-14-8-14 4Z" fill="#96856c" />
        </g>
      </svg>
    )
  return (
    <svg className="board-tool-art" viewBox="0 0 52 48" aria-hidden="true">
      <g transform="rotate(12 26 30)">
        <rect x="15" y="8" width="24" height="42" rx="5" fill="#e5a6b1" stroke="#a87c88" />
        <path d="M19 10h12q3 0 4 2H19z" fill="#f8d6d9" />
        <path d="M15 26h24v20H15z" fill="#e7e9ea" stroke="#9b9ca2" />
        <path d="M33 27h5v18h-5z" fill="#c9c9d1" />
        <path d="M17 29h14m-14 3h10" stroke="#fff" strokeWidth="1.4" />
      </g>
    </svg>
  )
}

export function BoardToolGlyph({
  tool, paper = '#bde5ba', ink = '#2b2a2c', brush = 'marker',
}: {
  tool: BoardTool
  paper?: string
  ink?: string
  brush?: Brush
}) {
  if (tool === 'pen') return <BrushGlyph brush={brush} ink={ink} />
  if (tool === 'sticky')
    return (
      <svg className="board-tool-art" viewBox="0 0 59 48" aria-hidden="true">
        <g fill={paper} strokeLinejoin="round">
          <path d="m4.8 21 34-5.6 5.5 35-34 1.2Z" stroke="#282526" strokeOpacity=".16"/>
          <path d="m4.8 21 34-5.6 5.5 35-34 1.2Z" fill="#262720" opacity=".16"/>
          <path d="m8.5 16.8 35.3-6.3 6.4 40-37.6 1Z" stroke="#282526" strokeOpacity=".14"/>
          <path d="m8.5 16.8 35.3-6.3 6.4 40-37.6 1Z" fill="#292622" opacity=".07"/>
          <path d="m13.3 14 35.5-6.5q1.7-.3 1.9 1.4l4.4 42.2-39.5.8-3.2-35.4q-.2-2.2.9-2.5Z" stroke="#292622" strokeOpacity=".12"/>
        </g>
        <path d="m14.9 15 33-6" fill="none" stroke="white" strokeOpacity=".56" strokeLinecap="round"/>
      </svg>
    )
  if (tool === 'shapes')
    return (
      <svg
        className="board-tool-art board-shapes-art"
        viewBox="0 0 64 44"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinejoin="round"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <rect x="4.5" y="11.5" width="20" height="20" rx="1.3" />
        <circle cx="46" cy="37" r="10.5" />
        <path d="M36 20q0-8 8-8h10m-4-4 4 4-4 4" />
      </svg>
    )
  if (tool === 'section')
    return (
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <rect x="3.5" y="5" width="17" height="15" rx="2" />
        <path d="M4 10h8V5" />
      </svg>
    )
  if (tool === 'actions')
    return <Shapes size={19} strokeWidth={1.45} aria-hidden="true" />
  const Icon =
    {
      select: MousePointer2,
      hand: Hand,
      text: Type,
      table: Table2,
      spec: NotepadText,
      stamp: Stamp,
      comment: MessageCircle,
      insert: Plus,
    }[tool] || Circle
  return (
    <Icon
      size={tool === 'insert' ? 18 : 20}
      strokeWidth={1.45}
      aria-hidden="true"
    />
  )
}
