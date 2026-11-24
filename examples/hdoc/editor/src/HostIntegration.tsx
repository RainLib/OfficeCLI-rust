import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CloudUpload, LoaderCircle } from 'lucide-react'
import { api, type Session } from './api.ts'
import { LocalText } from './sourceLocale.tsx'
import './host-integration.css'

type HostStatus = {
  externalFileId: string; fileName: string; importBaseVersion: string; externalVersion: string
  revision: number; lastPublishedRevision: number | null; pending: boolean
  operations: string[]; exportFormats: string[]; sessionExpiresAt: number
  pendingPublication?: Attempt | null
}
type Attempt = { publicationId: string; expectedRevision: number; exportMode: string }
type Result = { state: string; revision: number; fidelity?: { level?: string; warnings?: { code: string; message: string }[]; dropped?: string[]; flattened?: string[] }; error?: string; canStartNew?: boolean; receipt?: { externalVersion: string } }
const HostContext = createContext<{ status: HostStatus | null; refresh: () => Promise<void>; permits: (operation: string) => boolean }>({
  status: null, refresh: async () => {}, permits: () => true,
})
export const useHostPolicy = () => useContext(HostContext)
export const permits = (session: Session, operation: string) => !session.hostIntegration || !!session.operations?.includes(operation)

/** A failed policy check freezes remote editing while keeping mounted drafts. */
export function HostIntegrationBoundary({ session, children }: { session: Session; children: (effective: Session) => ReactNode }) {
  const [status, setStatus] = useState<HostStatus | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    if (!session.hostIntegration) return
    try {
      const value = await (await api(session, '/integration', { signal: AbortSignal.timeout(15_000) })).json() as HostStatus
      setStatus(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value)
      setError('')
    } catch (cause) { setError(String(cause)); throw cause }
  }, [session])
  useEffect(() => {
    if (!session.hostIntegration) return
    let active = true, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { await refresh() } catch { /* Preserve drafts and freeze editing. */ }
      if (active) timer = setTimeout(() => void poll(), 15_000)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [refresh, session.hostIntegration])
  const operations = error ? [] : status?.operations || session.operations
  const effective = useMemo<Session>(() => session.hostIntegration ? {
    ...session, operations, title: status?.fileName || session.title,
    scope: operations?.includes('document.edit') && session.scope === 'write' ? 'write' : 'read',
  } : session, [session, operations, status?.fileName])
  const policy = useMemo(() => ({ status, refresh, permits: (op: string) => permits(effective, op) }), [effective, refresh, status])
  return <HostContext.Provider value={policy}><div className="host-integration-boundary"
    onCopyCapture={event => { if (!permits(effective, 'document.copy')) event.preventDefault() }}
    onKeyDownCapture={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p' && !permits(effective, 'document.print')) event.preventDefault() }}>
    {error && <p className="host-session-notice" role="alert">无法确认业务权限，已暂停编辑。请从业务系统重新连接；已保存内容和受保护草稿会保留。</p>}
    {children(effective)}
  </div></HostContext.Provider>
}

export function HostPublicationControl({ session, revision, beforeSave }: { session: Session; revision: number | null; beforeSave?: () => Promise<number | null> }) {
  const { status, refresh } = useHostPolicy()
  const key = `officecli-publication:${session.userId}:${session.documentId}`
  const [attempt, setAttempt] = useState<Attempt | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) || 'null') as Attempt | null
      return value && /^[a-f0-9-]{36}$/.test(value.publicationId) && Number.isSafeInteger(value.expectedRevision)
        && ['source-backed', 'semantic', 'visual'].includes(value.exportMode) ? value : null
    } catch { return null }
  })
  const [mode, setMode] = useState('source-backed')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  useEffect(() => {
    if (!attempt && status?.pendingPublication && result?.state !== 'committed') setAttempt(status.pendingPublication)
  }, [attempt, status?.pendingPublication, result?.state])
  const writable = permits(session, 'document.edit') && permits(session, 'document.publish')
  const publish = async () => {
    if (busy || !writable) return
    setBusy(true); setMessage('')
    try {
      let current = attempt
      if (!current) {
        if (beforeSave && await beforeSave() === null) throw new Error('工作区尚未保存，请先处理未保存内容。')
        const manifest = await (await api(session, '')).json() as { revision: number }
        if (manifest.revision === status?.lastPublishedRevision) { setMessage('当前工作区内容已经回写业务系统。'); return }
        current = { publicationId: crypto.randomUUID(), expectedRevision: manifest.revision, exportMode: mode }
        setAttempt(current)
        try { sessionStorage.setItem(key, JSON.stringify(current)) } catch { /* Server intent is durable. */ }
      }
      const auth = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
      const response = await fetch(`${session.apiUrl || '/v1/documents'}/${encodeURIComponent(session.documentId)}/publications`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.accessToken?.() || session.token}`, 'Content-Type': 'application/json',
          'X-HCD-Collaboration-Epoch': String(auth.collaborationEpoch) }, body: JSON.stringify(current),
      })
      const value = await response.json() as Result & { error?: string }
      if (!value.state) {
        // Only discard an attempt when the server confirms it never recorded it.
        // A lost response must keep the same publication ID for safe recovery.
        if ([400, 409].includes(response.status)) {
          const record = await fetch(`${session.apiUrl || '/v1/documents'}/${encodeURIComponent(session.documentId)}/publications/${current.publicationId}`, {
            headers: { Authorization: `Bearer ${session.accessToken?.() || session.token}` },
          })
          if (record.status === 404) {
            setAttempt(null)
            try { sessionStorage.removeItem(key) } catch { /* Optional preference. */ }
          }
        }
        throw new Error(value.error || `回写请求失败（${response.status}）`)
      }
      setResult(value)
      if (value.state === 'committed') {
        setAttempt(null)
        try { sessionStorage.removeItem(key) } catch { /* Optional browser preference. */ }
        setMessage(`工作区 r${value.revision} 已回写为业务版本 ${value.receipt?.externalVersion || ''}`)
        window.dispatchEvent(new CustomEvent('officecli:publication', { detail: { documentId: session.documentId, ...value } }))
      } else {
        if (value.canStartNew) { setAttempt(null); try { sessionStorage.removeItem(key) } catch { /* Optional preference. */ } }
        setMessage(value.state === 'retrying' ? '业务系统尚未确认。请重试同一次回写，不会另建发布任务。'
        : value.state === 'conflict' ? '业务版本存在冲突，内容已保留，请由业务系统处理。'
          : value.error || '回写尚未完成，内容已保留。')
      }
      await refresh()
    } catch (cause) { setMessage(String(cause)) }
    finally { setBusy(false) }
  }
  if (!session.hostIntegration) return null
  const canExport = permits(session, 'document.download') || permits(session, 'document.export')
  if (!writable && !canExport && !permits(session, 'history.view')) return null
  return <details className="host-publication" data-publication-state={result?.state || (status?.pending ? 'pending' : 'saved')}>
    <summary><CloudUpload size={15} /><span><LocalText source={busy ? '回写中' : status?.pending ? '待回写' : '业务版本'} /></span></summary>
    <div className="host-publication-popover">
      <strong>业务文件保存</strong>
      <p>工作区修订 r{revision ?? status?.revision ?? '…'} · 业务版本 {status?.externalVersion || '…'}</p>
      <p>{status?.lastPublishedRevision === null ? '尚未回写业务系统' : `最近回写工作区 r${status?.lastPublishedRevision ?? '…'}`}</p>
      {writable && <><label>回写方式<select aria-label="回写方式" value={attempt?.exportMode || mode} disabled={busy || !!attempt} onChange={event => setMode(event.target.value)}>
        <option value="source-backed">保留原结构</option>
        {!['pdf', 'png', 'jpg', 'jpeg', 'webp', 'excalidraw'].includes(session.format) && <option value="semantic">按内容重新生成</option>}
        {session.format === 'pdf' && <option value="visual">按页面视觉生成</option>}
      </select></label><small>重新生成可能改变复杂排版；回写成功仅确认本次修订。</small>
      <button disabled={busy} onClick={() => void publish()}>{busy && <LoaderCircle className="host-publish-spinner" size={14} />}{attempt ? `重试回写 r${attempt.expectedRevision}` : '回写业务系统'}</button></>}
      {!writable && <p>当前会话没有业务回写权限。</p>}
      {canExport && <small>需要独立副本时可使用导出。</small>}
      {message && <p role="status">{message}</p>}
      {result?.fidelity && <details className="host-fidelity"><summary>本次导出说明 · {result.fidelity.level}</summary>
        {result.fidelity.warnings?.map((warning, i) => <p key={`${warning.code}:${i}`}>{warning.message}</p>)}
        {!!result.fidelity.flattened?.length && <p>已平面化：{result.fidelity.flattened.join('、')}</p>}
        {!!result.fidelity.dropped?.length && <p>未保留：{result.fidelity.dropped.join('、')}</p>}
        <small>业务回执确认的是文件提交；请结合导出说明检查复杂排版。</small>
      </details>}
    </div>
  </details>
}
