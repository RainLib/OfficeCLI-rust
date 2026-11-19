import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeft, Search, Stamp, PartyPopper } from 'lucide-react'
import { emojiCatalog, emojiGroups } from './emojiCatalog'
import { isReaction, reactionKinds, reactionNames } from './materialCatalog'
import { ReactionGlyph } from './CanvasReactions'
import type { ReactionKind } from './model'

const ring: ReactionKind[] = [
  'thumbsUp',
  'plusOne',
  'favorite',
  'question',
  'thumbsDown',
  'dot',
  'profile',
  'loveIt',
]
const xy = (r: number, deg: number) => {
  const angle = (deg * Math.PI) / 180
  return [116 + r * Math.cos(angle), 116 + r * Math.sin(angle)]
}
function sector(angle: number) {
  const a = angle - 22.5,
    b = angle + 22.5
  return (
    'M' +
    xy(114, a) +
    'A114 114 0 0 1 ' +
    xy(114, b) +
    'L' +
    xy(33, b) +
    'A33 33 0 0 0 ' +
    xy(33, a) +
    'Z'
  )
}
function moveFocus(event: KeyboardEvent<SVGSVGElement>) {
  const choices = [
    ...event.currentTarget.querySelectorAll<SVGGElement>('[role=button]'),
  ]
  const active = choices.indexOf(
    document.activeElement as unknown as SVGGElement,
  )
  if (event.key === 'Enter' || event.key === ' ') {
    if (active < 0) return
    event.preventDefault()
    choices[active].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return
  }
  const delta = ['ArrowRight', 'ArrowDown'].includes(event.key)
    ? 1
    : ['ArrowLeft', 'ArrowUp'].includes(event.key)
      ? -1
      : 0
  if (delta) {
    event.preventDefault()
    choices[(active + delta + choices.length) % choices.length]?.focus()
  }
}
type PickerProps = {
  selected: ReactionKind
  person: string
  recentKey: string | null
  writable: boolean
  temporary: boolean
  setTemporary: (value: boolean) => void
  choose: (kind: ReactionKind) => void
  close: () => void
}
export function StampPicker({
  selected,
  person,
  recentKey,
  writable,
  temporary,
  setTemporary,
  choose,
  close,
}: PickerProps) {
  const [expanded, setExpanded] = useState(false),
    [query, setQuery] = useState(''),
    [group, setGroup] = useState(-1),
    [limit, setLimit] = useState(72)
  const [recent] = useState<ReactionKind[]>(() => {
    try {
      const list: unknown = recentKey
        ? JSON.parse(localStorage.getItem(recentKey) || '[]')
        : []
      return Array.isArray(list)
        ? list
            .filter(
              (v): v is ReactionKind => typeof v === 'string' && isReaction(v),
            )
            .slice(0, 16)
        : []
    } catch {
      return []
    }
  })
  const input = useRef<HTMLInputElement>(null),
    dial = useRef<SVGSVGElement>(null),
    back = useRef(false)
  useEffect(() => {
    if (expanded) input.current?.focus()
    else
      (
        dial.current?.querySelector<SVGGElement>(
          back.current ? '[data-center]' : '[aria-pressed=true]',
        ) || dial.current?.querySelector<SVGGElement>('[role=button]')
      )?.focus()
  }, [expanded])
  const q = query.toLowerCase().trim()
  const matches = useMemo(
    () =>
      emojiCatalog.filter(
        (row) =>
          (q || group < 0 || row.group === group) &&
          (!q ||
            [row.glyph, row.name, row.english].some((s) =>
              s.toLowerCase().includes(q),
            )),
      ),
    [q, group],
  )
  function pick(id: ReactionKind) {
    if (recentKey)
      try {
        localStorage.setItem(
          recentKey,
          JSON.stringify([id, ...recent.filter((v) => v !== id)].slice(0, 16)),
        )
      } catch {
        /* Browser storage may be disabled. */
      }
    choose(id)
  }
  const button = (id: ReactionKind) => (
    <button
      type="button"
      key={id}
      aria-label={reactionNames[id]}
      title={reactionNames[id]}
      onClick={() => pick(id)}
    >
      <ReactionGlyph kind={id} size={29} person={person} />
    </button>
  )
  if (!expanded)
    return (
      <svg
        ref={dial}
        viewBox="0 0 232 232"
        className="stamp-dial"
        role="group"
        aria-label="选择回应图案"
        onKeyDown={moveFocus}
      >
        {ring.map((id, i) => {
          const angle = -90 + i * 45,
            [cx, cy] = xy(77, angle)
          return (
            <g
              key={id}
              role="button"
              tabIndex={0}
              aria-label={reactionNames[id]}
              data-choice={id}
              aria-pressed={selected === id}
              onClick={() => pick(id)}
            >
              <title>{reactionNames[id]}</title>
              <path className="stamp-slice" d={sector(angle)} />
              <foreignObject
                x={cx - 19}
                y={cy - 19}
                width="38"
                height="38"
                pointerEvents="none"
              >
                <ReactionGlyph kind={id} size={38} person={person} />
              </foreignObject>
            </g>
          )
        })}
        <g
          role="button"
          data-center=""
          tabIndex={0}
          aria-label="更多表情印章"
          onClick={() => setExpanded(true)}
        >
          <title>更多表情印章</title>
          <circle className="stamp-slice" cx="116" cy="116" r="32" />
          <text
            className="dial-collage"
            x="97"
            y="118"
            transform="rotate(-13 110 109)"
          >
            🥰
          </text>
          <text
            className="dial-collage"
            x="114"
            y="133"
            transform="rotate(10 126 124)"
          >
            🥳
          </text>
        </g>
      </svg>
    )
  return (
    <div
      className="stamp-browser"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
    >
      <div className="stamp-search">
        <button
          type="button"
          aria-label="返回印章轮盘"
          onClick={() => {
            back.current = true
            setExpanded(false)
          }}
        >
          <ArrowLeft size={16} />
        </button>
        <Search size={15} />
        <input
          ref={input}
          value={query}
          aria-label="搜索表情"
          placeholder="搜索表情"
          onChange={(e) => {
            setQuery(e.target.value)
            setLimit(72)
          }}
        />
      </div>
      <div className="stamp-modes" role="group" aria-label="表达方式">
        {writable && (
          <button aria-pressed={!temporary} onClick={() => setTemporary(false)}>
            <Stamp size={14} />
            印章
          </button>
        )}
        <button aria-pressed={temporary} onClick={() => setTemporary(true)}>
          <PartyPopper size={14} />
          即时表情
        </button>
      </div>
      {!q && (
        <div className="stamp-categories" role="group" aria-label="表情分类">
          {['常用', ...emojiGroups].map((name, i) => (
            <button
              key={name}
              aria-pressed={group === i - 1}
              onClick={() => {
                setGroup(i - 1)
                setLimit(72)
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div className="stamp-library-list" key={q + '-' + group}>
        {!q && group === -1 && (
          <>
            {!!recent.length && (
              <>
                <h4>最近使用</h4>
                <div className="emoji-grid">{recent.map(button)}</div>
              </>
            )}
            <h4>手绘印章</h4>
            <div className="emoji-grid">{reactionKinds.map(button)}</div>
          </>
        )}
        {!!q && reactionKinds.some((id) => reactionNames[id].includes(q)) && (
          <div className="emoji-grid">
            {reactionKinds
              .filter((id) => reactionNames[id].includes(q))
              .map(button)}
          </div>
        )}
        <h4>{q ? '搜索结果' : group < 0 ? '全部表情' : emojiGroups[group]}</h4>
        <div className="emoji-grid">
          {matches.slice(0, limit).map((row) => button(row.id))}
        </div>
        {matches.length > limit && (
          <button
            className="stamp-more"
            onClick={() => setLimit((n) => n + 72)}
          >
            更多表情
          </button>
        )}
        {!matches.length && <p>没有匹配的表情</p>}
      </div>
    </div>
  )
}
