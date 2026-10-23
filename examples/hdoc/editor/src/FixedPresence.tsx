import { useEffect, useMemo, useState } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { Session } from './api.ts'
import { useI18n } from './i18n.tsx'

type Selection = { page: number; nodeId: string; kind: 'text' | 'image' }
export type FixedPeer = { clientId: number; id: string; name: string; color: string; selection?: Selection }
const colors = ['#3478c0', '#13866a', '#9a5abb', '#d17d20', '#d84a54']
function color(id: string) { return colors[[...id].reduce((sum, char) => (sum * 31 + char.codePointAt(0)!) >>> 0, 0) % colors.length] }
export function useFixedPresence(session: Session, selection: Selection | null) {
  const [peers, setPeers] = useState<FixedPeer[]>([])
  const [connected, setConnected] = useState(false)
  const local = useMemo(() => ({ id: session.userId || crypto.randomUUID(), name: [...(session.displayName?.trim() || session.userId || 'User')].slice(0, 64).join('') }), [session.userId, session.displayName])
  const document = useMemo(() => new Y.Doc(), [session.documentId])
  const provider = useMemo(() => new HocuspocusProvider({ url: session.collabUrl || import.meta.env.VITE_HCD_COLLAB_URL || 'ws://127.0.0.1:8768',
    name: `fixed:${session.documentId}:0`, document, token: session.token }), [session.documentId, session.collaborationEpoch, session.token, session.collabUrl, document])
  useEffect(() => {
    const update = () => {
      const next: FixedPeer[] = []
      for (const [clientId, state] of provider.awareness?.getStates() || []) {
        const user = state.user as { id?: unknown; name?: unknown } | undefined
        if (typeof user?.id !== 'string' || typeof user.name !== 'string') continue
        const raw = state.selection as Partial<Selection> | undefined
        const selection = raw && Number.isSafeInteger(raw.page) && typeof raw.nodeId === 'string' && raw.nodeId.length < 160 && (raw.kind === 'text' || raw.kind === 'image') ? raw as Selection : undefined
        next.push({ clientId, id: user.id, name: [...user.name].slice(0, 64).join(''), color: color(user.id), selection })
      }
      setPeers(next)
    }
    const status = ({ status }: { status: string }) => setConnected(status === 'connected')
    provider.on('status', status)
    provider.awareness?.on('change', update)
    provider.awareness?.setLocalStateField('user', local)
    update()
    return () => { provider.off('status', status); provider.awareness?.off('change', update); provider.destroy(); document.destroy() }
  }, [provider, document, local])
  useEffect(() => { provider.awareness?.setLocalStateField('selection', selection) }, [provider, selection?.page, selection?.nodeId, selection?.kind])
  return { peers, others: peers.filter(peer => peer.clientId !== document.clientID), connected }
}

export function FixedPresenceIndicator({ peers, connected }: { peers: FixedPeer[]; connected: boolean }) {
  const { t } = useI18n()
  const people = [...new Map(peers.map(peer => [peer.id, peer])).values()]
  return <details className="fixed-presence"><summary aria-label={t('onlineCollaborators')}><span className={`fixed-presence-dot ${connected ? 'connected' : ''}`} /><span>{connected ? t('onlineCount', { count: people.length }) : t('collaborationConnecting')}</span></summary><div><strong>{t('onlineCollaborators')}</strong>{people.map(peer => <p key={peer.id}><i style={{ background: peer.color }}>{[...peer.name][0]}</i><span>{peer.name}</span></p>)}<small>{t('fixedCollaborationHint')}</small></div></details>
}
