import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronDown, Copy, FileText, LoaderCircle, Plus, Sparkles, Square, X } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type Session } from './api.ts'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { useI18n } from './i18n.tsx'
import './agent-tasks.css'
import { agentRunNotice, toolIssueLabel, type AgentToolEvent } from './agentRunStatus.ts'

type RunEvent = AgentToolEvent & { resource?: string; formulas?: string[]; at?: number }
export type SlideDraft = { title: string; kicker: string; body: string[]; layout: string; imagePrompt: string }
type TeamUnit = { draft?: SlideDraft; imageJobId?: string;  unitId: string; title: string; instructions: string; resources: string[]; status: string; agentId: string; leaseExpiresAtEpochMs?: number; result: string }
type AgentTeam = { generateImages?: boolean; pageRequirement?: { min: number; max: number };  phase: string; sharedContext: string; requiredTexts: string[]; units: TeamUnit[]; messages: { agentId: string; message: string }[] }
export type AgentRun = {
  runId: string; agentId: string; name: string; task: string; status: string; model: string
  result: string; committedRevisions: number[]; events: RunEvent[]
  agentCount?: number; mode?: 'edit' | 'rebuild'; team?: AgentTeam; workflowId?: string | null
}

type ContinuationReview = {
  runId: string; canContinue: boolean; reason?: string; fingerprint: string; revision: number; collaborationEpoch: number
  model?: string; previousModel: string; committedRevisions: number[]
  units: { unitId: string; title: string; status: string; agentId: string }[]
  savedExecutions: number; finishedExecutions: number; deck?: { applied: number; total: number }; message: string
}

