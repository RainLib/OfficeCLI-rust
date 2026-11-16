import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import { useI18n } from './i18n.tsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { api, type Session } from './api.ts'
import { useAgentWorkspace } from './AgentActivityLayer.tsx'

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
  const { agents, operations } = useAgentWorkspace()
  const operationRevision = Math.max(-1, ...operations.filter(operation=>operation.status === 'applied').map(operation=>operation.revision))
  const { locale } = useI18n()
  const [presence, setPresence] = useState<Person[]>([])
  const [connection, setConnection] = useState('连接中')
  const revisionIdentity = JSON.stringify([session.apiUrl, session.documentId, session.collaborationEpoch])
  const revisionIdentityRef = useRef(revisionIdentity)
  const revisionRef = useRef(revision)
  if (revisionIdentityRef.current !== revisionIdentity) {
    revisionIdentityRef.current = revisionIdentity
    revisionRef.current = revision
  }
  const onRemoteRef = useRef(onRemoteRevision)
  // React can render with an older prop while an acknowledged edit refreshes
  // the canvas. Keep that acknowledgement through renders and its own echo.
  if (revision !== null) revisionRef.current = Math.max(revisionRef.current ?? -1, revision)
  onRemoteRef.current = onRemoteRevision
  useEffect(() => {
    const latest = Math.max(operationRevision, ...agents.filter(agent => agent.status === 'applied').map(agent => agent.revision))
    if (latest > (revisionRef.current ?? -1)) onRemoteRef.current(latest)
  }, [agents, operationRevision])
  const ydoc = useMemo(() => new Y.Doc(), [session.documentId, session.collaborationEpoch])
  const liveToken = useRef(session.token); liveToken.current = session.token
  const provider = useMemo(() => new HocuspocusProvider({
    url: session.collabUrl || import.meta.env.VITE_HCD_COLLAB_URL || 'ws://127.0.0.1:8768',
    name: `${session.documentId}:${session.collaborationEpoch ?? 0}`,
    document: ydoc,
    token: () => liveToken.current,
  }), [session.documentId, session.collaborationEpoch, session.collabUrl, ydoc])
  useEffect(() => { if (provider.isAuthenticated) void provider.sendToken().catch(() => {}) }, [provider, session.token])
  const user = useMemo(() => {
    const id = session.userId || browserUserId()
    return { id, clientId: ydoc.clientID, name: session.displayName?.trim() || `User ${id.slice(0, 4)}`, color: colorFor(id) }
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
      // A stateless update can be echoed before React commits setRevision.
      // Treat our own acknowledged revision as seen before broadcasting it.
      revisionRef.current = Math.max(revisionRef.current ?? -1, next)
      provider.sendStateless(JSON.stringify({ type: 'hcd-fixed-revision', revision: next }))
    }
  }, [provider])
  const avatars = <details className="presence"><summary aria-label={`${localizeSource(locale, "在线协作者")} · ${presence.length}`}><span className="presence-avatars">{presence.slice(0, 3).map(person => <span key={person.id} className="avatar" title={person.name} style={{ background: person.color }}>{person.name.slice(0, 1)}</span>)}</span><span>{presence.length} <LocalText source={" 人在线"} /></span></summary><div className="presence-menu"><strong><LocalText source={"在线协作者 · "} />{localizeDynamic(locale, connection)}</strong>{presence.map(person => <div key={person.id} className="presence-person"><span className="avatar" style={{ background: person.color }}>{person.name.slice(0, 1)}</span><span>{person.name}{person.id === user.id ? localizeSource(locale, '（你）') : ''}</span>{person.connections > 1 && <small>{person.connections} <LocalText source={" 个窗口"} /></small>}</div>)}</div></details>
  return { avatars, announceRevision, connection }
}
