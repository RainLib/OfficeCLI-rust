import { useEffect, useState } from 'react'
import { Workspace } from './App.tsx'
import type { Session } from './api.ts'
import './style.css'

export type EmbeddedHcdEditorProps = {
  documentId: string
  token: string
  apiUrl: string
  collabUrl: string
  onClose?: () => void
  onError?: (error: Error) => void
}

/** Mount this component inside an existing React product without an iframe. */
export function EmbeddedHcdEditor({ documentId, token, apiUrl, collabUrl, onClose, onError }: EmbeddedHcdEditorProps) {
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const headers = { Authorization: `Bearer ${token}` }
    Promise.all([
      fetch(`${apiUrl}/${encodeURIComponent(documentId)}/auth`, { headers }),
      fetch(`${apiUrl}/${encodeURIComponent(documentId)}`, { headers }),
    ]).then(async ([auth, manifest]) => {
      if (!auth.ok || !manifest.ok) throw new Error(`HCD access failed: ${auth.status}/${manifest.status}`)
      const access = await auth.json() as { scope: 'read' | 'write'; userId?: string; displayName?: string; collaborationEpoch: number }
      const info = await manifest.json() as { source: { format: string } }
      if (active) setSession({ documentId, token, scope: access.scope, format: info.source.format,
        userId: access.userId, displayName: access.displayName, collaborationEpoch: access.collaborationEpoch, apiUrl, collabUrl })
    }).catch(cause => {
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      if (active) { setError(failure.message); onError?.(failure) }
    })
    return () => { active = false }
  }, [documentId, token, apiUrl, collabUrl, onError])
  return <div className="hcd-surface hcd-embedded">
    {session ? <Workspace key={`${session.documentId}:${session.collaborationEpoch ?? 0}`} session={session} onClose={() => onClose?.()} onEpochChange={epoch => setSession(previous => previous && ({ ...previous, collaborationEpoch: epoch }))} embedded /> : <div className="embedded-loading">{error || '正在打开 HCD 文档…'}</div>}
  </div>
}
