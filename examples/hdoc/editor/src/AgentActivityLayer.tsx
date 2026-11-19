import { AgentPointer } from './AgentPointer'
import { WorkspacePanel } from './WorkspacePanel.tsx'
import { createPortal } from 'react-dom'
import { ImageProductionProvider, ImageStudio, ProductionCanvas } from './ImageProduction.tsx'
import { useDocumentViewState } from './DocumentViewState.tsx'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowLeftRight, Blocks, Crosshair, Expand, GitBranch, History, Layers, MessagesSquare, PanelRightClose, Plus, ShieldCheck, Sparkles, Check, Circle, LoaderCircle, RotateCcw } from 'lucide-react'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { useI18n } from './i18n.tsx'
import { api, type Session } from './api.ts'
import { operationView, type AgentOperation, type OperationPhase, type OperationTarget, type OperationView } from './agentOperations.ts'
import { useWorkspaceAgentBusy, useWorkspaceAgentRegistration, useWorkspaceAgentTasks } from './WorkspaceAgent.tsx'
import { agentRunKey, AgentTaskComposer, useAgentTasks, type AgentTasksState } from './AgentTasks.tsx'
import { AgentCompanionMark } from './AgentCompanionMark.tsx'
import { AgentWorkflowPanel } from './AgentWorkflowPanel.tsx'
import { useWorkflowPreparation, useWorkflowWorkspace } from './WorkflowWorkspace.tsx'
import type { TargetVersion } from './tabState.ts'
import { SelectionTransferPanel, useSelectionTransferWorkspace, useTransferForm } from './SelectionTransferWorkspace.tsx'
import { supportsTransfer } from './selectionTransfer.ts'

