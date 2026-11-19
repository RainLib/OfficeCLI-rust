import { useEffect, useRef, useState } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Check,
  ChevronDown,
  Link2,
  List,
  Pencil,
  Plus,
  Strikethrough,
  UserRoundPen,
} from 'lucide-react'
import type { CSSProperties } from 'react'

export type NoteFormat = {
  font?: 'sans' | 'hand' | 'mono'
  size?: number
  bold?: boolean
  strike?: boolean
  list?: boolean
  align?: 'left' | 'center' | 'right'
  link?: string
}
export const paperColors = [
  ['薄荷绿', '#bde5ba'],
  ['柠檬黄', '#ffe794'],
  ['蜜桃橙', '#ffcba7'],
  ['珊瑚粉', '#ffafa3'],
  ['玫瑰粉', '#f6c5da'],
  ['薰衣草', '#d9c9ef'],
  ['天蓝', '#bedff0'],
  ['白色', '#ffffff'],
]
export function noteTextStyle(style: NoteFormat, size: number): CSSProperties {
  return {
    fontFamily:
      style.font === 'mono'
        ? 'ui-monospace,monospace'
        : style.font === 'hand'
          ? 'KaiTi,STKaiti,"Comic Sans MS",cursive'
          : 'Arial,sans-serif',
    fontSize: style.size ?? size,
    fontWeight: style.bold ? 700 : 400,
    textDecoration:
      [style.strike && 'line-through', style.link && 'underline']
        .filter(Boolean)
        .join(' ') || 'none',
    textAlign: style.align ?? 'left',
    color: style.link ? '#294b86' : '#28272b',
  }
}
export function safeBoardLink(value: string) {
  try {
    const url = new URL(value)
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}
type Props = {
  color: string
  format: NoteFormat
  signed: boolean
  onColor: (v: string) => void
  onFormat: (v: NoteFormat) => void
  onSigned: () => void
  onEdit?: () => void
  onNext?: () => void
  x?: number
  y?: number
}
export function StickyToolbar(p: Props) {
  const [menu, setMenu] = useState(''),
    [url, setUrl] = useState(''),
    [bad, setBad] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu('')
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  const toggle = (m: string) => {
    setMenu(menu === m ? '' : m)
    if (m === 'link') {
      setUrl(p.format.link || '')
      setBad(false)
    }
  }
  const change = (v: Partial<NoteFormat>) => {
    p.onFormat({ ...p.format, ...v })
    setMenu('')
  }
  const size = p.format.size || 20,
    align = p.format.align || 'left',
    Align =
      align === 'center'
        ? AlignCenter
        : align === 'right'
          ? AlignRight
          : AlignLeft
  const sizes = [
    [15, '小号'],
    [20, '中号'],
    [28, '大号'],
    [36, '特大'],
  ] as const
  return (
    <div
      className="board-object-bar sticky-format-bar"
      ref={ref}
      role="toolbar"
      aria-label="便签格式"
      style={p.x === undefined ? undefined : { left: p.x, top: p.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menu) {
          e.stopPropagation()
          setMenu('')
        }
      }}
    >
      <button
        type="button"
        aria-label="便利贴颜色"
        title="便利贴颜色"
        aria-expanded={menu === 'color'}
        onClick={() => toggle('color')}
      >
        <i style={{ background: p.color }} />
        <ChevronDown size={12} />
      </button>
      <button
        type="button"
        aria-label="便签字体"
        title="字体"
        aria-expanded={menu === 'font'}
        onClick={() => toggle('font')}
      >
        Aa
        <ChevronDown size={12} />
      </button>
      <button
        type="button"
        aria-label="便签字号"
        title="字号"
        aria-expanded={menu === 'size'}
        onClick={() => toggle('size')}
      >
        {sizes.find((s) => s[0] === size)?.[1] || size}
        <ChevronDown size={12} />
      </button>
      <button
        type="button"
        aria-label="便签粗体"
        title="粗体"
        aria-pressed={!!p.format.bold}
        onClick={() => change({ bold: !p.format.bold })}
      >
        <Bold />
      </button>
      <button
        type="button"
        aria-label="便签删除线"
        title="删除线"
        aria-pressed={!!p.format.strike}
        onClick={() => change({ strike: !p.format.strike })}
      >
        <Strikethrough />
      </button>
      <button
        type="button"
        aria-label="便签链接"
        title="链接"
        aria-expanded={menu === 'link'}
        onClick={() => toggle('link')}
      >
        <Link2 />
      </button>
      <button
        type="button"
        aria-label="便签列表"
        title="项目符号"
        aria-pressed={!!p.format.list}
        onClick={() => change({ list: !p.format.list })}
      >
        <List />
      </button>
      <button
        type="button"
        aria-label="便签对齐"
        title="文字对齐"
        aria-expanded={menu === 'align'}
        onClick={() => toggle('align')}
      >
        <Align />
      </button>
      <button
        type="button"
        aria-label="显示署名"
        title="显示署名"
        aria-pressed={p.signed}
        onClick={p.onSigned}
      >
        <UserRoundPen />
      </button>
      {p.onEdit && (
        <button
          type="button"
          aria-label="编辑便利贴"
          title="编辑文字"
          onClick={p.onEdit}
        >
          <Pencil />
        </button>
      )}
      {p.onNext && (
        <button
          type="button"
          aria-label="在右侧新建便利贴"
          title="在右侧新建便利贴"
          onClick={p.onNext}
        >
          <Plus />
        </button>
      )}
      {menu && (
        <div
          className={'sticky-format-menu fm-' + menu}
          role="group"
          aria-label="便签格式选项"
        >
          {menu === 'color' &&
            paperColors.map(([name, c]) => (
              <button
                type="button"
                key={c}
                aria-label={name}
                aria-pressed={p.color === c}
                style={{ background: c }}
                onClick={() => {
                  p.onColor(c)
                  setMenu('')
                }}
              >
                {p.color === c && <Check size={12} />}
              </button>
            ))}
          {menu === 'font' &&
            (
              [
                ['sans', '无衬线'],
                ['hand', '手写'],
                ['mono', '等宽'],
              ] as const
            ).map(([font, v]) => (
              <button type="button" key={font} onClick={() => change({ font })}>
                {v}
              </button>
            ))}
          {menu === 'size' &&
            sizes.map(([size, name]) => (
              <button type="button" key={size} onClick={() => change({ size })}>
                {name}
              </button>
            ))}
          {menu === 'align' &&
            (
              [
                ['left', '左对齐'],
                ['center', '居中'],
                ['right', '右对齐'],
              ] as const
            ).map(([align, v]) => (
              <button
                type="button"
                key={align}
                onClick={() => change({ align })}
              >
                {v}
              </button>
            ))}
          {menu === 'link' && (
            <>
              <input
                aria-label="便签链接地址"
                type="url"
                value={url}
                placeholder="https://"
                onChange={(e) => setUrl(e.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  const link = safeBoardLink(url.trim())
                  if (url.trim() && !link) {
                    setBad(true)
                    return
                  }
                  change({ link })
                }}
              >
                应用
              </button>
              {p.format.link && (
                <a
                  href={safeBoardLink(p.format.link)}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  打开
                </a>
              )}
              {bad && <small role="alert">请输入有效的网址</small>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
