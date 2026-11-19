import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDownRight, ArrowLeftRight, FileText, LoaderCircle } from 'lucide-react'
import { api, type Session } from './api.ts'
import { useResourceWorkspace } from './resources/ResourceWorkspace.tsx'
import { useWorkflowWorkspace } from './WorkflowWorkspace.tsx'
import type { Projection } from './schema.ts'
import {
  decodeTransferLink, sameTransferWorkspace, supportsTransfer, transferTarget,
  type TransferDraft, type TransferForm, type TransferReceipt, type TransferRun, type TransferSelection, type TransferTarget,
} from './selectionTransfer.ts'
import { readTabState, tabStateKey, writeTabState } from './tabState.ts'
import { LocalText } from './sourceLocale.tsx'
import './selection-transfer.css'

const newTarget = '@new'
const keyFor = (session: Session) => tabStateKey(session, 'selection-transfer')
const requestRoute = (id: string) => `/selection-transfers/${encodeURIComponent(id)}`
const accessToken = (session: Session) => session.accessToken?.() || session.token
const fileName = (session: Session) => session.title || session.documentId

type TransferWorkspace = {
  requested: string | null
  defaultUploadToken: string
  forms: Record<string, TransferForm>
  change: (session: Session, form: TransferForm) => void
  begin: (session: Session, selection: TransferSelection, epoch: number) => void
  register: (result: TransferReceipt, token: string, title: string) => Promise<boolean>
  navigate: (origin: Session, result: TransferReceipt) => void
  openSource: (origin: Session, link: string) => Promise<void>
  navigation?: TransferReceipt & { sequence: number; sessionKey: string; from: string }
  notice: string
  finish: (sequence: number, message?: string) => void
}
const Context = createContext<TransferWorkspace | null>(null)
export const useSelectionTransferWorkspace = () => useContext(Context)

export function SelectionTransferProvider({ children, register, defaultUploadToken }: {
  children: ReactNode
  register: TransferWorkspace['register']
  defaultUploadToken: string
}) {
  const workspace = useWorkflowWorkspace()
  const [forms, setForms] = useState<TransferWorkspace['forms']>({})
  const [requested, setRequested] = useState<string | null>(null)
  const [navigation, setNavigation] = useState<TransferWorkspace['navigation']>()
  const [notice, setNotice] = useState('')
  const sequence = useRef(0)
  const sessions = useRef(workspace?.sessions || [])
  sessions.current = workspace?.sessions || []
  if (!workspace) return children
  const change = (session: Session, form: TransferForm) => {
    const key = keyFor(session)
    if (!key) return
    writeTabState(key, form)
    setForms(previous => ({ ...previous, [key]: form }))
  }
  const locateSession = (origin: Session, documentId: string) =>
    sessions.current.find(item => item.documentId === documentId && sameTransferWorkspace(item, origin))
  const navigate: TransferWorkspace['navigate'] = (origin, result) => {
    const target = locateSession(origin, result.documentId)
    const key = target && keyFor(target)
    if (!target || !key) throw new Error('请打开原文件或目标文件并重新验证访问权限。')
    setNotice('')
    setNavigation({ ...result, sequence: ++sequence.current, sessionKey: key, from: origin.documentId })
    workspace.activate(target.documentId)
  }
  const value: TransferWorkspace = {
    requested, defaultUploadToken, forms, change, register, navigate, navigation, notice,
    begin(session, selection, sourceEpoch) {
      const target = sessions.current.find(item => transferTarget(session, item))
      change(session, {
        id: crypto.randomUUID(), sourceEpoch, selection, instructions: '',
        targetId: target?.documentId || newTarget, afterBlockId: '',
        title: `${fileName(session)} · ${selection.kind === 'canvas' ? '整理稿' : '讲解白板'}`.replace(/[\\/]/g, ' ').slice(0, 100),
      })
      setRequested(keyFor(session))
    },
    async openSource(origin, link) {
      const parsed = decodeTransferLink(link)
      if (!parsed) throw new Error('来源链接无效。')
      const source = locateSession(origin, parsed.documentId)
      if (!source) throw new Error('请打开来源文件并重新验证访问权限。')
      const result = await (await api(source, `${requestRoute(parsed.id)}/source?section=${parsed.section}`, {
        headers: { 'x-hcd-target-authorization': `Bearer ${accessToken(origin)}` },
      })).json() as TransferReceipt
      navigate(origin, result)
    },
    finish(ticket, message = '') { if (ticket === sequence.current) setNotice(message) },
  }
  return <Context.Provider value={value}>
    {notice && <p className="resource-navigation-error" role="alert">{notice}</p>}
    {children}
  </Context.Provider>
}