export function useAgentTasks(session: Session) {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [continuationAvailable, setContinuationAvailable] = useState(false)
  const [available, setAvailable] = useState(false), [model, setModel] = useState('')
  const [task, setTask] = useState(''), [target, setTarget] = useState<Record<string, unknown> | null>(null)
  const [agentCount, setAgentCount] = useState(1), [mode, setMode] = useState<'auto' | 'edit' | 'rebuild'>('auto')
  const [generateImages, setGenerateImages] = useState(true), [imageModel, setImageModel] = useState('')
  const [error, setError] = useState(''), [starting, setStarting] = useState(false)
  const [continuations, setContinuations] = useState<Record<string, ContinuationReview>>({}), [continuing, setContinuing] = useState('')
  useEffect(() => { setContinuations({}); setContinuing('') }, [session])
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (session.hostIntegration) { setAvailable(false); return }
    const response = await api(session, '/agent-runs', { signal })
    const value = await response.json() as { continuationProtocol?: string; available: boolean; model?: string; imageModel?: string; runs: AgentRun[] }
    setContinuationAvailable(value.continuationProtocol === 'hcd-agent-continuation/1'); setImageModel(value.imageModel || ''); setAvailable(value.available); setModel(value.model || ''); setRuns(previous => JSON.stringify(previous) === JSON.stringify(value.runs) ? previous : value.runs)
  }, [session])
  useEffect(() => {
    if (session.hostIntegration) return
    const request = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { await refresh(request.signal) } catch { /* Activity and editing remain available without a configured model. */ }
      if (!request.signal.aborted) timer = setTimeout(() => void poll(), 1200)
    }
    void poll()
    return () => { request.abort(); clearTimeout(timer) }
  }, [refresh])
  const requestTask = (value: string, selected: Record<string, unknown> | null = null) => { setTask(value); setTarget(selected); setError('') }
  const start = async (beforeRun?: () => Promise<unknown>) => {
    if (!task.trim() || starting || session.scope !== 'write') return
    setStarting(true); setError('')
    try {
      await beforeRun?.()
      await api(session, '/agent-runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, target: mode === 'rebuild' ? null : target, agentCount, mode, generateImages }) })
      setTask(current => current === task ? '' : current); setTarget(current => current === target ? null : current); await refresh()
    } catch (cause) { setError(String(cause)) }
    finally { setStarting(false) }
  }
  const cancel = async (run: AgentRun) => {
    try { await api(session, `/agent-runs/${encodeURIComponent(run.runId)}`, { method: 'DELETE' }); await refresh() }
    catch (cause) { setError(String(cause)) }
  }
  const reviewContinuation = async (run: AgentRun, beforeRun?: () => Promise<unknown>) => {
    if (continuing || session.scope !== 'write') return
    setContinuing(run.runId); setError('')
    try {
      await beforeRun?.()
      const response = await api(session, `/agent-runs/${encodeURIComponent(run.runId)}/continuation`)
      const review = await response.json() as ContinuationReview
      setContinuations(current => ({ ...current, [run.runId]: review }))
    } catch (cause) { setError(String(cause)) }
    finally { setContinuing('') }
  }
  const resumeContinuation = async (run: AgentRun, beforeRun?: () => Promise<unknown>) => {
    const review = continuations[run.runId]
    if (continuing || !review?.canContinue || session.scope !== 'write') return
    setContinuing(run.runId); setError('')
    try {
      await beforeRun?.()
      await api(session, `/agent-runs/${encodeURIComponent(run.runId)}/continuation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint: review.fingerprint, expectedRevision: review.revision, collaborationEpoch: review.collaborationEpoch, authorizeRemaining: true }) })
      await refresh()
    } catch (cause) { setError(String(cause)) }
    finally {
      setContinuations(current => { const next = { ...current }; delete next[run.runId]; return next })
      setContinuing('')
    }
  }
  return { continuationAvailable, continuations, continuing, reviewContinuation, resumeContinuation, runs, available, model, imageModel, generateImages, setGenerateImages, task, setTask, target, clearTarget: () => setTarget(null), requestTask, agentCount, setAgentCount, mode, setMode, format: session.format, error, starting, start, cancel, writable: session.scope === 'write' }
}

export type AgentTasksState = ReturnType<typeof useAgentTasks>
const statuses: Record<string, string> = { running: '执行中', cancelling: '正在停止', completed: '已完成', cancelled: '已停止', failed: '未完成', interrupted: '已中断' }
const tools: Record<string, string> = { hcd_help: '读取编辑规则', hcd_read: '读取文档', hcd_activity: '定位内容', hcd_patch: '提交修改' }
const phases: Record<string, string> = { planning: '规划分工', drafting: '并行制作', editing: '协作编辑', reviewing: '整稿验收', committing: '替换与核对' }
const unitStatuses: Record<string, string> = { pending: '待处理', running: '处理中 · 已认领', staged: '已制作 · 待验收', completed: '已完成 · 已释放', failed: '未完成 · 已释放', cancelled: '已停止 · 已释放', interrupted: '已中断 · 已释放' }

// Keep markdown parsing independent of the canvas operation playback clock.
const AgentMarkdown = memo(function AgentMarkdown({ text }: { text: string }) {
  return <div className="agent-task-result"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>, img: ({ alt }) => <span>{alt}</span>, table: ({ children }) => <div className="agent-markdown-table"><table>{children}</table></div> }}>{text}</Markdown></div>
})

export function AgentTaskComposer({ state, beforeRun, activity, header, toolPanel, renderOperations, externalOperations, onOpenWorkflow }: {
  state: AgentTasksState; beforeRun?: () => Promise<unknown>; activity?: ReactNode; header?: ReactNode; toolPanel?: ReactNode
  onOpenWorkflow?: (id: string) => void
  renderOperations?: (run: AgentRun) => ReactNode; externalOperations?: ReactNode
}) {
  const { locale } = useI18n()
  const feed = useRef<HTMLDivElement>(null), follow = useRef(true), input = useRef<HTMLTextAreaElement>(null)
  const [away, setAway] = useState(false), [settingsOpen, setSettingsOpen] = useState(false)
  const [copied, setCopied] = useState(''), [copyError, setCopyError] = useState(false)
  const settingsId = useId(), copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const rebuilding = state.format === 'pptx' && (state.mode === 'rebuild' || state.mode === 'auto' && !/不要重做|不需要重做|do not rebuild|don't rebuild/i.test(state.task) && /推翻|重新制作|重新做|重做|rebuild|remake|redesign/i.test(state.task))
  const scrollToLatest = () => { follow.current = true; setAway(false); if (feed.current) feed.current.scrollTop = feed.current.scrollHeight }
  // Follow new content only when the reader is already at the bottom. This also
  // handles wrapped markdown and expanded tool traces without stealing history.
  useLayoutEffect(() => { if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight }, [state.runs])
  useEffect(() => {
    const content = feed.current?.firstElementChild
    if (!content) return
    const observer = new ResizeObserver(() => { if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight })
    observer.observe(content)
    if (feed.current) observer.observe(feed.current)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => { if (input.current) { input.current.style.height = '0px'; input.current.style.height = `${Math.min(120, Math.max(28, input.current.scrollHeight))}px` } }, [state.task])
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  const submit = () => { scrollToLatest(); void state.start(beforeRun) }
  const copy = async (run: AgentRun) => {
    try { await navigator.clipboard.writeText(run.result); setCopied(run.runId); setCopyError(false); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(''), 2000) }
    catch { setCopyError(true) }
  }
  return <section className="agent-tasks" aria-label={localizeSource(locale, 'Agent 编辑任务')}>
    <div className="agent-panel-main">
    {header}{toolPanel}
    <div className="agent-conversation-body">
      <div className="agent-task-feed" ref={feed} role="region" aria-label={localizeSource(locale, 'Agent 对话')} tabIndex={0} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; setAway(!follow.current) }}>
        <div className="agent-feed-content">
          {activity}
          {!state.runs.length && <div className="agent-welcome"><div className="agent-welcome-mark"><Sparkles size={24} /></div><h3><LocalText source="一起完成这份文档" /></h3><p><LocalText source="从一个想法，到一份好文档。" /></p>{state.writable && <div className="agent-starters">{['梳理这份文档的重点', '检查内容并提出改进建议'].map(prompt => <button type="button" key={prompt} onClick={() => { state.requestTask(localizeSource(locale, prompt)); input.current?.focus() }}><LocalText source={prompt} /><ArrowUp size={13} /></button>)}</div>}</div>}
          <div className="agent-task-runs">{state.runs.slice().reverse().map(run => {
            const results = run.events.filter(event => event.type === 'tool_result')
            const notice = agentRunNotice(run)
            const running = ['running', 'cancelling'].includes(run.status)
            const lastTool = run.events.slice().reverse().find(event => event.type === 'tool')
            const operations = renderOperations?.(run)
            return <article className={`agent-task-run run-${run.status}`} key={run.runId} data-agent-run={run.runId}>
              <div className="agent-user-turn"><span className="sr-only"><LocalText source="你" /></span><p className="agent-user-message">{run.task}</p></div>
              <div className="agent-assistant-turn">
                <div className="agent-response-head"><span className="agent-response-avatar"><Sparkles size={14} /></span><strong title={run.name}>Agent</strong><span className={`agent-run-status status-${run.status}`}>{running ? <LoaderCircle size={12} className="agent-spinner" /> : run.status === 'completed' ? <Check size={12} /> : null}<LocalText source={statuses[run.status] || run.status} /></span></div>
                {(!!results.length || running || operations) && <details className="agent-work-trace" open={running || undefined}>
                  <summary><ChevronDown size={13} /><span role={running ? 'status' : undefined}><LocalText source={running ? tools[lastTool?.name || ''] || '正在规划操作…' : '执行过程'} /></span><small>{results.length > 0 && <>{results.length} <LocalText source="步" /></>}</small></summary>
                  <div className="agent-trace-content">
                    {operations}
                    {!!results.length && <details className="agent-operation-log"><summary><ChevronDown size={12} /><LocalText source="查看操作记录" /><small>{results.length}</small></summary><ol>{results.map((event, index) => <li key={index} className={event.ok ? 'step-ok' : 'step-rejected'}><span>{event.ok ? <Check size={12} /> : '!'}</span><div><LocalText source={tools[event.name || ''] || event.name || '操作'} />{event.ok === false && <> · <LocalText source={toolIssueLabel(event)} />{event.status ? ` (${event.status})` : ''}</>}{event.error && <p>{event.error}</p>}{event.formulas?.map((formula, i) => <code key={i}>{formula}</code>)}</div></li>)}</ol></details>}
                    {running && !results.length && !operations && <p className="agent-thinking" role="status"><LocalText source="正在分析文档并规划步骤" /><span aria-hidden="true">…</span></p>}
                  </div>
                </details>}
                {run.team && <details className="agent-team-board" open={running || undefined}>
                  <summary><Sparkles size={13} /><LocalText source={phases[run.team.phase] || statuses[run.team.phase] || run.team.phase} /><small>{run.agentCount || 1} Agent · {run.team.units.length ? `${run.team.units.filter(unit => unit.status === 'completed' || unit.status === 'staged').length}/${run.team.units.length}` : <LocalText source={running ? '正在划分工作区域' : '分工未生成'} />}</small><ChevronDown size={12} /></summary>
                  {run.team.sharedContext && <p className="agent-team-context">{run.team.sharedContext}</p>}
                  <ol>{run.team.units.map(unit => <li key={unit.unitId} data-team-unit={unit.unitId} data-team-status={unit.status}><i className={`team-dot team-${unit.status}`} /><div><strong>{unit.title}</strong><small>{/^\d+$/.test(unit.agentId.split('-').at(-1) || '') ? `Agent ${unit.agentId.split('-').at(-1)} · ` : ''}<LocalText source={unit.status === 'running' && (unit.leaseExpiresAtEpochMs || 0) <= Date.now() ? '工作锁已过期' : unitStatuses[unit.status] || unit.status} /></small>{unit.result && unit.status === 'failed' && <p>{unit.result}</p>}</div></li>)}</ol>
                  {!!run.team.messages.length && <details className="agent-team-findings"><summary><LocalText source="共享发现" /><small>{run.team.messages.length}</small></summary>{run.team.messages.map((message, index) => <p key={index}>{message.message}</p>)}</details>}
                </details>}
                {run.result && <AgentMarkdown text={run.result} />}
                {notice && <p className={notice.recovered ? 'agent-recovered' : 'agent-rejection'}><LocalText source={notice.text} /></p>}
                {run.workflowId && ['failed', 'cancelled', 'interrupted'].includes(run.status) && <div className="agent-continuation"><p>此任务属于跨文档计划，需要一起核对共享来源与后续步骤。</p>{onOpenWorkflow && <button type="button" onClick={() => onOpenWorkflow(run.workflowId!)}>在工作流中核对</button>}</div>}
                {!run.workflowId && state.writable && state.continuationAvailable && ['failed', 'cancelled', 'interrupted'].includes(run.status) && <div className="agent-continuation">
                  {state.continuations[run.runId] ? <>
                    <strong><LocalText source="核对剩余工作" /></strong>
                    <p>r{state.continuations[run.runId].revision} · 已提交 {state.continuations[run.runId].committedRevisions.length} 次修改 · 已完成 {state.continuations[run.runId].units.filter(unit => ['completed', 'staged'].includes(unit.status)).length}/{state.continuations[run.runId].units.length || state.continuations[run.runId].savedExecutions} 项</p>
                    {state.continuations[run.runId].units.some(unit => !['completed', 'staged'].includes(unit.status)) && <ul>{state.continuations[run.runId].units.filter(unit => !['completed', 'staged'].includes(unit.status)).map(unit => <li key={unit.unitId}>{unit.title}</li>)}</ul>}
                    {state.continuations[run.runId].deck && <p>已验收新稿：{state.continuations[run.runId].deck?.applied}/{state.continuations[run.runId].deck?.total} 步已应用</p>}
                    <p>{state.continuations[run.runId].reason || state.continuations[run.runId].message}</p>
                    {state.continuations[run.runId].model !== state.continuations[run.runId].previousModel && <p>续跑模型：{state.continuations[run.runId].model}</p>}
                    <div className="agent-continuation-actions"><button type="button" disabled={!!state.continuing} onClick={() => void state.reviewContinuation(run, beforeRun)}><LocalText source="重新核对" /></button>{state.continuations[run.runId].canContinue && <button type="button" className="agent-continue-authorize" disabled={!!state.continuing} onClick={() => void state.resumeContinuation(run, beforeRun)}>{state.continuing === run.runId ? <LoaderCircle size={12} className="agent-spinner" /> : <ArrowUp size={12} />}<LocalText source="授权并继续剩余工作" /></button>}</div>
                  </> : <button type="button" disabled={!!state.continuing} onClick={() => void state.reviewContinuation(run, beforeRun)}>{state.continuing === run.runId && <LoaderCircle size={12} className="agent-spinner" />}<LocalText source="核对并继续" /></button>}
                </div>}
                <div className="agent-response-footer">
                  {!!run.committedRevisions.length && <small className="agent-commit-receipt"><Check size={12} /><LocalText source="已提交修订" /> {run.committedRevisions.length > 3 ? `r${run.committedRevisions[0]}–r${run.committedRevisions.at(-1)}` : run.committedRevisions.map(r => `r${r}`).join(', ')}</small>}
                  {!running && !run.committedRevisions.length && <small><LocalText source="未提交文档修改" /></small>}
                  {run.result && <button type="button" className="icon-button agent-copy" title={localizeSource(locale, copied === run.runId ? '已复制' : '复制回复')} aria-label={localizeSource(locale, copied === run.runId ? '已复制' : '复制回复')} onClick={() => void copy(run)}>{copied === run.runId ? <Check size={13} /> : <Copy size={13} />}</button>}
                  {running && !run.workflowId && <button type="button" className="agent-stop" disabled={run.status === 'cancelling'} onClick={() => void state.cancel(run)}><Square size={10} /><LocalText source={run.status === 'cancelling' ? '正在停止' : '停止任务'} /></button>}
                  {running && run.workflowId && onOpenWorkflow && <button type="button" className="agent-stop" onClick={() => onOpenWorkflow(run.workflowId!)}>查看工作流</button>}
                </div>
              </div>
            </article>
          })}</div>
          {externalOperations}
        </div>
      </div>
      {away && <button type="button" className="agent-jump-latest" onClick={scrollToLatest}><ArrowDown size={13} /><LocalText source="回到最新" /></button>}
    </div>
    </div>
    <div className="agent-compose-area">
      {state.error && <p className="agent-task-error" role="alert">{state.error}</p>}
      {copyError && <p className="agent-task-error" role="status"><LocalText source="复制失败，请选择文字复制。" /></p>}
      {state.writable ? <form onSubmit={event => { event.preventDefault(); submit() }}>
        {(state.target || rebuilding) && <div className="agent-compose-scope"><FileText size={12} /><span><LocalText source={rebuilding ? '范围：整份演示文稿' : '范围：当前选中内容'} /></span>{state.target && !rebuilding && <button className="agent-clear-target" type="button" aria-label={localizeSource(locale, '改为全文')} title={localizeSource(locale, '改为全文')} onClick={state.clearTarget}><X size={12} /></button>}</div>}
        <label className="agent-task-input"><span className="sr-only"><LocalText source="Agent 任务" /></span><textarea ref={input} aria-label={localizeSource(locale, 'Agent 任务')} placeholder={localizeSource(locale, '告诉 Agent 想修改什么…')} maxLength={8000} rows={1} value={state.task} onChange={event => state.setTask(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (state.available && state.task.trim() && !state.starting) submit() } }} /></label>
        {settingsOpen && <div id={settingsId} className="agent-team-settings">
          <label><LocalText source="任务方式" /><select aria-label={localizeSource(locale, '任务方式')} value={state.mode} onChange={event => { const mode = event.target.value as typeof state.mode; state.setMode(mode); if (mode === 'rebuild') state.clearTarget() }}><option value="auto">{localizeSource(locale, '自动识别')}</option><option value="edit">{localizeSource(locale, '编辑内容')}</option>{state.format === 'pptx' && <option value="rebuild">{localizeSource(locale, '整份 PPT 重做')}</option>}</select></label>
          <label><LocalText source="协同人数" /><select aria-label={localizeSource(locale, '协同人数')} value={state.agentCount} onChange={event => state.setAgentCount(Number(event.target.value))}>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count} Agent</option>)}</select></label>
          <label className="agent-image-setting"><input type="checkbox" checked={state.generateImages} onChange={event => state.setGenerateImages(event.target.checked)} />生成配图<small>{state.imageModel}</small></label>
        </div>}
        <div className="agent-compose-footer"><details className="agent-context-picker"><summary aria-label={localizeSource(locale, '添加上下文')} title={localizeSource(locale, '添加上下文')}><Plus size={16} /></summary><div><p><LocalText source={state.target ? '已包含画布中选中的内容。' : '在画布选中内容后，可通过右键将选区交给 Agent。'} /></p><button type="button" onClick={state.clearTarget}><LocalText source="使用当前全文" /></button></div></details><button type="button" className="agent-settings-toggle" aria-label={localizeSource(locale, '任务设置')} title={state.model || 'OpenAI Agent'} aria-expanded={settingsOpen} aria-controls={settingsId} onClick={() => setSettingsOpen(!settingsOpen)}>{state.model || 'OpenAI Agent'}<ChevronDown size={11} /><span>{state.agentCount} Agent</span></button><button type="submit" className="agent-send" title={localizeSource(locale, '启动 Agent')} aria-label={localizeSource(locale, state.starting ? '正在同步并启动…' : '启动 Agent')} disabled={!state.available || !state.task.trim() || state.starting}>{state.starting ? <LoaderCircle size={16} className="agent-spinner" /> : <ArrowUp size={17} />}</button></div>
      </form> : <p className="drawer-caption"><LocalText source="只读访问无法启动编辑任务。" /></p>}
      {!state.available && <small className="agent-unavailable"><LocalText source="服务端尚未配置 OpenAI，仍可使用外部 MCP Agent。" /></small>}
    </div>
  </section>
}
