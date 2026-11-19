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
import { applyAgentAction, type Grant, type SpecUndo, type PlannedAction } from './agent'
import { type PaneHandle, type PaneState } from './DeskPane'
import { api, mutation, type Account, type FileEntry } from './hostApi'
import { baseName, failText, FileGlyph, kindOf } from './deskFiles'

type Phase = 'planning' | 'reading' | 'editing' | 'complete' | 'failed'
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
    specUndo?: SpecUndo
    receipt?: number
    error?: string
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
  const [jobs, setJobs] = useState<Job[]>([]),
    [external, setExternal] = useState<Activity[]>([])
  const locks = useRef(new Set<string>())
  const patch = useCallback(
    (id: string, fn: (row: Job) => Job) =>
      setJobs((rows) => rows.map((r) => (r.id === id ? fn(r) : r))),
    [],
  )
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
    return () => {
      stream.close()
      setExternal([])
    }
  }, [enabled, account.workspace.selectionMcp])
  async function run(prompt: string, files: FileEntry[]) {
    if (
      !prompt.trim() ||
      !files.length ||
      files.some((f) => locks.current.has(f.id))
    )
      return false
    const targets = files.map((f) => ({
      file: f,
      state: states[f.id],
      handle: handles.current.get(f.id),
    }))
    if (targets.some((t) => !t.state?.ready || !t.state.scope || !t.handle))
      return false
    const id = crypto.randomUUID()
    files.forEach((f) => locks.current.add(f.id))
    setJobs((rows) => [
      ...rows.slice(-29),
      {
        id,
        prompt,
        reply: '',
        done: false,
        targets: targets.map((t) => ({
          id: t.file.id,
          name: t.file.name,
          format: t.file.format,
          scope: t.state.scope,
          phase: 'planning',
        })),
      },
    ])
    const change = (fileId: string, update: Partial<Job['targets'][number]>) =>
      patch(id, (j) => ({
        ...j,
        targets: j.targets.map((t) =>
          t.id === fileId ? { ...t, ...update } : t,
        ),
      }))
    const grants = new Map<string, Grant>()
    try {
      // Prepare each editor before issuing any grant. A local draft may advance its revision.
      await Promise.all(targets.map((t) => t.handle!.prepare()))
      await Promise.all(
        targets.map(async (t) => {
          try {
            grants.set(t.file.id, await t.handle!.authorize(t.state.mode))
          } catch (e) {
            throw Error(t.file.name + ' · ' + failText(e))
          }
        }),
      )
      const plan = await api<{ reply: string; actions: PlannedAction[] }>(
        '/agent-plan',
        mutation(account.csrf, {
          prompt,
          tokens: targets.map((t) => grants.get(t.file.id)!.token),
        }),
      )
      patch(id, (j) => ({
        ...j,
        reply: plan.reply,
        targets: j.targets.map((t) => ({ ...t, phase: 'reading' })),
      }))
      await Promise.all(
        plan.actions.map(async (action) => {
          const grant = grants.get(action.fileId)
          if (!grant) throw Error('任务返回了未授权的文件。')
          change(action.fileId, { phase: 'editing' })
          try {
            const receipt = await applyAgentAction(
              grant,
              action,
              crypto.randomUUID(),
            )
            change(action.fileId, {
              phase: 'complete',
              receipt: receipt.revision, specUndo:receipt.specUndo,
            })
          } catch (e) {
            change(action.fileId, { phase: 'failed', error: failText(e) })
          }
        }),
      )
    } catch (e) {
      patch(id, (j) => ({
        ...j,
        reply: failText(e),
        targets: j.targets.map((t) => ({ ...t, phase: 'failed' })),
      }))
    } finally {
      for (const t of targets) {
        locks.current.delete(t.file.id)
        t.handle?.clear()
      }
      patch(id, (j) => ({ ...j, done: true }))
    }
    return true
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
          Math.max(heads.get(target.id) ?? 0, target.receipt),
        )
  return { jobs, run, editing, recent, locks, heads, names }
}
type Props = {
  account: Account
  files: FileEntry[]
  cursors: Map<string, string>
  states: Record<string, PaneState>
  selected: string[]
  toggle: (id: string) => void
  draft: string
  setDraft: (s: string) => void
  jobs: Job[]
  run: (prompt: string, files: FileEntry[]) => Promise<boolean>
  close: () => void
  open: (id: string) => void
  handles: RefObject<Map<string, PaneHandle>>
  locked: Set<string>
}
export function DeskAgent({
  account,
  files,
  cursors,
  states,
  selected,
  toggle,
  draft,
  setDraft,
  jobs,
  run,
  close,
  open,
  handles,
  locked,
}: Props) {
  const [picker, setPicker] = useState(true),
    [copyMsg, setCopyMsg] = useState(''),
    [copying, setCopying] = useState(false)
  const [undoStatus,setUndoStatus]=useState<Record<string,string>>({})
  async function undo(fileId:string, ref:SpecUndo) {
    const key=fileId+':'+ref.revision, handle=handles.current.get(fileId)
    if(!handle)return
    setUndoStatus(s=>({...s,[key]:'正在撤销'}))
    try { await handle.undoSpec(ref); setUndoStatus(s=>({...s,[key]:'已撤销'})) }
    catch(e){setUndoStatus(s=>({...s,[key]:failText(e)}))}
  }
  const end = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null)
  const targets = files.filter((f) => selected.includes(f.id)),
    running = jobs.some((j) => !j.done)
  const ready =
    targets.length > 0 &&
    targets.every(
      (f) =>
        !!states[f.id]?.ready && !!states[f.id]?.scope && !locked.has(f.id),
    )
  useEffect(() => {
    if (jobs.length) end.current?.scrollIntoView({ block: 'nearest' })
  }, [jobs])
  async function send() {
    if (!ready || !draft.trim()) return
    const value = draft.trim()
    setDraft('')
    if (!(await run(value, targets))) setDraft(value)
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
          const grant = await handle.authorize(states[file.id].mode)
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
                    {job.done ? '任务结果' : '正在处理'}
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
                    {t.specUndo && <button className="desk-spec-undo" aria-label={'撤销 r'+t.specUndo.revision+' 的选句改写'} disabled={!states[t.id]?.ready || ['正在撤销','已撤销'].includes(undoStatus[t.id+':'+t.specUndo.revision])} onClick={()=>void undo(t.id,t.specUndo!)}>
                      <Undo2 size={13}/>{undoStatus[t.id+':'+t.specUndo.revision] || '撤销这次改写'}
                    </button>}</Fragment>
                  ))}
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
