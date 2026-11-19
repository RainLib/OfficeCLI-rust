import { useState, useRef, useCallback, useEffect } from 'react'
import type { HcdEmbedSelection } from '@officecli/hcd-reference-editor/react'
import {
  api,
  mutation,
  type Account,
  type FileEntry,
  type Launch,
} from './hostApi'
import type { Grant } from './agent'
export function useFileBinding(file: FileEntry, account: Account) {
  const [launch, setLaunch] = useState<Launch | null>(null),
    [error, setError] = useState('')
  const [instanceId] = useState(() => crypto.randomUUID()),
    [launchId] = useState(() => crypto.randomUUID())
  const [selection, setSelection] = useState<HcdEmbedSelection | null>(null),
    current = useRef<HcdEmbedSelection | null>(null)
  const sequence = useRef(0),
    issued = useRef(false),
    alive = useRef(true)
  const [grant, setGrant] = useState<Grant | null>(null),
    [notice, setNotice] = useState('')
  const grantRef = useRef<Grant | null>(null)
  const clear = useCallback(() => {
    grantRef.current=null
    const generation = ++sequence.current
    setGrant(null)
    if (!issued.current) return
    issued.current = false
    void api('/embed/selection', {
      ...mutation(
        account.csrf,
        { instanceId, generation, selection: null },
        'PUT',
      ),
      keepalive: true,
    }).catch(() => {})
  }, [account.csrf, instanceId])
  const report = useCallback(
    (next: HcdEmbedSelection | null) => {
      if (JSON.stringify(current.current) === JSON.stringify(next)) return
      const old=current.current
      const sameSpec=next?.target.kind==='canvas'&&next.target.spec&&old?.target.kind==='canvas'&&old.target.spec&&old.documentId===next.documentId&&old.collaborationEpoch===next.collaborationEpoch&&JSON.stringify(old.target.elementIds)===JSON.stringify(next.target.elementIds)
      const sameSentence=next?.target.kind==='spec' && old?.target.kind==='spec' && old.documentId===next.documentId && old.collaborationEpoch===next.collaborationEpoch && next.target.id===old.target.id && next.target.anchor===old.target.anchor && next.target.head===old.target.head
      if(!sameSpec && !sameSentence)clear()
      current.current = next
      setSelection(next)
    },
    [clear],
  )
  useEffect(() => {
    alive.current = true
    window.addEventListener('pagehide', clear)
    return () => {
      alive.current = false
      window.removeEventListener('pagehide', clear)
      clear()
    }
  }, [clear])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const renew = async () => {
      try {
        const next = await api<Launch>(
          '/files/' + file.id + '/editor-session',
          mutation(account.csrf, { sessionId: launchId }),
        )
        if (!active) return
        setLaunch(next)
        setError('')
        timer = setTimeout(
          () => void renew(),
          Math.max(5000, next.expiresAt * 1000 - Date.now() - 60000),
        )
      } catch (c) {
        if (active) {
          setLaunch(null)
          clear()
          setError(String(c))
          timer = setTimeout(() => void renew(), 15000)
        }
      }
    }
    void renew()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [file.id, account.csrf, launchId, clear])
  useEffect(() => {
    if (!grant) return
    const timer = setTimeout(
      () => {
        clear()
        setNotice('授权已到期，可重新连接当前选区。')
      },
      Math.max(0, grant.expiresAt * 1000 - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [grant, clear])
  const grantKind = useRef<'append' | 'selection'>('selection')
  async function connect(mode: 'selection' | 'append' = 'selection') {
    const existing=grantRef.current
    if (mode===grantKind.current && existing && existing.expiresAt*1000>Date.now()) return existing
    if (mode === 'selection' && !current.current)
      throw new Error('请先在编辑器中选中文字或白板对象。')
    const generation = ++sequence.current
    issued.current = true
    grantKind.current = mode
    let target:
      | HcdEmbedSelection
      | {
          documentId: string
          revision: number
          collaborationEpoch: number
          target: { kind: 'append' }
        }
      | null = current.current
    if (mode === 'append') {
      if (!launch) throw Error('文件仍在加载。')
      const path = '/v1/documents/' + encodeURIComponent(launch.documentId)
      const options = { headers: { Authorization: 'Bearer ' + launch.token } }
      const [m, a] = await Promise.all([
        fetch(path, options),
        fetch(path + '/auth', options),
      ])
      if (!m.ok || !a.ok) throw Error('请重新打开该文件。')
      target = {
        documentId: launch.documentId,
        revision: (await m.json()).revision,
        collaborationEpoch: (await a.json()).collaborationEpoch,
        target: { kind: 'append' },
      }
      if (!alive.current || generation !== sequence.current)
        throw Error('文件或选区已改变。')
    }
    const next = await api<Grant>(
      '/embed/selection',
      mutation(
        account.csrf,
        {
          instanceId,
          generation,
          fileId: file.id,
          launchId,
          selection: target,
        },
        'PUT',
      ),
    )
    if (!alive.current || sequence.current !== generation)
      throw new Error('选区已改变，请重新操作。')
    grantRef.current=next
    setGrant(next)
    return next
  }
  return {
    launch,
    selection,
    report,
    grant,
    connect,
    clear,
    error,
    setError,
    notice,
    setNotice,
    alive,
  }
}
