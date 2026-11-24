import { useEffect, useRef, useState } from 'react'
import { FileText, LockKeyhole } from 'lucide-react'
import { EmbeddedHcdEditor } from './embed.tsx'
import { DocumentSharingProvider, type SharingActor, type SharingPolicy } from './DocumentSharing.tsx'

type Launch = {
  documentId: string; token: string; expiresAt: number; fileName: string; collabUrl: string
  actor?: SharingActor; canManage: boolean; sharing?: SharingPolicy
}
class AccessFailure extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** Visitors exchange a sharing grant for the same document-bound session used
 * by signed-in members; a browser-supplied identity never grants permissions. */
export function BusinessEditor({ fileId, shared }: { fileId: string; shared?: { secret?: string } }) {
  const [launch, setLaunch] = useState<Launch | null>(null), [error, setError] = useState('')
  const [blocked, setBlocked] = useState(false), [retry, setRetry] = useState(0)
  const sessionId = useRef(crypto.randomUUID())
  const isShared = !!shared, secret = shared?.secret
  useEffect(() => {
    let active = true, renewing = false, timer: ReturnType<typeof setTimeout>
    const request = new AbortController()
    const renew = async () => {
      if (renewing || !active) return
      renewing = true
      clearTimeout(timer)
      try {
        let csrf = ''
        if (!isShared) {
          const auth = await fetch('/workspace/api/session', { credentials: 'same-origin', signal: request.signal })
          if (!auth.ok) throw new AccessFailure(auth.status, '登录已过期，请返回工作空间重新登录。')
          csrf = (await auth.json() as { csrf: string }).csrf
        }
        let value: Launch | null = null
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await fetch(isShared ? `/workspace/api/shared/${encodeURIComponent(fileId)}/open` : `/workspace/api/files/${encodeURIComponent(fileId)}/editor-session`, {
            method: 'POST', credentials: 'same-origin', signal: request.signal,
            headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Workspace-CSRF': csrf } : {}), ...(secret ? { 'X-Workspace-Share': secret } : {}) },
            body: JSON.stringify({ sessionId: sessionId.current }),
          })
          const result = await response.json() as Launch & { error?: string; retrySession?: boolean }
          if (response.status === 409 && result.retrySession && attempt === 0) { sessionId.current = crypto.randomUUID(); continue }
          if (!response.ok) throw new AccessFailure(response.status, result.error || '暂时无法打开文档。')
          value = result; break
        }
        if (!value || !active) return
        setLaunch(previous => previous?.token === value.token && previous?.fileName === value.fileName && previous?.canManage === value.canManage ? previous : value)
        setError(''); setBlocked(false)
        const delay = Math.max(10_000, value.expiresAt * 1000 - Date.now() - 90_000)
        timer = setTimeout(() => void renew(), isShared ? Math.min(15_000, delay) : delay)
      } catch (cause) {
        if (!active) return
        const denied = cause instanceof AccessFailure && [401, 403, 404].includes(cause.status)
        setError(cause instanceof Error ? cause.message : String(cause))
        if (denied) { setBlocked(true); setLaunch(null) }
        else timer = setTimeout(() => void renew(), 15_000)
      } finally { renewing = false }
    }
    const visible = () => { if (document.visibilityState === 'visible') void renew() }
    document.addEventListener('visibilitychange', visible)
    void renew()
    return () => { active = false; request.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [fileId, isShared, secret, retry])
  const websocket = new URL(launch?.collabUrl || '/collaboration', location.href)
  websocket.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const returnTo = location.pathname + location.search + location.hash
  if (blocked || !launch && error) return <main className="shared-access-state"><div>
    <LockKeyhole size={28} /><h1>{blocked ? '暂时无法访问这份文档' : '文档暂时无法打开'}</h1><p role="alert">{error}</p>
    <p>分享权限由文档负责人设置。已保存的修改不会因关闭分享而被删除。</p>
    <div className="shared-access-actions"><button onClick={() => { sessionId.current = crypto.randomUUID(); setBlocked(false); setError(''); setRetry(value => value + 1) }}>重新打开</button><a href={`/?returnTo=${encodeURIComponent(returnTo)}`}>登录受邀账号</a><a href="/public">浏览公开文档</a></div>
  </div></main>
  return <div className="business-editor" style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    {error && <div role="alert" className="shared-session-notice">{error} 文档仍保留在当前页面，将自动重试连接。</div>}
    {launch ? <DocumentSharingProvider fileId={fileId} canManage={launch.canManage} actor={launch.actor} sharedUrl={launch.sharing?.url}>
      <div style={{ flex: 1, minHeight: 0 }}><EmbeddedHcdEditor documentId={launch.documentId} title={launch.fileName} token={launch.token} apiUrl="/v1/documents" collabUrl={websocket.href} locale="zh-CN" onClose={() => { location.href = isShared ? '/public' : `/#/documents/${encodeURIComponent(fileId)}` }} /></div>
    </DocumentSharingProvider> : <main className="shared-access-state"><div><FileText size={28} /><h1>正在打开文档</h1><p role="status">正在核对访问权限…</p>{isShared && <p>通过分享链接直接访问，无需注册账号。</p>}</div></main>}
  </div>
}
