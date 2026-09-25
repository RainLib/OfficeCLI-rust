import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { api, type Session } from './api.ts'

type Person = { id: string; name: string; color: string; connections: number }
const palette = ['#d84a54', '#3478c0', '#9a5abb', '#13866a', '#d17d20', '#7b65d8']

function colorFor(id: string) {
  let value = 0
  for (const character of id) value = (value * 31 + character.charCodeAt(0)) >>> 0
  return palette[value % palette.length]
}

function browserUserId(): string {
  const key = 'hcd-editor-browser-user-v1'
  try {
    const existing = localStorage.getItem(key)
    if (existing && /^[0-9a-f-]{36}$/.test(existing)) return existing
    const created = crypto.randomUUID()
    localStorage.setItem(key, created)
    return created
  } catch { return crypto.randomUUID() }
}

/** Fixed-layout clients share presence and committed revisions, not uncommitted keystrokes. */
export function useFixedCollaboration(session: Session, revision: number | null, onRemoteRevision: (revision: number) => void) {
  const [presence, setPresence] = useState<Person[]>([])
  const [connection, setConnection] = useState('连接中')
  const revisionRef = useRef(revision)
  const onRemoteRef = useRef(onRemoteRevision)
  revisionRef.current = revision
  onRemoteRef.current = onRemoteRevision
  const ydoc = useMemo(() => new Y.Doc(), [session.documentId, session.collaborationEpoch])
  const provider = useMemo(() => new HocuspocusProvider({
    url: session.collabUrl || import.meta.env.VITE_HCD_COLLAB_URL || 'ws://127.0.0.1:8768',
    name: `${session.documentId}:${session.collaborationEpoch ?? 0}`,
    document: ydoc,
    token: session.token,
  }), [session.documentId, session.collaborationEpoch, session.collabUrl, session.token, ydoc])
  const user = useMemo(() => {
    const id = session.userId || browserUserId()
    return { id, clientId: ydoc.clientID, name: session.displayName?.trim() || `协作者 ${id.slice(0, 4)}`, color: colorFor(id) }
  }, [session.userId, session.displayName, ydoc])

  useEffect(() => {
    const refreshPresence = () => {
      const unique = new Map<string, Person>()
      for (const [clientId, value] of provider.awareness?.getStates() || []) {
        const remote = value.user as { id?: string; name?: string; color?: string } | undefined
        if (!remote?.name) continue
        const id = remote.id || `client:${clientId}`
        const previous = unique.get(id)
        if (previous) { previous.connections += 1; continue }
        unique.set(id, { id, name: remote.name.trim().slice(0, 64), color: remote.color || colorFor(id), connections: 1 })
      }
      setPresence(Array.from(unique.values()).sort((left, right) => Number(right.id === user.id) - Number(left.id === user.id)))
    }
    const onStatus = ({ status }: { status: string }) => setConnection(status === 'connected' ? '已连接' : '连接中')
    const onStateless = ({ payload }: { payload: string }) => {
      try {
        const message = JSON.parse(payload) as { type?: string; revision?: number }
        if (message.type === 'hcd-fixed-revision' && Number.isSafeInteger(message.revision)
          && message.revision! > (revisionRef.current ?? -1)) onRemoteRef.current(message.revision!)
      } catch { /* Ignore unrelated collaboration messages. */ }
    }
    provider.awareness?.setLocalStateField('user', user)
    provider.awareness?.on('change', refreshPresence)
    provider.on('status', onStatus)
    provider.on('stateless', onStateless)
    refreshPresence()
    return () => {
      provider.awareness?.off('change', refreshPresence)
      provider.off('status', onStatus)
      provider.off('stateless', onStateless)
      provider.destroy()
      ydoc.destroy()
    }
  }, [provider, ydoc, user])

  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        const manifest = await (await api(session, '')).json() as { revision: number }
        if (active && Number.isSafeInteger(manifest.revision) && manifest.revision > (revisionRef.current ?? -1)) {
          onRemoteRef.current(manifest.revision)
        }
      } catch { /* WebSocket notifications continue; the next poll retries. */ }
    }
    const interval = window.setInterval(() => void check(), 15_000)
    return () => { active = false; window.clearInterval(interval) }
  }, [session])

  const announceRevision = useCallback((next: number) => {
    if (Number.isSafeInteger(next) && next >= 0) {
      provider.sendStateless(JSON.stringify({ type: 'hcd-fixed-revision', revision: next }))
    }
  }, [provider])
  const avatars = <details className="presence"><summary aria-label={`在线协作者，${presence.length} 人`}><span className="presence-avatars">{presence.slice(0, 3).map(person => <span key={person.id} className="avatar" title={person.name} style={{ background: person.color }}>{person.name.slice(0, 1)}</span>)}</span><span>{presence.length} 人在线</span></summary><div className="presence-menu"><strong>在线协作者 · {connection}</strong>{presence.map(person => <div key={person.id} className="presence-person"><span className="avatar" style={{ background: person.color }}>{person.name.slice(0, 1)}</span><span>{person.name}{person.id === user.id ? '（你）' : ''}</span>{person.connections > 1 && <small>{person.connections} 个窗口</small>}</div>)}</div></details>
  return { avatars, announceRevision, connection }
}