export function useTransferForm(session: Session | undefined) {
  const workspace = useSelectionTransferWorkspace()
  const key = session && supportsTransfer(session) ? keyFor(session) : null
  const saved = useMemo(() => readTabState<TransferForm>(key), [key])
  const form = key && workspace ? workspace.forms[key] || saved : undefined
  return { form, wasRequested: !!key && workspace?.requested === key }
}

export function useTransferNavigation(
  session: Session, revision: number | null | undefined, ready: boolean,
  locate: (location: TransferReceipt['location']) => void | Promise<void>,
) {
  const transfers = useSelectionTransferWorkspace(), resources = useResourceWorkspace()
  const requested = transfers?.navigation, key = keyFor(session)
  const active = resources?.activeDocument === session.documentId
  const handler = useRef(locate), finish = useRef(transfers?.finish), handled = useRef(0)
  handler.current = locate; finish.current = transfers?.finish
  useEffect(() => {
    if (!active || !ready || revision == null || !requested || key !== requested.sessionKey
      || requested.sequence <= handled.current || revision < requested.revision) return
    handled.current = requested.sequence
    void Promise.resolve().then(() => handler.current(requested.location))
      .then(() => finish.current?.(requested.sequence), error => finish.current?.(requested.sequence, String(error)))
  }, [active, key, ready, requested, revision])
}

const layouts: Record<string, string> = { grid: '卡片', flow: '步骤', timeline: '时间线', flowchart: '流程图',
  architecture: '架构图', mindmap: '思维导图', lesson: '分步讲解' }

function DraftPreview({ draft }: { draft: TransferDraft }) {
  return <div className="transfer-preview" aria-label="生成预览">
    <h3>{draft.title}</h3>
    {draft.kind === 'document' ? draft.sections.map((section, index) => <article key={index}>
      <h4>{section.heading}</h4>
      {section.paragraphs.map((text, i) => <p key={i}>{text}</p>)}
      {!!section.bullets.length && <ul>{section.bullets.map((text, i) => <li key={i}>{text}</li>)}</ul>}
      <small>{section.sources.length} 个白板来源</small>
    </article>) : draft.sections.map(({ composition, sources }, index) => <article key={index}>
      <header><h4>{composition.title}</h4><small>{layouts[composition.layout]}</small></header>
      <ol className="transfer-preview-nodes">{(composition.diagram?.nodes || composition.items).map((node, i) =>
        <li key={i}>{node.title && <strong>{node.title}</strong>}{node.body && <p>{node.body}</p>}</li>)}</ol>
      {!!composition.diagram?.edges.length && <p className="transfer-preview-edges">{composition.diagram.edges.map(edge => {
        const nodes = composition.diagram?.nodes
        const name = (id: string) => {
          const node = nodes?.find(item => item.id === id)
          return node?.title?.trim() || node?.body?.trim() || id
        }
        return `${name(edge.from)} → ${name(edge.to)}${edge.label ? `（${edge.label}）` : ''}`
      }).join(' · ')}</p>}
      <small>{sources.length} 个来源段落</small>
    </article>)}
  </div>
}

