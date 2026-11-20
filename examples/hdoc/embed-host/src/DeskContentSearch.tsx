import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUpRight, Search, X } from 'lucide-react'
import type { HcdWorkspaceSearchHit } from '@officecli/hcd-reference-editor/react'
import { api } from './hostApi'
import { failText, FileGlyph, kindOf } from './deskFiles'

type SearchedFile = {
  id: string; name: string; format: string; revision: number
  hits: HcdWorkspaceSearchHit[]; truncated: boolean
}
type Page = { files: SearchedFile[]; unavailable: { id: string; name: string }[]; next: string | null }
export type FoundContent = { fileId: string; revision: number; query: string; hit: HcdWorkspaceSearchHit }

export function DeskContentSearch({ projectId, close, open }: { projectId?: string; close: () => void; open: (result: FoundContent) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pending = useRef<AbortController | null>(null)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [files, setFiles] = useState<SearchedFile[]>([])
  const [unavailable, setUnavailable] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
    return () => pending.current?.abort()
  }, [])
  async function search(event: FormEvent) {
    event.preventDefault()
    const term = query.trim()
    if (!term || Array.from(term).length > 128) return
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setSubmitted(term); setFiles([]); setUnavailable([]); setError(''); setBusy(true)
    try {
      let cursor: string | null = null
      do {
        const params = new URLSearchParams({ q: term })
        if (projectId) params.set('projectId', projectId)
        if (cursor) params.set('after', cursor)
        const page: Page = await api<Page>('/content-search?' + params, { signal: controller.signal })
        if (controller.signal.aborted) return
        setFiles(previous => [...previous, ...page.files])
        setUnavailable(previous => [...previous, ...page.unavailable.map(item => item.name)])
        cursor = page.next
      } while (cursor)
    } catch (cause) {
      if (!controller.signal.aborted) setError(failText(cause))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const hitButton = (file: SearchedFile, hit: HcdWorkspaceSearchHit, index: number) => (
    <button className="desk-content-hit" type="button" key={index}
      onClick={() => open({ fileId: file.id, revision: file.revision, query: submitted, hit })}>
      <span>{hit.sheetName && <small>{hit.sheetName}</small>}{hit.pageNumber !== undefined && <small>第 {hit.pageNumber} 页</small>}{hit.preview}</span>
      <ArrowUpRight size={14} aria-hidden="true" />
    </button>
  )
  return <dialog ref={dialog} className="desk-content-search" aria-label="搜索文件内容" onCancel={close}>
    <header><h2>搜索文件内容</h2><button type="button" onClick={close} aria-label="关闭内容搜索"><X size={18} /></button></header>
    <form onSubmit={event => void search(event)}>
      <label><Search size={16} /><input autoFocus aria-label="内容关键词" placeholder="输入要查找的文字" value={query}
        onChange={event => setQuery(event.target.value)} maxLength={256} /></label>
      <button disabled={!query.trim() || Array.from(query.trim()).length > 128}>搜索</button>
    </form>
    <div className="desk-content-results" aria-live="polite" aria-busy={busy}>
      {files.map(file => <section key={file.id} aria-label={file.name}>
        <h3><FileGlyph kind={kindOf(file.format)} size={16} />{file.name}</h3>
        {file.hits.slice(0, 4).map((hit, index) => hitButton(file, hit, index))}
        {file.hits.length > 4 && <details><summary>其余 {file.hits.length - 4} 处匹配</summary>
          {file.hits.slice(4).map((hit, index) => hitButton(file, hit, index + 4))}</details>}
        {file.truncated && <small>部分结果未显示，可缩小关键词范围。</small>}
      </section>)}
      {busy && <p role="status">正在查找…</p>}
      {!busy && !error && submitted && !files.length && <p>没有找到「{submitted}」。</p>}
      {error && <p role="alert" className="desk-error">{error}</p>}
      {!busy && unavailable.length > 0 && <details><summary>{unavailable.length} 份文件暂时无法读取</summary>
        <ul>{unavailable.map((file, index) => <li key={index}>{file}</li>)}</ul>
      </details>}
    </div>
  </dialog>
}
