import { useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import { useEffect, useRef, useState } from 'react'

export type SearchHit = {
  chunkSequence: number
  region: string
  nodeId: string
  offset: number
  preview: string
  sheetId?: string
  sheetName?: string
  pageNumber?: number
  position?: number
  matchLength?: number
}

export type SearchResult = { revision: number; hits: SearchHit[]; truncated: boolean }

export function DocumentSearch({ open, onOpen, onClose, search, onSelect, onReplace, refreshKey }: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  search: (query: string) => Promise<SearchResult>
  onSelect: (hit: SearchHit) => Promise<void> | void
  onReplace?: (query: string, replacement: string, hit?: SearchHit) => number
  refreshKey: number | string | null
}) {
  const { locale } = useI18n()
  const [query, setQuery] = useState('')
  const [snapshot, setSnapshot] = useState<{ query: string; key: typeof refreshKey; result: SearchResult } | null>(null)
  const [active, setActive] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [replacement, setReplacement] = useState('')
  const [replaced, setReplaced] = useState<number | null>(null)
  const result = snapshot?.query === query && snapshot.key === refreshKey ? snapshot.result : null
  const input = useRef<HTMLInputElement>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const searchRef = useRef(search)
  searchRef.current = search

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!anchor.current?.parentElement?.getClientRects().length || anchor.current.closest(".document-tab-panel[hidden]")) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        onOpen()
      } else if (event.key === 'Escape' && open) {
        onClose()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [open, onOpen, onClose])
  useEffect(() => { if (open) input.current?.focus() }, [open])
  useEffect(() => {
    if (!open || !query.trim()) {
        setSnapshot(null)
      setActive(-1)
      setLoading(false)
      setError('')
      return
    }
    let live = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      void searchRef.current(query).then(found => {
        if (!live) return
        setSnapshot({ query, key: refreshKey, result: found })
        setActive(-1)
        setError('')
      }).catch(cause => { if (live) setError(String(cause)) })
        .finally(() => { if (live) setLoading(false) })
    }, 200)
    return () => { live = false; window.clearTimeout(timer) }
  }, [open, query, refreshKey])

  async function select(index: number) {
    const hit = result?.hits[index]
    if (!hit) return
    try { await onSelect(hit); setActive(index); setError('') }
    catch (cause) { setError(String(cause)) }
  }
  function replace(hit?: SearchHit) {
    try {
      if (!onReplace) return
      setReplaced(onReplace(query, replacement, hit))
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  if (!open) return <span hidden ref={anchor} />
  return <><span hidden ref={anchor} /><section className="document-search" aria-label={localizeSource(locale, "文档内容搜索")}>
    <div className="document-search-controls">
      <label><LocalText source={"查找全文 "} /><input ref={input} type="search" value={query} maxLength={128} placeholder={localizeSource(locale, "输入文字，搜索所有页面或工作表")}
        onChange={event => { setQuery(event.target.value); setActive(-1); setReplaced(null); setError('') }} onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void select((active + (event.shiftKey ? -1 : 1) + (result?.hits.length || 0)) % (result?.hits.length || 1)) }
        }} /></label>
      <span role="status">{localizeDynamic(locale, loading ? '搜索中…' : result ? `${result.hits.length}${result.truncated ? '+' : ''} 处结果` : '')}</span>
      <button onClick={() => void select((active - 1 + (result?.hits.length || 0)) % (result?.hits.length || 1))} disabled={!result?.hits.length}><LocalText source={"上一个"} /></button>
      <button onClick={() => void select((active + 1) % (result?.hits.length || 1))} disabled={!result?.hits.length}><LocalText source={"下一个"} /></button>
      <button aria-label={localizeSource(locale, "关闭搜索")} onClick={onClose}>×</button>
    </div>
    {onReplace && <div className="document-search-controls document-replace-controls">
      <label><LocalText source="替换为" /><input type="text" value={replacement} maxLength={2048} onChange={event => { setReplacement(event.target.value); setReplaced(null) }} /></label>
      <button disabled={!result?.hits[active]} onClick={() => { const hit = result?.hits[active]; if (hit) replace(hit) }}><LocalText source="替换选中项" /></button>
      <button disabled={!result?.hits.length || result.truncated} onClick={() => replace()}><LocalText source="全部替换" /></button>
      {replaced !== null && <span role="status">{localizeDynamic(locale, `已替换 ${replaced} 处`)}</span>}
    </div>}
    {error && <p className="document-search-error">{localizeDynamic(locale, error)}</p>}
    {result && <div className="document-search-results" role="list" aria-label={localizeSource(locale, "搜索结果")}>
      {result.hits.length ? result.hits.map((hit, index) => <button role="listitem" key={`${hit.chunkSequence}:${hit.nodeId}:${hit.offset}`} className={active === index ? 'active' : ''} onClick={() => void select(index)}>
        <strong>{hit.sheetName || localizeDynamic(locale, hit.position !== undefined ? '正文' : hit.region === 'slide' ? `幻灯片 ${hit.chunkSequence + 1}` : `第 ${hit.pageNumber ?? hit.chunkSequence + 1} 页`)}</strong><span>{hit.preview}</span>
      </button>) : <p><LocalText source={"没有找到匹配内容"} /></p>}
      {result.truncated && <p><LocalText source={"最多显示前 200 处结果，请缩小关键词范围。"} /></p>}
    </div>}
  </section></>
}
