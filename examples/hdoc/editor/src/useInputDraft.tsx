import { useEffect, useRef, useState } from 'react'
import { api, type Session } from './api.ts'
import { draftNamespace } from './draftJournal.ts'
import { discardInputDraft, InputDraftJournal, readInputDrafts, type InputDraft } from './inputDraftJournal.ts'
import { LocalText } from './sourceLocale.tsx'

type Lifecycle = { version: number; content: string | null; journal: InputDraftJournal | null; active: boolean }
type Protection = 'loading' | 'protected' | 'writing' | 'failed'

export function useInputDraft(session: Session, epoch: number | undefined) {
  const lifecycle = useRef<Lifecycle | null>(null)
  const [status, setStatus] = useState<Protection>('loading')
  const [drafts, setDrafts] = useState<InputDraft[]>([])
  useEffect(() => {
    const current: Lifecycle = { version: 0, content: null, journal: null, active: true }
    lifecycle.current = current
    setStatus('loading'); setDrafts([])
    const changed = (error?: unknown) => {
      if (current.active) setStatus(error ? 'failed' : current.journal?.pending ? 'writing' : 'protected')
    }
    if (session.scope === 'write') void (async () => {
      try {
        // Never trust the displayed collaborator identity to access local input.
        const access = await (await api(session, '/auth')).json() as { scope: string; collaborationEpoch: number; serviceId?: string; userId?: string }
        if (!current.active) return
        if (access.scope !== 'write' || access.collaborationEpoch !== (epoch ?? 0) || !access.serviceId) throw new Error('文档访问或版本已变化')
        const namespace = await draftNamespace(session.apiUrl || '', access.userId, session.token, session.documentId, access.serviceId)
        const records = await readInputDrafts(namespace)
        if (!current.active) return
        const journal = await InputDraftJournal.create(namespace, session.documentId, access.collaborationEpoch, changed)
        if (!current.active) { journal.dispose(); return }
        current.journal = journal
        if (current.content !== null) journal.replace(current.content)
        setDrafts(records); changed()
      } catch (error) { changed(error) }
    })()
    else setStatus('protected')
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (current.content !== null && (!current.journal || current.journal.pending || statusRef.current === 'failed')) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      current.active = false; current.journal?.dispose()
      window.removeEventListener('beforeunload', beforeUnload)
      if (lifecycle.current === current) lifecycle.current = null
    }
  }, [session.documentId, session.apiUrl, session.token, session.scope, epoch])
  const statusRef = useRef(status)
  statusRef.current = status
  function write(content: unknown | null) {
    const current = lifecycle.current
    if (!current?.active || session.scope !== 'write') return
    current.content = content === null ? null : JSON.stringify(content)
    current.version++
    current.journal?.replace(current.content)
  }
  function capture() { const current = lifecycle.current; return current ? { current, version: current.version } : null }
  function acknowledge(receipt: ReturnType<typeof capture>) {
    if (receipt && lifecycle.current === receipt.current && receipt.current.active && receipt.version === receipt.current.version) write(null)
  }
  function unchanged(receipt: ReturnType<typeof capture>) {
    return !!receipt && lifecycle.current === receipt.current && receipt.current.active && receipt.version === receipt.current.version
  }
  async function flush(receipt: ReturnType<typeof capture>, content: unknown) {
    if (!receipt || !unchanged(receipt) || !receipt.current.journal) throw new Error('本地草稿保护尚未就绪，请保留输入并稍后重试')
    if (receipt.current.content !== JSON.stringify(content)) throw new Error('本地草稿与待提交内容不一致，请下载保留后重新打开文档')
    await receipt.current.journal.flush()
    if (!unchanged(receipt)) throw new Error('当前输入已变化，请重新核对')
  }
  async function validate(draft: InputDraft) {
    const receipt = capture()
    const access = await (await api(session, '/auth')).json() as { scope: string; collaborationEpoch: number; serviceId?: string; userId?: string }
    if (!unchanged(receipt) || access.scope !== 'write' || access.collaborationEpoch !== (epoch ?? 0) || access.collaborationEpoch !== draft.epoch || !access.serviceId) throw new Error('文档访问或协同版本已变化；草稿已保留，请下载核对')
    const namespace = await draftNamespace(session.apiUrl || '', access.userId, session.token, session.documentId, access.serviceId)
    if (!unchanged(receipt) || namespace !== draft.namespace || draft.documentId !== session.documentId) throw new Error('文档身份已变化；草稿已保留，请下载核对')
    return receipt
  }
  async function dismiss(draft: InputDraft) {
    const current = lifecycle.current
    await discardInputDraft(draft)
    if (current?.active && lifecycle.current === current) setDrafts(previous => previous.filter(item => item.id !== draft.id))
  }
  async function adopt(draft: InputDraft) {
    const current = lifecycle.current
    if (!current?.active || !current.journal || statusRef.current === 'failed') throw new Error('本地保护尚未就绪，请先下载草稿保留')
    write(JSON.parse(draft.content))
    const receipt = capture()
    await current.journal.flush()
    // Own the restored copy durably before retiring the abandoned stream.
    if (!unchanged(receipt)) throw new Error('当前输入已变化；原草稿仍保留，请重新核对')
    await dismiss(draft)
    if (!unchanged(receipt)) throw new Error('当前输入已变化；请重新核对')
  }
  return { status, drafts, write, capture, acknowledge, unchanged, validate, dismiss, adopt, flush }
}