export function SelectionTransferPanel({ session }: { session: Session }) {
  const workspace = useWorkflowWorkspace(), transfers = useSelectionTransferWorkspace()
  const { form } = useTransferForm(session)
  const [run, setRun] = useState<TransferRun | null>(null)
  const [uploadToken, setUploadToken] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [anchors, setAnchors] = useState<Projection['blocks']>([])
  const target = workspace?.sessions.find(item => item.documentId === form?.targetId && transferTarget(session, item))
  const isNew = form?.targetId === newTarget
  const fromBoard = session.format === 'excalidraw'
  const current = run?.id === form?.id ? run : null
  const id = form?.id, submitted = form?.submitted
  useEffect(() => {
    if (!id || !submitted || busy) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const result = await (await api(session, requestRoute(id), { signal: controller.signal })).json() as TransferRun
        if (controller.signal.aborted) return
        setRun(previous => previous?.id === id && previous.status === 'applied' ? previous : result)
        if (result.status === 'generating') timer = setTimeout(() => void read(), 850)
      } catch (cause) {
        if (!controller.signal.aborted) setError(String(cause))
      }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [id, session, submitted, busy])
  useEffect(() => {
    setAnchors([])
    if (!target || !fromBoard || submitted) return
    const controller = new AbortController()
    void api(target, '/editor', { signal: controller.signal }).then(response => response.json() as Promise<Projection>).then(projection => {
      if (!controller.signal.aborted) setAnchors(projection.blocks.filter(block => block.region === 'body').slice(0, 200))
    }).catch(() => { /* 文末始终可选，段落位置需要已加载的编辑器。 */ })
    return () => controller.abort()
  }, [target, fromBoard, submitted])
  if (!transfers || !workspace) return null
  if (!form) return <section className="selection-transfer" aria-label="跨文件生成"><p className="drawer-caption">
    <LocalText source={fromBoard ? '选择白板内容后，点击「整理为文档」。' : '选择正文后，从右键菜单打开「在白板讲解」。'} />
  </p></section>
  const candidates = workspace.sessions.filter(item => transferTarget(session, item))
  const upload = uploadToken || transfers.defaultUploadToken
  const selectedRun = current?.status
  const receipt = current?.status === 'applied' ? current.receipt : null
  const hasResult = !!receipt
  const generated = !!current?.draft
  const location = form.selection.kind === 'canvas' ? `${form.selection.elementIds.length} 个白板对象` : `${form.selection.spans.length} 个正文段落`
  const update = (changes: Partial<TransferForm>) => { setError(''); transfers.change(session, { ...form, ...changes }) }
  const requestHeaders = (): Headers => {
    if (isNew) {
      if (!upload.trim()) throw new Error('新建目标需要当前账号的上传令牌。')
      return new Headers({ 'Content-Type': 'application/json', 'x-hcd-upload-authorization': `Bearer ${upload.trim()}` })
    }
    if (!target) throw new Error('请重新打开目标文件并验证编辑权限。')
    return new Headers({ 'Content-Type': 'application/json', 'x-hcd-target-authorization': `Bearer ${accessToken(target)}` })
  }
  const perform = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await operation() } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  const start = () => perform(async () => {
    const headers = requestHeaders()
    await workspace.prepare(target ? [session, target] : [session])
    const destination: TransferTarget = target
      ? { kind: 'existing', documentId: target.documentId, afterBlockId: form.afterBlockId || undefined }
      : { kind: 'new', title: form.title.trim() }
    update({ submitted: true })
    try {
      const response = await api(session, '/selection-transfers', { method: 'POST', headers, body: JSON.stringify({
        id: form.id, sourceEpoch: form.sourceEpoch, selection: form.selection, target: destination, instructions: form.instructions.trim(),
      }) })
      setRun(await response.json() as TransferRun)
    } catch (cause) {
      if (cause instanceof Error && /^4\d\d:/.test(cause.message)) update({ submitted: false })
      throw cause
    }
  })
  const apply = () => perform(async () => {
    const headers = requestHeaders()
    await workspace.prepare(target ? [session, target] : [session])
    const response = await api(session, `${requestRoute(form.id)}/apply`, { method: 'POST', headers })
    const applied = await response.json() as TransferRun
    if (!applied.receipt) throw new Error('服务未返回提交回执。')
    if (applied.targetToken && !await transfers.register(applied.receipt, applied.targetToken, form.title)) {
      setRun(applied)
      throw new Error('结果已保存。请检查标签页容量，再点击「连接结果文件」。')
    }
    setRun(applied)
  })
  const cancel = () => perform(async () => {
    setRun(await (await api(session, requestRoute(form.id), { method: 'DELETE' })).json() as TransferRun)
  })
  const resultAvailable = !!receipt && workspace.sessions.some(item => item.documentId === receipt.documentId && sameTransferWorkspace(session, item))
  return <section className="selection-transfer" aria-label="跨文件生成">
    <header className="transfer-heading"><ArrowLeftRight size={17} /><h3><LocalText source={fromBoard ? '整理为文档' : '在白板讲解'} /></h3></header>
    <div className="transfer-source"><FileText size={14} /><div><strong>{fileName(session)}</strong><small>{location}{current ? ` · r${current.sourceRevision}` : ''}</small></div></div>
    <form onSubmit={event => { event.preventDefault(); void start() }}>
      <label><LocalText source="目标文件" /><select aria-label="目标文件" disabled={busy || submitted} value={form.targetId} onChange={event => update({ targetId: event.target.value, afterBlockId: '' })}>
        {candidates.map(item => <option key={item.documentId} value={item.documentId}>{fileName(item)}</option>)}
        {!isNew && !target && <option value={form.targetId}>{form.targetId} · 待连接</option>}
        <option value={newTarget}>{fromBoard ? '新建 Markdown 文档' : '新建白板'}</option>
      </select></label>
      {fromBoard && target && !submitted && <label><LocalText source="插入位置" /><select aria-label="插入位置" value={form.afterBlockId} onChange={event => update({ afterBlockId: event.target.value })}>
        <option value="">文末</option>
        {anchors.map((block, index) => <option value={block.blockId} key={block.blockId}>{`第 ${index + 1} 段后 · ${block.content.inlines.map(inline => inline.text).join('').slice(0, 56)}`}</option>)}
      </select></label>}
      {isNew && <>
        <label><LocalText source="新文件名称" /><input aria-label="新文件名称" value={form.title} disabled={busy || submitted} onChange={event => update({ title: event.target.value })} maxLength={100} required /></label>
        {(!hasResult || !resultAvailable) && <label><LocalText source="上传令牌" /><input aria-label="上传令牌" type="password" value={upload} onChange={event => setUploadToken(event.target.value)} autoComplete="off" /></label>}
      </>}
      {!submitted && <label><LocalText source="生成要求（可选）" /><textarea aria-label="生成要求" rows={3} maxLength={4000} value={form.instructions} disabled={busy} onChange={event => update({ instructions: event.target.value })} /></label>}
      {submitted && fromBoard && form.afterBlockId && <small><LocalText source="追加到已选段落后" /></small>}
      {!submitted && <button type="submit" className="transfer-primary" disabled={busy || (!target && !isNew) || isNew && (!form.title.trim() || !upload.trim())}>
        {busy && <LoaderCircle size={14} className="agent-spinner" />}<LocalText source="生成预览" />
      </button>}
    </form>
    {(error || current?.error) && <p role="alert" className="agent-task-error">{error || current?.error}</p>}
    {selectedRun === 'interrupted' && <p role="status"><LocalText source="生成已中断，可以重新生成预览。" /></p>}
    {submitted && (!current || selectedRun === 'generating') && !error && <div className="transfer-progress" role="status">
      <LoaderCircle size={16} className="agent-spinner" /><LocalText source="正在整理选区…" />
      {selectedRun === 'generating' && <button type="button" disabled={busy} onClick={() => void cancel()}><LocalText source="取消生成" /></button>}
    </div>}
    {current?.draft && <DraftPreview draft={current.draft} />}
    {generated && !hasResult && <div className="transfer-actions">
      <span><LocalText source="应用后按目标文件的权限共享" /></span>
      <button type="button" className="transfer-primary" disabled={busy || (!target && !isNew) || isNew && !upload.trim()} onClick={() => void apply()}><LocalText source={fromBoard ? '写入文档' : '追加到白板'} /></button>
    </div>}
    {receipt && <div className="transfer-actions">
      <span role="status"><LocalText source="已应用" /> · r{receipt.revision}</span>
      {resultAvailable ? <button type="button" className="transfer-primary" onClick={() => void perform(async () => transfers.navigate(session, receipt))}><ArrowDownRight size={15} /><LocalText source="查看结果" /></button>
        : isNew && <button type="button" className="transfer-primary" disabled={!upload.trim() || busy} onClick={() => void apply()}><LocalText source="连接结果文件" /></button>}
    </div>}
    {submitted && (selectedRun !== 'generating' && (current || error)) && <button type="button" disabled={busy} onClick={() => {
      setRun(null); update({ submitted: false, id: crypto.randomUUID() })
    }}><LocalText source="重新配置生成" /></button>}
    {submitted && !current && error && <button type="button" disabled={busy} onClick={() => void start()}><LocalText source="重试原任务" /></button>}
  </section>
}
