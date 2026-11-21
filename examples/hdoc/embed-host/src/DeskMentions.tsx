import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, AtSign, RefreshCw, X } from 'lucide-react'
import { api, mutation } from './hostApi'
import { failText } from './deskFiles'

export type DeskMention = {
  id: string
  fileId: string
  fileName: string
  elementId: string
  kind: 'sticky' | 'comment' | 'reply'
  preview: string
  receivedAt: string
  read: boolean
}
type MentionPage = { items: DeskMention[]; unread: number; next: string | null; incomplete: boolean }
const labels = { sticky: '便签', comment: '备注', reply: '回复' }
const time = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function DeskMentions({ csrf, openFile }: { csrf: string; openFile: (item: DeskMention) => Promise<void> }) {
  const [opened, setOpened] = useState(false)
  const [page, setPage] = useState<MentionPage>({ items: [], unread: 0, next: null, incomplete: false })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const pending = useRef<AbortController | null>(null)
  const load = useCallback(async (cursor?: string) => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setLoading(true)
    setError('')
    try {
      const result = await api<MentionPage>('/mentions' + (cursor ? '?before=' + encodeURIComponent(cursor) : ''), { signal: controller.signal })
      if (controller.signal.aborted) return
      setPage(previous => cursor ? { ...result, items: [...previous.items, ...result.items] } : result)
    } catch (cause) {
      if (!controller.signal.aborted) setError(failText(cause))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])
  useEffect(() => {
    if (opened) dialog.current?.showModal()
    const wake = () => { if (!document.hidden) void load() }
    wake()
    const poll = opened ? undefined : window.setInterval(wake, 12000)
    if (!opened) document.addEventListener('visibilitychange', wake)
    return () => {
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', wake)
      pending.current?.abort()
    }
  }, [load, opened])

  async function visit(item: DeskMention) {
    setSaving(true)
    setError('')
    try {
      const { item: current } = await api<{ item: DeskMention }>(`/mentions/${item.id}/read`, mutation(csrf, {}))
      await openFile(current)
      setOpened(false)
    } catch (cause) { setError(failText(cause)) }
    finally { setSaving(false) }
  }
  async function markAll() {
    setSaving(true)
    setError('')
    try {
      await api('/mentions/read', mutation(csrf, {}))
      await load()
    } catch (cause) { setError(failText(cause)) }
    finally { setSaving(false) }
  }

  return <>
    <button className="desk-mention-toggle" type="button" aria-label="@我" aria-haspopup="dialog" aria-expanded={opened}
      title={page.unread ? `${page.unread} 条未读提及` : '@我'} onClick={() => setOpened(true)}>
      <AtSign size={17} aria-hidden="true" />
      {page.unread > 0 && <span className="desk-mention-count" aria-label={`${page.unread} 条未读提及`}>{page.unread > 99 ? '99+' : page.unread}</span>}
    </button>
    {opened && <dialog ref={dialog} className="desk-content-search desk-mentions" aria-label="@我" onClose={() => setOpened(false)}>
      <header>
        <h2>@我</h2>
        <div className="desk-mention-actions">
          {page.unread > 0 && <button type="button" disabled={saving || loading} onClick={() => void markAll()}>全部已读</button>}
          <button type="button" disabled={saving || loading} aria-label="刷新提醒" onClick={() => void load()}><RefreshCw size={16} /></button>
          <button type="button" aria-label="关闭提醒" onClick={() => setOpened(false)}><X size={18} /></button>
        </div>
      </header>
      <div className="desk-mention-items" aria-busy={loading}>
        {page.items.map(item => <button type="button" key={item.id} className="desk-mention-item" data-unread={!item.read || undefined}
          disabled={saving} onClick={() => void visit(item)}>
          <span className="desk-mention-marker" aria-label={!item.read ? '未读' : undefined} />
          <span className="desk-mention-copy">
            <span><strong>{item.fileName}</strong><small>{labels[item.kind]}</small></span>
            <span>{item.preview}</span>
          </span>
          <span className="desk-mention-meta"><time dateTime={item.receivedAt}>{time.format(new Date(item.receivedAt))}</time><ArrowUpRight size={15} aria-hidden="true" /></span>
        </button>)}
        {loading && page.items.length === 0 && <p role="status">正在读取提及…</p>}
        {!loading && !page.items.length && !error && <p role="status">暂无提及</p>}
        {error && <p role="alert">{error}</p>}
        {!error && page.incomplete && <p role="status">部分白板暂未同步。</p>}
        {page.next && <button type="button" disabled={loading || saving} onClick={() => void load(page.next!)}>更多提醒</button>}
      </div>
    </dialog>}
  </>
}