function downloadInput(draft: InputDraft) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 'hcd-input-draft/1', documentId: draft.documentId,
    epoch: draft.epoch, updatedAt: draft.updatedAt, content: draft.content }, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `${draft.documentId}-input-draft.json`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function previewInput(draft: InputDraft) {
  try { const value = JSON.parse(draft.content); return typeof value?.text === 'string' ? value.text : draft.content }
  catch { return draft.content }
}

function hasRichInput(draft: InputDraft) {
  try {
    const input = JSON.parse(draft.content)
    return Array.isArray(input?.richRuns) || input?.schemaVersion === 'hcd-grid-batch-input/1'
      && input.patch?.operations?.some((op: { op: string }) => op.op === 'xlsx.richText.set' || op.op === 'xlsx.richText.create')
  } catch { return false }
}

export function InputDraftRecovery({ protection, disabled, onRestore, onError }: {
  protection: ReturnType<typeof useInputDraft>; disabled: boolean
  onRestore: (draft: InputDraft) => Promise<void>; onError: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try { await action() } catch (error) { onError(String(error)) } finally { setBusy(false) }
  }
  return <>
    {protection.status === 'failed' && <section className="epoch-draft-conflict" role="alert" aria-label="本地草稿保护不可用">
      <strong><LocalText source="本地草稿保护不可用" /></strong><p><LocalText source="请保存成功后再关闭窗口；尚未提交的输入可能无法恢复。" /></p>
    </section>}
    {protection.drafts.map(draft => <details className="epoch-draft-conflict" key={draft.id} aria-label="保留的未提交输入">
      <summary><LocalText source="有一份未提交输入可以恢复" /></summary>
      <p><LocalText source="恢复会重新核对文档版本，只找回输入。确认后保存才会修改文档。版本变化时请下载核对。" /></p>
      <textarea aria-label="保留的未提交输入内容" readOnly value={previewInput(draft)} />
      {hasRichInput(draft) && <p><LocalText source="包含文字格式，恢复后可一起应用。" /></p>}
      <button disabled={disabled || busy || protection.status !== 'protected'} onClick={() => void run(() => onRestore(draft))}><LocalText source="恢复输入" /></button>
      <button onClick={() => downloadInput(draft)}><LocalText source="下载本地草稿" /></button>
      <button disabled={busy} onClick={() => void run(() => protection.dismiss(draft))}><LocalText source="舍弃这份草稿" /></button>
    </details>)}
  </>
}
