import { Fragment, useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Layers,
  ScanLine,
  SquarePen,
  Workflow, Undo2,
  X,
} from 'lucide-react'
import { AgentCompanionMark } from '@officecli/hcd-reference-editor/react'
import { type PaneHandle, type PaneState } from './DeskPane'
import { api, mutation, type Account, type FileEntry } from './hostApi'
import { baseName, failText, FileGlyph, kindOf } from './deskFiles'

type Phase = 'planning' | 'reading' | 'waiting' | 'drafting' | 'review' | 'queued' | 'editing' | 'complete' | 'failed'
type JobAction = 'approve' | 'retry' | 'recheck' | 'recheck-selection' | 'undo'
export type Job = {
  id: string
  prompt: string
  reply: string
  done: boolean
  targets: {
    id: string
    name: string
    format: string
    scope: string
    phase: Phase
    specUndo?: boolean
    undoable?: boolean
    undoReceipt?: number
    receipt?: number
    error?: string
    retryable?: boolean
    recheckable?: boolean
    dependencyBlocked?: boolean
    dependsOn?: { id: string; name: string; revision?: number; undone: boolean }[]
    reviewId?: string
    changes?: { label: string; before: string | number | null; after: string | number | null }[]
  }[]
}
type Activity = {
  agentName?: string
  fileId: string
  requestId: string
  phase: 'editing' | 'complete' | 'failed'
  revision?: number
  at: number
}
const phaseLabel: Record<Phase, string> = {
  planning: '准备中',
  reading: '已读取',
  waiting: '等待前序文件',
  drafting: '生成预览',
  review: '待审核',
  queued: '等待执行',
  editing: '编辑中',
  complete: '已保存',
  failed: '未完成',
}
export function useDeskTasks(
  account: Account,
  handles: RefObject<Map<string, PaneHandle>>,
  states: Record<string, PaneState>,
  enabled: boolean,
) {
  const [serverJobs, setServerJobs] = useState<Job[]>([])
  const [localJobs, setLocalJobs] = useState<Job[]>([])
  const [external, setExternal] = useState<Activity[]>([])
  const locks = useRef(new Set<string>())
  const serverGeneration = useRef(0)
  const accept = useCallback((job: Job) => {
    serverGeneration.current++
    setServerJobs(previous => [...previous.filter(item => item.id !== job.id), job])
  }, [])
  const jobs = [...serverJobs, ...localJobs.filter(local => !serverJobs.some(server => server.id === local.id))]
  useEffect(() => {
    if (!account.workspace.selectionMcp) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const generation = serverGeneration.current
      try {
        const { jobs } = await api<{ jobs: Job[] }>('/agent-jobs')
        if (alive && generation === serverGeneration.current) setServerJobs(jobs)
      } catch { /* A later poll can recover without changing persisted state. */ }
      if (alive) timer = setTimeout(() => void poll(), 650)
    }
    void poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [account.user.id, account.workspace.selectionMcp])
  useEffect(() => {
    if (!enabled || !account.workspace.selectionMcp) return
    const stream = new EventSource('/workspace/api/agent-activity/stream')
    stream.onmessage = (event) => {
      try {
        const { activity } = JSON.parse(event.data)
        if (Array.isArray(activity)) setExternal(activity)
      } catch {}
    }
    stream.onerror = () => setExternal([])
    return () => { stream.close(); setExternal([]) }
  }, [enabled, account.workspace.selectionMcp])
  async function run(prompt: string, files: FileEntry[]) {
    if (!prompt.trim() || !files.length || files.some((f) => locks.current.has(f.id))) return false
    const targets = files.map(file => ({ file, state: states[file.id], handle: handles.current.get(file.id) }))
    if (targets.some(target => !target.state?.ready || !target.state.scope || !target.handle)) return false
    const id = crypto.randomUUID()
    const planning: Job = {
      id, prompt, reply: '', done: false,
      targets: targets.map(({ file, state }) => ({
        id: file.id, name: file.name, format: file.format, scope: state.scope, phase: 'planning',
      })),
    }
    files.forEach(file => locks.current.add(file.id))
    setLocalJobs(previous => [...previous.slice(-19), planning])
    try {
      await Promise.all(targets.map(target => target.handle!.prepare()))
      const grants = await Promise.all(targets.map(async target => {
        try { return await target.handle!.authorize(target.state.mode, target.state.selectionKey) }
        catch (error) { throw Error(target.file.name + ' · ' + failText(error)) }
      }))
      accept(await api<Job>('/agent-jobs', mutation(account.csrf, { id, prompt, tokens: grants.map(grant => grant.token) })))
      setLocalJobs(previous => previous.filter(job => job.id !== id))
    } catch (error) {
      setLocalJobs(previous => previous.map(job => job.id === id ? {
        ...planning, done: true, reply: failText(error), targets: planning.targets.map(target => ({ ...target, phase: 'failed' })),
      } : job))
    } finally {
      for (const target of targets) {
        locks.current.delete(target.file.id)
        target.handle?.clear()
      }
    }
    return true
  }
  async function transition(jobId: string, action: JobAction, files: string[]) {
    const handle = handles.current.get(files[0])
    const reselect = action === 'recheck-selection'
    const current = states[files[0]]
    if (reselect && (!current?.ready || !current.scope || !handle)) throw Error('请打开此文件并选中需要编辑的内容。')
    if (action === 'undo' || action === 'recheck' || reselect) await handle?.prepare()
    const grant = reselect ? await handle!.authorize(current.mode, current.selectionKey) : null
    const reviews = action === 'approve' ? Object.fromEntries((jobs.find(job => job.id === jobId)?.targets || [])
      .filter(target => files.includes(target.id) && target.reviewId).map(target => [target.id, target.reviewId])) : undefined
    try {
      accept(await api<Job>('/agent-jobs/' + encodeURIComponent(jobId) + '/' + (reselect ? 'recheck' : action),
        mutation(account.csrf, { files, reviews, ...(grant && { token: grant.token }) })))
    } finally {
      if (grant) handle?.clear()
    }
  }
  const editing = new Set<string>(),
    recent = new Map<string, 'complete' | 'failed'>()
  for (const ev of [...external].sort((a, b) => a.at - b.at)) {
    if (ev.phase === 'editing') editing.add(ev.fileId)
    else recent.set(ev.fileId, ev.phase)
  }
  for (const j of jobs)
    for (const t of j.targets)
      if (!j.done && t.phase === 'editing') editing.add(t.id)
  const names = new Map<string, Set<string>>()
  for (const ev of external) if (ev.phase==='editing') {
    const group=names.get(ev.fileId) ?? new Set<string>()
    group.add(ev.agentName || '外部助手')
    names.set(ev.fileId,group)
  }
  const heads = new Map<string, number>()
  for (const ev of external)
    if (ev.revision !== undefined)
      heads.set(ev.fileId, Math.max(heads.get(ev.fileId) ?? 0, ev.revision))
  for (const job of jobs)
    for (const target of job.targets)
      if (target.receipt !== undefined)
        heads.set(
          target.id,
          Math.max(heads.get(target.id) ?? 0, target.undoReceipt ?? target.receipt),
        )
  return { jobs, run, transition, editing, recent, locks, heads, names }
}
type Props = {
  account: Account
  active: string
  files: FileEntry[]
  cursors: Map<string, string>
  states: Record<string, PaneState>
  selected: string[]
  toggle: (id: string) => void
  changedScope: boolean
  confirmScope: () => void
  draft: string
  setDraft: (s: string, restoreIfEmpty?: boolean) => void
  jobs: Job[]
  run: (prompt: string, files: FileEntry[]) => Promise<boolean>
  transition: (id: string, action: JobAction, files: string[]) => Promise<void>
  close: () => void
  open: (id: string) => void
  handles: RefObject<Map<string, PaneHandle>>
  locked: Set<string>
}
export function DeskAgent({
  account,
  active,
  files,
  cursors,
  states,
  selected,
  changedScope, confirmScope,
  toggle,
  draft,
  setDraft,
  jobs,
  run,
  transition,
  close,
  open,
  handles,
  locked,
}: Props) {
  const [picker, setPicker] = useState(true),
    [copyMsg, setCopyMsg] = useState(''),
    [copying, setCopying] = useState(false)
  const [jobActions, setJobActions] = useState<Record<string, string>>({})
  async function act(jobId: string, action: JobAction, files: string[]) {
    setJobActions(previous => ({ ...previous, [jobId]: 'pending' }))
    try { await transition(jobId, action, files); setJobActions(previous => ({ ...previous, [jobId]: '' })) }
    catch (error) { setJobActions(previous => ({ ...previous, [jobId]: failText(error) })) }
  }
  const end = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null)
  const lastJob = jobs.at(-1)?.id
  const targets = files.filter((f) => selected.includes(f.id)),
    running = jobs.some((j) => !j.done)
  const ready =
    !changedScope && targets.length === selected.length && targets.length > 0 &&
    targets.every(
      (f) =>
        !!states[f.id]?.ready && !!states[f.id]?.scope && !locked.has(f.id),
    )
  useEffect(() => {
    if (lastJob) end.current?.scrollIntoView({ block: 'nearest' })
  }, [lastJob])
  async function send() {
    if (!ready || !draft.trim()) return
    const value = draft.trim()
    setDraft('')
    if (!(await run(value, targets))) setDraft(value, true)
  }
  async function share() {
    if (!ready || copying) return
    setCopying(true)
    setCopyMsg('')
    try {
      const connections = await Promise.all(
        targets.map(async (file) => {
          const handle = handles.current.get(file.id)!
          await handle.prepare()
          const grant = await handle.authorize(states[file.id].mode, states[file.id].selectionKey)
          return [
            'office-' + file.format + '-' + file.id,
            {
              type: 'http',
              url: grant.endpoint,
              headers: { Authorization: 'Bearer ' + grant.token },
            },
          ]
        }),
      )
      await navigator.clipboard.writeText(
        JSON.stringify(
          { mcpServers: Object.fromEntries(connections) },
          null,
          2,
        ),
      )
      setCopyMsg(
        '已复制 ' + connections.length + ' 份文件范围的短期 MCP 配置。',
      )
    } catch (e) {
      setCopyMsg(failText(e))
    } finally {
      setCopying(false)
    }
  }
  const pickPrompt = (text: string) => {
    setDraft(text)
    input.current?.focus()
  }
  return (
    <aside className="desk-ai" aria-label="全局 AI">
      <div className="desk-ai-card">
        <header className="desk-ai-head">
          <span className="desk-ai-icon">
            <AgentCompanionMark size={26} state={running ? 'active' : 'idle'} />
          </span>
          <div>
            <h2>墨点</h2>
            <small>全局 AI 搭子</small>
          </div>
          <button aria-label="收起全局 AI" onClick={close}>
            <X size={16} />
          </button>
        </header>
        <div className="desk-ai-scroll">
          {!jobs.length ? (
            <div className="desk-welcome">
              <h3>一起处理文件</h3>
              <p>选好文件和范围，我可以跨标签协作。</p>
              <div className="desk-prompts">
                <button onClick={() => pickPrompt('读取选区')}>
                  <ScanLine />
                  读取所选内容
                  <ChevronRight />
                </button>
                <button onClick={() => pickPrompt('把文档选区同步到其他文件')}>
                  <Workflow />
                  将文档选区同步到其他文件
                  <ChevronRight />
                </button>
                <button onClick={() => pickPrompt('追加：')}>
                  <SquarePen />
                  向文档和白板追加笔记
                  <ChevronRight />
                </button>
              </div>
            </div>
          ) : (
            <div className="desk-thread" role="log" aria-live="polite">
              {jobs.map((job) => (
                <article key={job.id}>
                  <p className="desk-user-message">{job.prompt}</p>
                  <strong className="desk-answer-title">
                    <AgentCompanionMark
                      size={21}
                      state={job.done ? 'complete' : 'active'}
                    />
                    {job.targets.some(target => target.phase === 'review') ? '待审核修改' : job.done ? '任务结果' : '正在处理'}
                  </strong>
                  {job.reply && <p className="desk-answer-text">{job.reply}</p>}
                  {job.targets.map((t) => (
                    <Fragment key={t.id}><button
                      className="desk-receipt"
                      onClick={() => open(t.id)}
                    >
                      <FileGlyph kind={kindOf(t.format)} size={14} />
                      <span>
                        <strong>{baseName(t.name)}</strong>
                        <small>{t.scope}</small>
                        {!!t.dependsOn?.length && <small>
                          依赖 {t.dependsOn.map(source => baseName(source.name) +
                            (source.undone ? '（已撤销）' : source.revision === undefined ? '' : ' · r' + source.revision)).join('、')}
                        </small>}
                        {t.error && (
                          <small className="desk-error">{t.error}</small>
                        )}
                      </span>
                      <em
                        data-phase={t.phase}
                        style={
                          t.phase === 'editing'
                            ? { color: cursors.get(t.id) }
                            : undefined
                        }
                      >
                        {t.phase === 'complete' && <Check size={11} />}{' '}
                        {t.receipt !== undefined
                          ? 'r' + t.receipt
                          : phaseLabel[t.phase]}
                      </em>
                    </button>
                    {t.phase === 'review' && <div className="desk-change-review">
                      <details open>
                        <summary>修改预览 · {t.changes?.length ?? 0} 项</summary>
                        {t.changes?.map(({ label, before, after }, index) => <div className="desk-change" key={index}>
                          <strong>{label}</strong>
                          <dl><dt>原内容</dt><dd>{before == null || before === '' ? '空' : String(before)}</dd>
                            <dt>修改后</dt><dd>{after == null || after === '' ? '空' : String(after)}</dd></dl>
                        </div>)}
                      </details>
                      <button disabled={!job.done || t.dependencyBlocked || jobActions[job.id] === 'pending'} aria-label={`应用到 ${t.name}`}
                        onClick={() => void act(job.id, 'approve', [t.id])}>应用修改</button>
                    </div>}
                    {t.retryable && t.phase === 'failed' && !t.dependencyBlocked && <button className="desk-spec-undo" aria-label={`重试 ${t.name}`}
                      disabled={!job.done || jobActions[job.id] === 'pending'} onClick={() => void act(job.id, 'retry', [t.id])}>重试此文件</button>}
                    {t.recheckable && !t.dependencyBlocked && <>
                      <button className="desk-spec-undo" aria-label={`重新核对 ${t.name}`}
                        disabled={!job.done || jobActions[job.id] === 'pending'} onClick={() => void act(job.id, 'recheck', [t.id])}>重新核对原选区</button>
                      {active === t.id && states[t.id]?.ready && states[t.id].scope && <button className="desk-spec-undo"
                        aria-label={`用当前选区重新核对 ${t.name}`}
                        disabled={!job.done || jobActions[job.id] === 'pending'} onClick={() => void act(job.id, 'recheck-selection', [t.id])}>用当前选区</button>}
                    </>}
                    {t.undoable && <button className="desk-spec-undo" aria-label={t.specUndo ? `撤销 r${t.receipt} 的选句改写` : `撤销 ${t.name} r${t.receipt} 的修改`}
                      disabled={!job.done || t.undoReceipt !== undefined || jobActions[job.id] === 'pending'} onClick={() => void act(job.id, 'undo', [t.id])}>
                      <Undo2 size={13}/>{t.undoReceipt !== undefined ? '已撤销' : '撤销这次修改'}
                    </button>}</Fragment>
                  ))}
                  {job.targets.filter(t => t.phase === 'review' && !t.dependencyBlocked).length > 1 &&
                    <button className="desk-confirm-job" disabled={!job.done || jobActions[job.id] === 'pending'}
                      onClick={() => void act(job.id, 'approve', job.targets.filter(t => t.phase === 'review' && !t.dependencyBlocked).map(t => t.id))}>应用全部待审核修改</button>}
                  {!!jobActions[job.id] && jobActions[job.id] !== 'pending' && <p role="alert" className="desk-error">{jobActions[job.id]}</p>}
                </article>
              ))}
              <div ref={end} />
            </div>
          )}
        </div>
        <div className="desk-agent-controls">
          <button
            className="desk-context-head"
            aria-expanded={picker}
            onClick={() => setPicker(!picker)}
          >
            <Layers size={15} />
            任务文件<span>{targets.length}</span>
            <ChevronDown size={15} className={picker ? '' : 'closed'} />
          </button>
          {picker && (
            <div className="desk-targets">
              {!account.workspace.selectionMcp ? (
                <p>此工作空间尚未启用选区 MCP。</p>
              ) : files.length ? (
                files.map((f) => {
                  const s = states[f.id],
                    ok = !!s?.ready && !!s.scope
                  return (
                    <label key={f.id}>
                      <input
                        type="checkbox"
                        aria-label={'加入任务 ' + f.name}
                        disabled={
                          !ok ||
                          locked.has(f.id) ||
                          (!selected.includes(f.id) && targets.length >= 12)
                        }
                        checked={selected.includes(f.id)}
                        onChange={() => {
                          setCopyMsg('')
                          toggle(f.id)
                        }}
                      />
                      <FileGlyph kind={kindOf(f.format)} size={14} />
                      <span>
                        <strong>{baseName(f.name)}</strong>
                        <small>
                          {!f.canDelegateSelection
                            ? '浏览 · 无选区写入权限'
                            : !s?.ready
                              ? '正在连接'
                              : s.scope || '请先在表格中选择单元格'}
                        </small>
                      </span>
                    </label>
                  )
                })
              ) : (
                <p>打开文件后，在这里指定 AI 的操作范围。</p>
              )}
            </div>
          )}
          {ready && (
            <button
              className="desk-mcp"
              onClick={() => void share()}
              disabled={copying}
            >
              <Copy size={12} />
              复制所选范围的 MCP 配置
            </button>
          )}
          {copyMsg && (
            <p className="desk-copy-status" role="status">
              {copyMsg}
            </p>
          )}
        </div>
      </div>
      <div className="desk-compose">
        {changedScope && <div className="desk-scope-change" role="status">草稿关联的选区已变化或文件已关闭。<button onClick={confirmScope}>使用当前文件和选区</button></div>}
        <textarea
          ref={input}
          aria-label="全局 AI 指令"
          placeholder="输入指令，协同处理文件…"
          maxLength={4000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div>
          <small>{account.workspace.workbenchModel || '本地指令'}</small>
          <button
            aria-label="发送全局指令"
            disabled={!draft.trim() || !ready}
            onClick={() => void send()}
          >
            <ArrowUp size={17} />
          </button>
        </div>
      </div>
    </aside>
  )
}
