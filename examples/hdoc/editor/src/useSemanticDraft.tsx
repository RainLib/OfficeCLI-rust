import { useEffect, useMemo, useRef, useState } from 'react'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import { api, type Session } from './api.ts'
import { discardDraft, draftNamespace, DraftJournal, DRAFT_RESTORE_ORIGIN, readDrafts, restoreDraft, type RecoverableDraft } from './draftJournal.ts'
import { LocalText } from './sourceLocale.tsx'

type Protection = { document: Y.Doc | null; status: 'loading' | 'protected' | 'writing' | 'failed'; conflicts: RecoverableDraft[]; restored: boolean }

export function useSemanticDraft(session: Session, document: Y.Doc, provider: HocuspocusProvider, onRestored: () => void) {
  const [state, setState] = useState<Protection>({ document: null, status: 'loading', conflicts: [], restored: false })
  const lifecycle = useRef<{ version: () => number; acknowledge: (version: number) => void }>({ version: () => -1, acknowledge: () => {} })
  const restoredCallback = useRef(onRestored)
  restoredCallback.current = onRestored
  useEffect(() => {
    let active = true, started = false, unavailable = false, current: DraftJournal | null = null
    let contentVersion = 0, acknowledgedVersion = 0
    const waiting: Array<{ bytes: Uint8Array; local: boolean }> = []
    lifecycle.current = {
      version: () => contentVersion,
      acknowledge: version => {
        if (version < 0 || version !== contentVersion) return
        acknowledgedVersion = version
        current?.acknowledge(current.localVersion)
      },
    }
    const failed = () => {
      unavailable = true
      if (active) setState(previous => previous.document === document && previous.status === 'failed' ? previous : { ...previous, document, status: 'failed' })
    }
    const changed = (error?: unknown) => {
      if (!active) return
      if (error) { failed(); return }
      const status = current?.pending ? 'writing' : 'protected'
      setState(previous => previous.status === status ? previous : { ...previous, document, status })
    }
    const update = (bytes: Uint8Array, origin: unknown, _document: Y.Doc, transaction: Y.Transaction) => {
      if (origin === DRAFT_RESTORE_ORIGIN) return
      const local = transaction.local && origin !== 'hcd-canonical-ids'
      if (local) contentVersion++
      if (current) current.append(bytes, local)
      else if (!unavailable) waiting.push({ bytes: Uint8Array.from(bytes), local })
    }
    const initialize = async () => {
      if (started || !provider.isSynced) return
      started = true
      if (session.scope !== 'write') {
        if (active) setState({ document, status: 'protected', conflicts: [], restored: false })
        return
      }
      document.on('update', update)
      try {
        // Authenticate before reading or merging any local content. An old tab
        // must not restore a former room into a new collaboration epoch.
        const access = await (await api(session, '/auth')).json() as { scope: string; collaborationEpoch: number; userId?: string; serviceId?: string }
        if (!active) return
        if (access.scope !== 'write' || access.collaborationEpoch !== (session.collaborationEpoch ?? 0)) throw new Error('文档访问或版本已变化')
        const generation = document.getMap('hcd-room').get('generation')
        if (typeof generation !== 'string' || !generation) throw new Error('缺少协同房间身份')
        if (typeof access.serviceId !== 'string' || !access.serviceId) throw new Error('服务尚未提供持久身份')
        const namespace = await draftNamespace(session.apiUrl || '', access.userId, session.token, session.documentId, access.serviceId)
        const drafts = await readDrafts(namespace)
        if (!active) return
        const recovered: RecoverableDraft[] = [], conflicts: RecoverableDraft[] = []
        for (const draft of drafts) {
          if (draft.stream.epoch !== access.collaborationEpoch || draft.stream.generation !== generation) { conflicts.push(draft); continue }
          try { restoreDraft(document, draft); recovered.push(draft) }
          catch { conflicts.push({ ...draft, recoveryError: '本地草稿日志无法合并，请下载原始日志保留。' }) }
        }
        const copiedThrough = waiting.length
        current = await DraftJournal.create(namespace, session.documentId, access.collaborationEpoch, document, recovered, changed, waiting.slice(0, copiedThrough).some(update => update.local))
        if (!active) { current.dispose(); return }
        // The baseline already contains earlier buffered updates; retain only
        // those arriving while its IndexedDB transaction was committing.
        for (const pending of waiting.slice(copiedThrough)) current.append(pending.bytes, pending.local)
        if (recovered.length) { contentVersion++; restoredCallback.current() }
        setState({ document, status: current.pending ? 'writing' : 'protected', conflicts, restored: recovered.length > 0 })
      } catch { failed() }
    }
    provider.on('synced', initialize)
    if (provider.isSynced) void initialize()
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (current?.pending || unavailable && contentVersion !== acknowledgedVersion || !current && waiting.some(update => update.local)) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      active = false
      provider.off('synced', initialize)
      document.off('update', update)
      window.removeEventListener('beforeunload', beforeUnload)
      current?.dispose()
      lifecycle.current = { version: () => -1, acknowledge: () => {} }
    }
  }, [document, provider, session.documentId, session.collaborationEpoch, session.scope, session.apiUrl, session.userId, session.token])
  return {
    ready: state.document === document && state.status !== 'loading',
    state,
    version: () => lifecycle.current.version(),
    acknowledge: (version: number) => lifecycle.current.acknowledge(version),
    dismiss: async (draft: RecoverableDraft) => {
      await discardDraft(draft)
      setState(previous => ({ ...previous, conflicts: previous.conflicts.filter(candidate => candidate.stream.id !== draft.stream.id) }))
    },
  }
}

