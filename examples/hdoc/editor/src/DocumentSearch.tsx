import { useEffect, useRef, useState } from 'react'

export type SearchHit = {
  chunkSequence: number
  region: string
  nodeId: string
  offset: number
  preview: string
  sheetId?: string
  sheetName?: string
  position?: number
  matchLength?: number
}

export type SearchResult = { revision: number; hits: SearchHit[]; truncated: boolean }

export function DocumentSearch({ open, onOpen, onClose, search, onSelect, refreshKey }: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  search: (query: string) => Promise<SearchResult>
  onSelect: (hit: SearchHit) => Promise<void> | void
  refreshKey: number | string | null
}) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [active, setActive] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const searchRef = useRef(search)
  searchRef.current = search

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
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
      setResult(null)
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
        setResult(found)
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
  if (!open) return null
  return <section className="document-search" aria-label="文档内容搜索">
    <div className="document-search-controls">
      <label>查找全文 <input ref={input} type="search" value={query} maxLength={128} placeholder="输入文字，搜索所有页面或工作表"
        onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); void select((active + (event.shiftKey ? -1 : 1) + (result?.hits.length || 0)) % (result?.hits.length || 1)) }
        }} /></label>
      <span role="status">{loading ? '搜索中…' : result ? `${result.hits.length}${result.truncated ? '+' : ''} 处结果` : ''}</span>
      <button onClick={() => void select((active - 1 + (result?.hits.length || 0)) % (result?.hits.length || 1))} disabled={!result?.hits.length}>上一个</button>
      <button onClick={() => void select((active + 1) % (result?.hits.length || 1))} disabled={!result?.hits.length}>下一个</button>
      <button aria-label="关闭搜索" onClick={onClose}>×</button>
    </div>
    {error && <p className="document-search-error">{error}</p>}
    {result && <div className="document-search-results" role="list" aria-label="搜索结果">
      {result.hits.length ? result.hits.map((hit, index) => <button role="listitem" key={`${hit.chunkSequence}:${hit.nodeId}:${hit.offset}`} className={active === index ? 'active' : ''} onClick={() => void select(index)}>
        <strong>{hit.sheetName || (hit.position !== undefined ? '正文' : hit.region === 'slide' ? `幻灯片 ${hit.chunkSequence + 1}` : `第 ${hit.chunkSequence + 1} 页`)}</strong><span>{hit.preview}</span>
      </button>) : <p>没有找到匹配内容</p>}
      {result.truncated && <p>最多显示前 200 处结果，请缩小关键词范围。</p>}
    </div>}
  </section>
}
