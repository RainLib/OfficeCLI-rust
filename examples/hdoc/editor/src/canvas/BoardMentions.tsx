import { useId, useLayoutEffect, useState, type KeyboardEvent, type RefObject } from 'react'

export type BoardPerson = { id: string; name: string }
export type BoardMention = BoardPerson & { start: number; end: number }

function changeRanges(before: string, after: string, ranges: BoardMention[]) {
  let start = 0,
    end = before.length,
    tail = after.length
  while (start < end && start < tail && before[start] === after[start]) start++
  while (end > start && tail > start && before[end - 1] === after[tail - 1]) {
    end--
    tail--
  }
  return ranges.flatMap((m) =>
    m.end <= start
      ? [m]
      : m.start >= end
        ? [{ ...m, start: m.start + tail - end, end: m.end + tail - end }]
        : [],
  )
}
export function MentionText({ text, mentions = [] }: { text: string; mentions?: BoardMention[] }) {
  const spans = [],
    valid = Array.isArray(mentions) ? mentions : []
  let last = 0
  for (const m of valid) {
    if (
      !m ||
      !Number.isInteger(m.start) ||
      !Number.isInteger(m.end) ||
      m.start < last ||
      text.slice(m.start, m.end) !== '@' + m.name
    )
      continue
    spans.push(
      text.slice(last, m.start),
      <mark key={m.start} data-person={m.id}>
        {text.slice(m.start, m.end)}
      </mark>,
    )
    last = m.end
  }
  return (
    <>
      {spans}
      {text.slice(last)}
    </>
  )
}
export function useBoardMentions(
  field: RefObject<HTMLTextAreaElement | null>,
  text: string,
  setText: (s: string) => void,
  people: BoardPerson[],
  initial: BoardMention[] = [],
) {
  const [mentions, setMentions] = useState<BoardMention[]>(() => (Array.isArray(initial) ? initial : []))
  const [query, setQuery] = useState<{ start: number; end: number; term: string } | null>(null)
  const [active, setActive] = useState(0),
    [caret, setCaret] = useState<number | null>(null)
  const listId = useId()
  useLayoutEffect(() => {
    if (caret !== null) {
      field.current?.focus({ preventScroll: true })
      field.current?.setSelectionRange(caret, caret)
      setCaret(null)
    }
  }, [caret, field])
  function inspect(value: string, pos: number) {
    const prefix = value.slice(0, pos),
      start = prefix.lastIndexOf('@')
    const term = prefix.slice(start + 1)
    if (start < 0 || /\s/.test(term) || (start > 0 && /[A-Za-z0-9_.+-]/.test(value[start - 1]))) {
      setQuery(null)
      return
    }
    setQuery({ start, end: pos, term })
    setActive(0)
  }
  function change(value: string, pos: number) {
    setMentions(changeRanges(text, value, mentions))
    setText(value)
    inspect(value, pos)
  }
  function insert(textToAdd: string) {
    const start = field.current?.selectionStart ?? text.length,
      end = field.current?.selectionEnd ?? start
    if (textToAdd === '@' && start > 0 && /[A-Za-z0-9_.+-]/.test(text[start - 1])) textToAdd = ' @'
    const next = text.slice(0, start) + textToAdd + text.slice(end)
    const pos = start + textToAdd.length
    change(next, pos)
    setCaret(pos)
    if (textToAdd === '@') setQuery({ start, end: pos, term: '' })
  }
  const matches = query
    ? people
        .filter(
          (p) =>
            p.name.toLocaleLowerCase().includes(query.term.toLocaleLowerCase()) ||
            p.id.toLowerCase().startsWith(query.term.toLowerCase()),
        )
        .slice(0, 12)
    : []
  function choose(person: BoardPerson) {
    if (!query) return
    const label = '@' + person.name,
      end = query.start + label.length
    const next = text.slice(0, query.start) + label + ' ' + text.slice(query.end)
    setMentions(
      [...changeRanges(text, next, mentions), { ...person, start: query.start, end }].sort(
        (a, b) => a.start - b.start,
      ),
    )
    setText(next)
    setCaret(end + 1)
    setQuery(null)
  }
  function key(e: KeyboardEvent) {
    if (!query || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return false
    if (e.key === 'Escape') setQuery(null)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
      setActive(
        (i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % Math.max(1, matches.length),
      )
    else if ((e.key === 'Tab' || e.key === 'Enter') && matches.length)
      choose(matches[Math.min(active, matches.length - 1)])
    else return false
    e.preventDefault()
    e.stopPropagation()
    return true
  }
  const menu = query && (
    <div id={listId} role="listbox" aria-label="提及协作者" className="board-mention-list">
      {matches.map((p, i) => (
        <button
          key={p.id}
          role="option"
          id={listId + '-' + i}
          aria-selected={i === active}
          type="button"
          tabIndex={-1}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => choose(p)}
        >
          <span aria-hidden="true">{Array.from(p.name)[0]}</span>
          {p.name}
        </button>
      ))}
      {!matches.length && <small>没有匹配的协作者</small>}
    </div>
  )
  return {
    mentions,
    menu,
    key,
    change,
    insert,
    refresh: () => {
      if (field.current) inspect(text, field.current.selectionStart)
    },
    inputProps: {
      'aria-controls': query ? listId : undefined,
      'aria-activedescendant': query && matches.length ? listId + '-' + active : undefined,
      'aria-autocomplete': 'list' as const,
    },
  }
}