export type AgentActivity = {
  agentId: string; name: string; status: string; nodeId: string | null; blockId: string | null
  sheetId?: string | null; row?: number | null; column?: number | null
  chunkSequence: number | null; message: string; revision: number; collaborationEpoch: number; updatedAtEpochMs: number; operationAtEpochMs?: number
}
export type AgentVisual = { key: string; agent: AgentActivity; target: OperationTarget; phase: OperationPhase; pointer: boolean; replay: boolean }
type TaskOptions = { agentCount?: number; targetVersion?: TargetVersion }
type AgentWorkspace = { busy: boolean; runTask: (task: string, target: Record<string, unknown>, agentCount: number, beforeRun?: () => Promise<unknown>) => Promise<void>; session?: Session; agents: AgentActivity[]; operations: AgentOperation[]; connected: boolean; panelOpen: boolean; setPanelOpen: (open: boolean) => void; locate: (agent: AgentActivity) => boolean; requestTask: (task: string, target?: Record<string, unknown>, options?: TaskOptions) => void }
const AgentContext = createContext<AgentWorkspace>({ busy: false, runTask: async () => { throw new Error('AI 工作空间尚未就绪。') }, agents: [], operations: [], connected: true, panelOpen: false, setPanelOpen: () => {}, locate: () => false, requestTask: () => {} })
const PlaybackContext = createContext<{ operations: OperationView[]; visuals: AgentVisual[]; replay: (id: string) => void }>({ operations: [], visuals: [], replay: () => {} })
const TasksContext = createContext<AgentTasksState | null>(null)
type PointerPosition = { x: number; y: number; target: string; at: number }
const MotionContext = createContext(new Map<string, PointerPosition>())
export function AgentProductionCanvas() { const tasks = useContext(TasksContext); return tasks ? <ProductionCanvas runs={tasks.runs} /> : null }
export const useAgentWorkspace = () => useContext(AgentContext)
export const useAgentActivities = () => useAgentWorkspace().agents
export const useAgentVisuals = () => useContext(PlaybackContext).visuals
export function AgentPanel({ onLocate, beforeRun, targetLabel, resourcePanel, registerPreparation = true }: { targetLabel?: (target: OperationTarget) => string; onLocate?: (agent: AgentActivity) => Promise<boolean>; beforeRun?: () => Promise<unknown>; resourcePanel?: ReactNode; registerPreparation?: boolean }) {
  const { session, agents, connected, panelOpen, setPanelOpen, locate } = useAgentWorkspace()
  const workspace = useWorkflowWorkspace()
  useWorkflowPreparation(session, beforeRun, registerPreparation)
  const { operations, replay } = useContext(PlaybackContext)
  const localTasks = useContext(TasksContext)
  const { tasks, targetBar, openRun } = useWorkspaceAgentTasks(session, localTasks)
  const { locale } = useI18n()
  const { focused } = useDocumentViewState()
  const transfers = useSelectionTransferWorkspace()
  const { form: transferForm, wasRequested: transferRequested } = useTransferForm(session)
  const canTransfer = !!transfers && !!session && supportsTransfer(session)
  const [studioTab, setStudioTab] = useState<'chat' | 'images' | 'tools' | 'history' | 'workflow' | 'transfer'>(() => canTransfer && transferForm ? 'transfer' : 'chat')
  const [workflowMounted, setWorkflowMounted] = useState(false)
  const [chatExpanded, setChatExpanded] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const [notice, setNotice] = useState('')
  const requested = workspace?.requested
  useEffect(() => {
    if (requested && requested.documentId === session?.documentId) { setWorkflowMounted(true); setStudioTab('workflow'); setPanelOpen(true) }
  }, [requested, session?.documentId, setPanelOpen])
  useEffect(() => {
    if (transferRequested && transferForm?.id) { setStudioTab('transfer'); setPanelOpen(true) }
  }, [transferRequested, transferForm?.id, setPanelOpen])
  const operationsForRun = (run: { agentId: string; team?: { units: { agentId: string }[] } }) => {
    const members = new Set([run.agentId, ...(run.team?.units.map(unit => unit.agentId) || [])])
    return operations.filter(operation => members.has(operation.agentId))
  }
  const renderQueues = (items: OperationView[]) => items.length ? <section className="agent-operation-queues" aria-label={localizeSource(locale, '操作过程')}>
    {items.map(operation => <OperationQueue key={operation.operationId} targetLabel={targetLabel} operation={operation} replay={() => replay(operation.operationId)} onLocate={async target => {
      const agent = operationAgent(operation, target)
      try { const found = onLocate ? await onLocate(agent) : locate(agent); setNotice(found ? '' : '目标尚未加载，请先滚动到对应页面。') } catch { setNotice('目标尚未加载，请先滚动到对应页面。') }
    }} />)}
  </section> : null
  const runOperations = new Set(tasks?.runs.flatMap(run => operationsForRun(run).map(operation => operation.operationId)))
  const activity = <>
    <details className="agent-collaborators">
      <summary><span className={`agent-connection-dot${connected ? '' : ' is-connecting'}`} /><span><LocalText source={!connected ? 'Agent 动态连接中…' : agents.some(agent => ['reading', 'planning', 'editing', 'locating'].includes(agent.status)) ? 'Agent 正在文档中协作' : '文档协作者'} /></span><small>{agents.length}</small></summary>
      <div className="agent-cards">{agents.map(agent => <article key={agent.agentId} className={`agent-activity agent-${agent.status}`} style={{ '--agent-color': agentColor(agent.agentId) } as CSSProperties}>
        <div className="agent-card-title"><span className="agent-avatar">{agent.name.slice(0, 1)}</span><div><strong>{agent.name}</strong><span><LocalText source={agentStatus[agent.status] || agent.status} /> · r{agent.revision}</span></div>
          {(agent.nodeId || agent.blockId || agent.chunkSequence !== null) && <button className="icon-button agent-locate" aria-label={localizeSource(locale, '定位到内容')} title={localizeSource(locale, '定位到内容')} onClick={async () => { try { const found = onLocate ? await onLocate(agent) : locate(agent); setNotice(found ? '' : '目标尚未加载，请先滚动到对应页面。') } catch { setNotice('目标尚未加载，请先滚动到对应页面。') } }}><Crosshair size={14} /></button>}
        </div>
        {agent.message && <p>{agent.message}</p>}
        {agent.status === 'conflict' && <div className="agent-conflict-note"><LocalText source="需要重新读取" /><small><LocalText source="请让 Agent 读取最新修订后重试。" /></small></div>}
      </article>)}</div>
      {!agents.length && <p className="drawer-caption"><LocalText source="启动任务后，可在这里查看协作者和定位内容。" /></p>}
    </details>
    {notice && <p role="status" className="drawer-caption"><LocalText source={notice} /></p>}
  </>
  const header = <div className="agent-panel-navigation">
    <div className="panel-tool-row" role="toolbar" aria-label={localizeSource(locale, 'Agent 工作区')}>
      <button className="agent-chat-tab" aria-label={localizeSource(locale, '对话')} aria-pressed={studioTab === 'chat'} onClick={() => setStudioTab('chat')}><AgentCompanionMark size={20} /><LocalText source="聊天" /></button><span className="panel-tool-spacer" />
      <button aria-label={localizeSource(locale, '任务与工具')} title={localizeSource(locale, '任务与工具')} aria-pressed={studioTab === 'tools'} onClick={() => setStudioTab(previous => previous === 'tools' ? 'chat' : 'tools')}><Blocks size={16} /></button>
      {canTransfer && <button aria-label={localizeSource(locale, '跨文件生成')} title={localizeSource(locale, '跨文件生成')} aria-pressed={studioTab === 'transfer'} onClick={() => setStudioTab(previous => previous === 'transfer' ? 'chat' : 'transfer')}><ArrowLeftRight size={16} /></button>}
      {workspace && session && !session.hostIntegration && session.format !== 'excalidraw' && <button aria-label="多文档工作流" title="多文档工作流" aria-pressed={studioTab === 'workflow'} onClick={() => { setWorkflowMounted(true); setStudioTab(previous => previous === 'workflow' ? 'chat' : 'workflow') }}><GitBranch size={16} /></button>}
      <button aria-label={localizeSource(locale, '图片与资源')} title={localizeSource(locale, '图片与资源')} aria-pressed={studioTab === 'images'} onClick={() => setStudioTab(previous => previous === 'images' ? 'chat' : 'images')}><Layers size={16} /></button>
      <button aria-label={localizeSource(locale, '对话历史')} title={localizeSource(locale, '对话历史')} aria-pressed={studioTab === 'history'} onClick={() => setStudioTab(previous => previous === 'history' ? 'chat' : 'history')}><History size={16} /></button>
      <button className="panel-close" aria-label={localizeSource(locale, '收起协作面板')} title={localizeSource(locale, '收起协作面板')} onClick={() => setPanelOpen(false)}><PanelRightClose size={16} /></button>
    </div>
    <div className="agent-session-row"><span>墨点 · <LocalText source={workspace ? '工作空间 AI' : '当前文档会话'} /></span><button aria-label={localizeSource(locale, '新建任务')} title={localizeSource(locale, '在当前会话新建任务，保留已有记录')} onClick={() => { tasks?.requestTask(''); setStudioTab('chat'); panel.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus() }}><Plus size={12} /><LocalText source="新建" /></button><button aria-label={localizeSource(locale, '展开聊天区域')} title={localizeSource(locale, '展开聊天区域')} aria-pressed={chatExpanded} onClick={() => { setStudioTab('chat'); setChatExpanded(value => !value) }}><Expand size={14} /></button></div>
  </div>
  const toolContent = <div className="agent-panel-tool-content" hidden={studioTab === 'chat'}>
    <div hidden={studioTab !== 'images'}>{resourcePanel ?? <ImageStudio beforeInsert={beforeRun} />}</div>
    <div hidden={studioTab !== 'tools'}>{activity}</div>
    {canTransfer && session && (transferForm || studioTab === 'transfer') && <div hidden={studioTab !== 'transfer'}><SelectionTransferPanel session={session} /></div>}
    {workflowMounted && session && <div hidden={studioTab !== 'workflow'}><AgentWorkflowPanel key={`${session.userId}:${session.documentId}`} session={session} active={studioTab === 'workflow' && panelOpen && !focused} requestedId={requested?.documentId === session.documentId ? `${requested.workflowId}` : undefined} /></div>}
    <div hidden={studioTab !== 'history'} className="agent-session-history">{tasks?.runs.length ? tasks.runs.map(run => <button key={agentRunKey(run)} onClick={() => { setStudioTab('chat'); requestAnimationFrame(() => panel.current?.querySelector(`[data-agent-run-key="${CSS.escape(agentRunKey(run))}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })) }}><MessagesSquare size={13} /><span>{run.origin && <small>{run.origin.title} · </small>}{run.task}</span><small>{run.committedRevisions.length ? `r${run.committedRevisions.at(-1)}` : run.model}</small></button>) : <p><LocalText source="当前文档暂无任务记录" /></p>}</div>
  </div>
  return <WorkspacePanel side="right" ref={panel} hidden={!panelOpen || focused} className={`workspace-sidebar agent-activity-panel pen-agent-panel${chatExpanded ? ' chat-expanded' : ''}${studioTab === 'workflow' ? ' workflow-open' : ''}${studioTab === 'transfer' ? ' transfer-open' : ''}`} aria-label={localizeSource(locale, 'Agent 协作动态')}>
    {tasks ? <AgentTaskComposer state={tasks} beforeRun={beforeRun} targetBar={targetBar} onOpenRun={openRun} header={header} toolPanel={toolContent} onOpenWorkflow={(id, run) => { const source = run?.origin ? workspace?.sessions.find(item => item.documentId === run.origin?.documentId && item.userId === session?.userId) : session; if (source && !workspace?.openWorkflow(source, id)) { setNotice('请在创建计划的文档中打开多文档工作流，核对后继续。'); setStudioTab('tools') } }} renderOperations={run => renderQueues(operationsForRun(run))} externalOperations={renderQueues(operations.filter(operation => !runOperations.has(operation.operationId)))} /> : <div className="agent-panel-main">{header}{toolContent}{renderQueues(operations)}<p className="drawer-footer"><ShieldCheck size={15} /><LocalText source="每次修改保留独立修订" /></p></div>}
  </WorkspacePanel>
}

export function agentColor(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return ['#7c3aed', '#0284c7', '#db2777', '#059669', '#d97706'][hash % 5]
}
export const agentStatus: Record<string, string> = { locating: '正在定位', reading: '正在阅读', planning: '待操作', editing: '正在编辑', applied: '已提交', conflict: '遇到冲突' }

export type AgentMark = AgentVisual & { x: number; y: number; width: number; height: number }
type Cursor = AgentMark


/** Hidden editors stay mounted while Word displays its paginated frame. Only
 * return targets in the visible surface, including split block continuations. */
type ActivityTarget = { element: HTMLElement; frame: HTMLIFrameElement | null }
function activityTargets(host: HTMLElement, selector: string) {
  const result: Array<{element: HTMLElement; frame: HTMLIFrameElement | null}> = []
  for (const element of host.querySelectorAll<HTMLElement>(selector)) {
    if (element.getClientRects().length) result.push({element,frame:null})
  }
  for (const frame of host.querySelectorAll<HTMLIFrameElement>('iframe:not([data-hcd-thumbnail])')) {
    if (!frame.getClientRects().length) continue
    try {
      for (const element of frame.contentDocument?.querySelectorAll<HTMLElement>(selector) || []) {
        if (element.getClientRects().length) result.push({element,frame})
      }
    } catch { /* Isolated preview. */ }
  }
  return result
}

/** Activity is an authenticated focus signal, separate from editable content.
 * Each workspace owns its own poll, DOM lookup and cursor coordinates. */
export function AgentActivityLayer({ session, children }: { session: Session; children: ReactNode }) {
  const tasks = useAgentTasks(session)
  const globalTasks = useWorkspaceAgentRegistration(session, tasks)
  const busy = useWorkspaceAgentBusy(session, tasks)
  const root = useRef<HTMLDivElement>(null)
  const [agents, setAgents] = useState<AgentActivity[]>([])
  const [operationRecords, setOperationRecords] = useState<AgentOperation[]>([])
  const positions = useRef(new Map<string, PointerPosition>())
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const [connected, setConnected] = useState(true)
  const { agentPanelOpen, setAgentPanelOpen } = useDocumentViewState()
  const panelAllowed = !session.hideNativeChat && (!session.hostIntegration || session.format === 'excalidraw' && !!session.operations?.includes('document.ai'))
  const panelOpen = panelAllowed && agentPanelOpen
  const setPanelOpen = useCallback((open: boolean) => { setAgentPanelOpen(panelAllowed && open) }, [panelAllowed, setAgentPanelOpen])
  const requestTask = useCallback((task: string, target?: Record<string, unknown>, options?: TaskOptions) => {
    if (options?.agentCount !== undefined) tasksRef.current.setAgentCount(options.agentCount)
    globalTasks?.select(session); tasksRef.current.requestTask(task, target, options?.targetVersion); setPanelOpen(true)
  }, [setPanelOpen, globalTasks, session])
  const runTask = useCallback(async (task: string, target: Record<string, unknown>, agentCount: number, beforeRun?: () => Promise<unknown>) => {
    globalTasks?.select(session); setPanelOpen(true)
    await tasksRef.current.submitTask({ task, target, agentCount }, beforeRun)
  }, [globalTasks, session, setPanelOpen])
  useEffect(() => {
    if (session.hostIntegration) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const abort = new AbortController()
    const poll = async () => {
      try {
        const response = await api(session, '/agents', { signal: abort.signal })
        const result = await response.json() as { agents: AgentActivity[]; operations?: AgentOperation[] }
        if (alive) {
          const records = result.operations || []
          setOperationRecords(previous => JSON.stringify(previous) === JSON.stringify(records) ? previous : records)
          setAgents(previous => JSON.stringify(previous) === JSON.stringify(result.agents) ? previous : result.agents)
          setConnected(true)
        }
      } catch { if (alive) { setAgents(previous => previous.length ? [] : previous); setOperationRecords(previous => previous.length ? [] : previous); setConnected(false) } }
      if (alive) timer = setTimeout(() => void poll(), 750)
    }
    void poll()
    return () => { alive = false; abort.abort(); clearTimeout(timer) }
  }, [session])

  const locate = useCallback((agent: AgentActivity) => {
    const host = root.current
    if (!host) return false
    const id = agent.nodeId || agent.blockId
    const selector = id ? `[data-hcd-id="${CSS.escape(id)}"], [data-hcd-origin-id="${CSS.escape(id)}"], [data-hcd-block-id="${CSS.escape(id)}"]` : null
    let target = selector ? activityTargets(host, selector)[0] : undefined
    if (!target && !id && agent.chunkSequence !== null) target = activityTargets(host, `[id="hcd-page-${agent.chunkSequence}"]`)[0]
    if (!target) return false
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    const viewport = target.frame?.closest<HTMLElement>('.canvas-viewport')
    if (viewport && target.frame?.closest('.word-page-preview')) {
      const bounds = target.element.getBoundingClientRect(), frame = target.frame.getBoundingClientRect(), canvas = viewport.getBoundingClientRect()
      const scaleX = frame.width / target.frame.offsetWidth, scaleY = frame.height / target.frame.offsetHeight
      viewport.scrollBy({ top: frame.top + bounds.top * scaleY - canvas.top - canvas.height / 2,
        left: frame.left + bounds.left * scaleX - canvas.left - canvas.width / 2 + Math.min(bounds.width * scaleX, canvas.width) / 2, behavior })
    } else target.element.scrollIntoView({ block: 'center', behavior })
    return true
  }, [])
  const workspace = useMemo(() => ({ session, busy, agents, operations: operationRecords, connected, panelOpen, setPanelOpen, locate, requestTask, runTask }), [session, busy, agents, operationRecords, connected, panelOpen, setPanelOpen, locate, requestTask, runTask])
  return <AgentContext.Provider value={workspace}><TasksContext.Provider value={tasks}><MotionContext.Provider value={positions.current}>
    <AgentPlayback session={session} agents={agents} records={operationRecords}>
      <ImageProductionProvider session={session}><div className="agent-workspace" ref={root}>{children}<CanvasAgentOverlay session={session} host={root} /></div></ImageProductionProvider>
    </AgentPlayback>
  </MotionContext.Provider></TasksContext.Provider></AgentContext.Provider>
}

/** Playback updates only its subscribers: operation cards and cursor overlays.
 * Document editors consume committed records, never the animation clock. */
function AgentPlayback({ session, agents, records, children }: { session: Session; agents: AgentActivity[]; records: AgentOperation[]; children: ReactNode }) {
  const observed = useRef(new Map<string, number>())
  const [clock, setClock] = useState(Date.now())
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)'), change = () => setReducedMotion(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    const live = new Set(records.map(record => record.operationId))
    for (const id of observed.current.keys()) if (!live.has(id)) observed.current.delete(id)
    for (const record of records) if (!observed.current.has(record.operationId)) observed.current.set(record.operationId, Date.now() - (Date.now() - record.updatedAtEpochMs > 10_000 ? 60_000 : 0))
    setClock(Date.now())
  }, [records])
  const operations = records.map(record => operationView(record, clock, observed.current.get(record.operationId) ?? clock, reducedMotion))
  useEffect(() => {
    // Schedule the next visible state change, then sleep once playback ends.
    const now = Date.now(), delays: number[] = []
    for (const operation of operations) {
      if (operation.replaying) {
        const step = Math.max(220, Math.min(650, 9000 / Math.max(1, operation.targets.length)))
        delays.push((observed.current.get(operation.operationId) ?? now) + (operation.replayIndex + 1) * step - now)
      }
      const expiry = operation.updatedAtEpochMs + 30_000 - now
      if (expiry > 0) delays.push(expiry)
    }
    if (!delays.length) return
    const timer = setTimeout(() => setClock(Date.now()), Math.max(16, Math.min(...delays)))
    return () => clearTimeout(timer)
  }, [operations])
  const maxRevision = Math.max(0, ...agents.map(agent => agent.revision), ...records.map(operation => operation.revision))
  const visuals: AgentVisual[] = operations.filter(operation => operation.revision === maxRevision && operation.collaborationEpoch === (session.collaborationEpoch ?? 0) && (operation.replaying || clock - operation.updatedAtEpochMs < 30_000)).flatMap(operation => operation.targets.map((target, index) => ({
    key: `${operation.operationId}:${index}`, agent: operationAgent(operation, target), target, phase: operation.phases[index],
    pointer: index === (operation.status === 'applied' ? Math.min(operation.replayIndex, operation.targets.length - 1) : 0), replay: operation.replaying,
  }))).filter(visual => visual.phase !== 'stopped')
  for (const agent of agents) if (agent.collaborationEpoch === (session.collaborationEpoch ?? 0) && !visuals.some(visual => visual.agent.agentId === agent.agentId)) visuals.push({ key: agent.agentId, agent, target: agent, phase: agent.status === 'applied' ? 'done' : agent.status === 'conflict' ? 'stopped' : 'active', pointer: true, replay: false })
  const replay = useCallback((id: string) => { observed.current.set(id, Date.now()); setClock(Date.now()) }, [])
  return <PlaybackContext.Provider value={{ operations, visuals, replay }}>{children}</PlaybackContext.Provider>
}

function CanvasAgentOverlay({ session, host: root }: { session: Session; host: { current: HTMLDivElement | null } }) {
  const visuals = useAgentVisuals()
  const [cursors, setCursors] = useState<Cursor[]>([])
  const [canvas, setCanvas] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (session.format === 'xlsx' || !visuals.length) { setCursors(previous => previous.length ? [] : previous); return }
    const host = root.current
    if (!host) return
    let tick = 0
    const frames = new Map<HTMLIFrameElement, () => void>()
    const measure = () => {
      tick = 0
      const surface = [...host.querySelectorAll<HTMLElement>('.canvas-viewport .zoom-canvas')].find(element => element.getClientRects().length && !element.closest('[data-hcd-history="true"]'))
      setCanvas(previous => previous === surface ? previous : surface || null)
      if (!surface) { setCursors(previous => previous.length ? [] : previous); return }
      const origin = surface.getBoundingClientRect()
      const scaleX = origin.width / surface.offsetWidth || 1, scaleY = scaleX
      const result: Cursor[] = []
      for (const visual of visuals) {
        const agent = visual.agent, id = agent.nodeId || agent.blockId
        const selector = id ? `[data-hcd-id="${CSS.escape(id)}"], [data-hcd-origin-id="${CSS.escape(id)}"], [data-hcd-block-id="${CSS.escape(id)}"]` : null
        // Real nodes take priority. An unresolved explicit ID must never be
        // displayed as though the Agent were editing the entire page.
        let targets = selector ? activityTargets(surface, selector) : []
        if (!targets.length) targets = activityTargets(surface, `[data-production-agent="${CSS.escape(agent.agentId)}"]`)
        if (!targets.length && !id && agent.chunkSequence !== null) targets = activityTargets(surface, `[id="hcd-page-${agent.chunkSequence}"]`)
        const viewport = surface.parentElement!.getBoundingClientRect()
        const point = ({ element, frame }: ActivityTarget) => {
          const rect = element.getBoundingClientRect(), outer = frame?.getBoundingClientRect()
          return outer ? { top: outer.top + rect.top * outer.height / frame!.offsetHeight, left: outer.left + rect.left * outer.width / frame!.offsetWidth } : rect
        }
        const target = targets.find(candidate => { const p = point(candidate); return p.top >= viewport.top && p.top < viewport.bottom && p.left >= viewport.left && p.left < viewport.right }) || targets[0]
        if (!target) continue
        const { element, frame } = target, bounds = element.getBoundingClientRect(), frameBounds = frame?.getBoundingClientRect()
        const fx = frame && frameBounds ? frameBounds.width / frame.offsetWidth : 1
        const fy = frame && frameBounds ? frameBounds.height / frame.offsetHeight : 1
        const left = frameBounds ? frameBounds.left + (frame!.clientLeft + bounds.left) * fx : bounds.left
        const top = frameBounds ? frameBounds.top + (frame!.clientTop + bounds.top) * fy : bounds.top
        result.push({ ...visual, ...(element.hasAttribute('data-production-unit') ? { target: { nodeId: `draft-${element.getAttribute('data-production-unit')}` } } : {}),
          x: (left - origin.left) / scaleX, y: (top - origin.top) / scaleY,
          width: Math.max(4, bounds.width * fx / scaleX), height: Math.max(18, bounds.height * fy / scaleY) })
      }
      setCursors(previous => JSON.stringify(previous) === JSON.stringify(result) ? previous : result)
    }
    const schedule = () => { if (!tick) tick = requestAnimationFrame(measure) }
    const mutations = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element ? record.target : record.target.parentElement)?.closest('[data-agent-canvas-layer]'))) schedule()
    })
    const resize = new ResizeObserver(schedule)
    resize.observe(host)
    const attach = () => {
      for (const [frame, cleanup] of frames) if (!host.contains(frame)) { cleanup(); frames.delete(frame) }
      for (const frame of host.querySelectorAll<HTMLIFrameElement>('iframe:not(.hcd-thumbnail-frame)')) {
        if (frames.has(frame)) continue
        let cleanupDocument: (() => void) | undefined
        const load = () => {
          cleanupDocument?.()
          const doc = frame.contentDocument
          if (doc?.body) {
            const observer = new MutationObserver(schedule), size = new ResizeObserver(schedule)
            observer.observe(doc.body, { childList: true, subtree: true, attributes: true, characterData: true }); size.observe(doc.body)
            doc.addEventListener('scroll', schedule, true)
            cleanupDocument = () => { observer.disconnect(); size.disconnect(); doc.removeEventListener('scroll', schedule, true) }
          }
          schedule()
        }
        frame.addEventListener('load', load); load()
        frames.set(frame, () => { frame.removeEventListener('load', load); cleanupDocument?.() })
      }
    }
    const topology = new MutationObserver(attach)
    topology.observe(host, { childList: true, subtree: true })
    mutations.observe(host, { childList: true, subtree: true, attributes: true, characterData: true })
    host.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule)
    attach(); measure()
    return () => { cancelAnimationFrame(tick); mutations.disconnect(); topology.disconnect(); resize.disconnect(); frames.forEach(cleanup => cleanup()); host.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule) }
  }, [JSON.stringify(visuals), session.format])
  return canvas ? createPortal(<div data-agent-canvas-layer="true"><AgentCanvasMarks marks={cursors} /></div>, canvas) : null
}

function operationAgent(operation: AgentOperation, target: OperationTarget): AgentActivity {
  return { agentId: operation.agentId, name: operation.name, status: operation.status === 'pending' ? 'planning' : operation.status, nodeId: target.nodeId ?? null, blockId: target.blockId ?? null, chunkSequence: target.chunkSequence ?? null, sheetId: target.sheetId, row: target.row, column: target.column, message: target.label || '', revision: operation.revision, collaborationEpoch: operation.collaborationEpoch, updatedAtEpochMs: operation.updatedAtEpochMs, operationAtEpochMs: operation.updatedAtEpochMs }
}

export function AgentCanvasMarks({ marks, grid = false }: { marks: AgentMark[]; grid?: boolean }) {
  const pointers = [...new Map(marks.filter(mark => mark.pointer).map(mark => [mark.agent.agentId, mark])).values()]
  return <>
    {marks.map(mark => <AgentCanvasMark key={`region:${mark.key}`} mark={{ ...mark, pointer: false }} grid={grid} />)}
    {pointers.map((mark, index) => <AgentCanvasMark key={`pointer:${mark.agent.agentId}`} mark={mark} grid={grid} labelOffset={24 * pointers.slice(0, index).filter(other => Math.abs(other.x - mark.x) < 8 && Math.abs(other.y - mark.y) < 8).length} />)}
  </>
}

function AgentCanvasMark({ mark, grid = false, labelOffset = 0 }: { mark: AgentMark; grid?: boolean; labelOffset?: number }) {
  const { agent, x, y, width, height, phase, pointer, replay } = mark
  const element = useRef<HTMLDivElement>(null), trail = useRef<SVGSVGElement>(null), path = useRef<SVGPathElement>(null)
  const positions = useContext(MotionContext)
  const target = JSON.stringify([mark.target.nodeId, mark.target.blockId, mark.target.sheetId, mark.target.row, mark.target.column, mark.target.chunkSequence])
  const motion = useRef<Animation | null>(null), trailMotion = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    const node = element.current
    if (!pointer || !node) return
    const previous = positions.get(agent.agentId)
    // Retarget an in-flight pointer from its current interpolated position.
    // Scrolling or zooming the same target follows the canvas immediately.
    const matrix = motion.current?.playState === 'running' ? new DOMMatrixReadOnly(getComputedStyle(node).transform) : null
    const from = matrix ? { x: matrix.m41, y: matrix.m42 } : previous
    motion.current?.cancel(); trailMotion.current?.cancel()
    node.removeAttribute('data-agent-moving')
    if (trail.current) trail.current.style.opacity = '0'
    // A new native grid anchor may initially report its predecessor's point.
    // Keep that origin until its first real geometry arrives on the next frame.
    const pendingGeometry = from && previous && previous.target !== target && Math.hypot(x - from.x, y - from.y) < 3
    if (!pendingGeometry) positions.set(agent.agentId, { x, y, target, at: Date.now() })
    if (!from || !previous || previous.target === target || Date.now() - previous.at > 30_000 || matchMedia('(prefers-reduced-motion: reduce)').matches || pendingGeometry) return
    const dx = x - from.x, dy = y - from.y
    const length = Math.hypot(dx, dy), bend = Math.min(42, length * .12)
    const cx = (from.x + x) / 2 - dy / length * bend, cy = (from.y + y) / 2 + dx / length * bend
    const frames = Array.from({ length: 17 }, (_, index) => {
      const t = index / 16, u = 1 - t
      return { transform: `translate3d(${u*u*from.x+2*u*t*cx+t*t*x}px,${u*u*from.y+2*u*t*cy+t*t*y}px,0)` }
    })
    const duration = Math.min(620, Math.max(320, length * 1.2))
    node.dataset.agentMoving = 'true'
    motion.current = node.animate(frames, { duration, easing: 'cubic-bezier(.22,.61,.36,1)' })
    if (trail.current && path.current) {
      path.current.setAttribute('d', `M ${from.x} ${from.y} Q ${cx} ${cy} ${x} ${y}`)
      trail.current.style.opacity = '1'
      trailMotion.current = path.current.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration, easing: 'cubic-bezier(.22,.61,.36,1)' })
    }
    motion.current.onfinish = () => { node.removeAttribute('data-agent-moving'); if (trail.current) trail.current.style.opacity = '0' }
  }, [pointer, agent.agentId, x, y, target, positions])
  useEffect(() => {
    if (!pointer) return
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const stop = () => {
      if (!media.matches) return
      motion.current?.cancel(); trailMotion.current?.cancel()
      element.current?.removeAttribute('data-agent-moving')
      if (trail.current) trail.current.style.opacity = '0'
    }
    media.addEventListener('change', stop)
    return () => media.removeEventListener('change', stop)
  }, [pointer])
  useEffect(() => () => { motion.current?.cancel(); trailMotion.current?.cancel() }, [])
  return <>
    {pointer && <svg ref={trail} className="agent-motion-trail" aria-hidden="true" style={{ color: agentColor(agent.agentId) }}><path ref={path} pathLength="1" /></svg>}
    <div ref={element} className={`agent-region phase-${phase}${pointer ? ` agent-cursor${grid ? ' agent-grid-cursor' : ''}` : ''}`} data-agent-id={pointer ? agent.agentId : undefined} data-agent-region-id={!pointer ? agent.agentId : undefined} data-agent-node-id={mark.target.nodeId || undefined} data-operation-phase={phase} data-agent-grid-row={grid ? mark.target.row : undefined} data-agent-grid-column={grid ? mark.target.column : undefined} data-operation-replay={replay} style={{ left:0, top:0, transform:`translate3d(${x}px,${y}px,0)`, width, height, color:agentColor(agent.agentId) }}>
      {!pointer && (phase === 'active' || phase === 'done') && <i className={phase === 'active' ? 'agent-operation-sweep' : 'agent-complete-glow'} />}
      {pointer && <><AgentPointer className="agent-pointer" phase={phase === 'pending' ? 'idle' : phase === 'done' ? 'done' : ['idle','planning','reading','locating','pending'].includes(agent.status) ? 'idle' : 'writing'} /><span className="agent-pointer-label agent-name-chip" style={{transform:`translateY(${-labelOffset}px)`}}>{agent.name}</span></>}
    </div>
  </>
}

function OperationQueue({ operation, replay, onLocate, targetLabel }: { targetLabel?: (target: OperationTarget) => string; operation: OperationView; replay: () => void; onLocate: (target: OperationTarget) => Promise<void> }) {
  const { locale } = useI18n()
  const stopped = !['pending','editing','applied'].includes(operation.status)
  const groups: Array<{phase: OperationPhase; title: string}> = [
    {phase:'active',title:operation.replaying ? '回放中' : '正在操作'},
    {phase:'pending',title:operation.replaying ? '待回放' : '待操作'},
    {phase:'done',title:operation.replaying ? '已回放' : '已完成'},
  ]
  return <article className="agent-operation-queue" data-operation-id={operation.operationId} data-operation-status={operation.status} style={{'--agent-color':agentColor(operation.agentId)} as CSSProperties}>
    <header><strong><LocalText source="操作过程" /></strong><small>{operation.name}</small>{operation.status === 'applied' && <button className="icon-button" aria-label={localizeSource(locale, '重新播放操作')} onClick={replay}><RotateCcw size={13} /></button>}</header>
    <p className="agent-operation-truth"><LocalText source={operation.status === 'applied' ? '修改已提交 · 动画仅为回放' : operation.status === 'editing' ? '正在提交整批修改' : stopped ? operation.status === 'cancelled' ? '已停止 · 未提交的计划已取消' : operation.status === 'expired' ? '活动已过期 · 未确认提交' : '操作未提交 · 需要重新检查' : '修改计划 · 尚未提交'} />{operation.status === 'applied' && ` · r${operation.revision}`}</p>
    <div className="agent-operation-progress" role="progressbar" aria-label={localizeSource(locale, '操作展示进度')} aria-valuemin={0} aria-valuemax={operation.targets.length} aria-valuenow={operation.phases.filter(p=>p==='done').length}><i style={{width:`${operation.phases.filter(p=>p==='done').length / Math.max(1,operation.targets.length) * 100}%`}} /></div>
    {stopped ? <p className="agent-operation-stopped"><LocalText source="未继续执行" /> · {operation.totalTargets} <LocalText source="项" /></p> : groups.map(({phase,title}) => {
      const targets = operation.targets.map((target,index)=>({target,index})).filter(({index})=>operation.phases[index]===phase)
      return <details className={`agent-queue-group queue-${phase}`} key={phase} open={phase === 'active' || phase === 'pending'}>
        <summary>{phase === 'active' ? <LoaderCircle size={12} className={targets.length ? 'agent-spinner' : ''} /> : phase === 'done' ? <Check size={12} /> : <Circle size={11} />}<LocalText source={title} /><span>{targets.length}</span></summary>
        {targets.length ? <ul>{targets.map(({target,index})=><li key={index}><button disabled={!target.nodeId && !target.blockId && !target.sheetId && target.chunkSequence == null} onClick={()=>void onLocate(target)}><span>{targetLabel?.(target) || (target.label ? localizeSource(locale,target.label) : `${localizeSource(locale,'内容区域')} ${index+1}`)}</span><Crosshair size={12} /></button></li>)}</ul> : <small className="agent-queue-empty"><LocalText source={phase==='active' ? '等待操作' : '暂无'} /></small>}
      </details>
    })}
    {operation.totalTargets > operation.targets.length && <small className="agent-queue-empty"><LocalText source="仅展示前" /> {operation.targets.length} / {operation.totalTargets} <LocalText source="项" /></small>}
  </article>
}