function draftContent(draft: RecoverableDraft) {
  const document = new Y.Doc()
  try {
    Y.applyUpdate(document, Y.mergeUpdates(draft.updates))
    return yDocToProsemirrorJSON(document, 'default')
  } finally { document.destroy() }
}

function textContent(node: { text?: string; content?: Array<unknown> }): string {
  return node.text ?? node.content?.map(child => textContent(child as typeof node)).join('\n') ?? ''
}

function encodeUpdate(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}

function downloadDraft(draft: RecoverableDraft) {
  let content: unknown, yjsUpdate: string | undefined, updateLog: string[] | undefined
  try { content = draftContent(draft); yjsUpdate = encodeUpdate(Y.mergeUpdates(draft.updates)) }
  catch { updateLog = draft.updates.map(encodeUpdate) }
  const value = { schemaVersion: 'hcd-local-draft/1', documentId: draft.stream.documentId, collaborationEpoch: draft.stream.epoch,
    roomGeneration: draft.stream.generation, updatedAt: draft.stream.updatedAt, content, yjsUpdate, updateLog }
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const anchor = window.document.createElement('a')
  anchor.href = url; anchor.download = `${draft.stream.documentId}-local-draft.json`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function DraftRecovery({ protection, currentText, onError }: { protection: ReturnType<typeof useSemanticDraft>; currentText: string; onError: (message: string) => void }) {
  const { state } = protection
  const previews = useMemo(() => new Map(state.conflicts.map(draft => {
    try { return [draft.stream.id, textContent(draftContent(draft))] }
    catch { return [draft.stream.id, '本地草稿日志无法解析，请下载原始日志保留。'] }
  })), [state.conflicts])
  return <>
    {state.status === 'failed' && <section className="epoch-draft-conflict" role="alert" aria-label="本地草稿保护不可用">
      <strong><LocalText source="本地草稿保护不可用" /></strong><p><LocalText source="可以继续编辑，请确认服务端已保存后再关闭窗口。尚未同步的修改可能无法在重新打开后恢复。" /></p>
    </section>}
    {state.conflicts.map(draft => <details className="epoch-draft-conflict" key={draft.stream.id} aria-label="保留的本地草稿">
      <summary><LocalText source="有一份本地草稿需要核对" /></summary>
      <p><LocalText source="文档版本已变化，这份草稿已单独保留。请下载或复制需要的内容，与当前文档核对。" /></p>
      {draft.recoveryError && <p role="alert"><LocalText source={draft.recoveryError} /></p>}
      <div><label><LocalText source="本地草稿" /><textarea aria-label="保留的本地草稿内容" readOnly value={previews.get(draft.stream.id) || ''} /></label>
        <label><LocalText source="最新文档" /><textarea aria-label="当前文档内容" readOnly value={currentText} /></label></div>
      <button onClick={() => downloadDraft(draft)}><LocalText source="下载本地草稿" /></button>
      <button onClick={() => void protection.dismiss(draft).catch(() => onError('草稿仍在保留，请重试。'))}><LocalText source="舍弃这份草稿" /></button>
    </details>)}
  </>
}
