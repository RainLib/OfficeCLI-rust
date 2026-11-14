import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Crosshair, PanelRightClose, ShieldCheck, Sparkles } from 'lucide-react'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { useI18n } from './i18n.tsx'
import { api, type Session } from './api.ts'

export type AgentActivity = {
  agentId: string; name: string; status: string; nodeId: string | null; blockId: string | null
  chunkSequence: number | null; message: string; revision: number; collaborationEpoch: number; updatedAtEpochMs: number
}
type AgentWorkspace = { agents: AgentActivity[]; connected: boolean; panelOpen: boolean; setPanelOpen: (open: boolean) => void; locate: (agent: AgentActivity) => boolean }
const AgentContext = createContext<AgentWorkspace>({ agents: [], connected: true, panelOpen: false, setPanelOpen: () => {}, locate: () => false })
export const useAgentWorkspace = () => useContext(AgentContext)
export const useAgentActivities = () => useAgentWorkspace().agents

export function AgentPanel({ onLocate }: { onLocate?: (agent: AgentActivity) => Promise<boolean> }) {
  const { agents, connected, setPanelOpen, locate } = useAgentWorkspace()
  const { locale } = useI18n()
  const [notice, setNotice] = useState('')
  return <aside className="workspace-sidebar agent-activity-panel" aria-label={localizeSource(locale, 'Agent 协作动态')}>
    <div className="panel-head"><h2><Sparkles size={16} /><LocalText source="协作" /></h2><button className="icon-button panel-close" aria-label={localizeSource(locale, '收起协作面板')} title={localizeSource(locale, '收起协作面板')} onClick={() => setPanelOpen(false)}><PanelRightClose size={17} /></button></div>
    <div className="drawer-section-label"><span className="status-dot" />Agent <span>{agents.length}</span></div>
    <p className="drawer-caption"><LocalText source="仅展示实际定位与已提交操作" /></p>
    {!connected && <p role="status"><LocalText source="Agent 动态连接中…" /></p>}
    {connected && !agents.length && <div className="agents-empty"><Sparkles size={28} /><strong><LocalText source="等待 Agent 加入" /></strong><p><LocalText source="Agent 通过 MCP 读取或修订文档后，活动与定位会显示在这里。" /></p></div>}
    <div className="agent-cards">{agents.map(agent => <article key={agent.agentId} className={`agent-activity agent-${agent.status}`} style={{ '--agent-color': agentColor(agent.agentId) } as CSSProperties}>
      <div className="agent-card-title"><span className="agent-avatar">{agent.name.slice(0, 1)}</span><div><strong>{agent.name}</strong><span><LocalText source={agentStatus[agent.status] || agent.status} /></span></div><i /></div>
      <small>{agent.blockId ? localizeSource(locale, '段落') : agent.nodeId ? localizeSource(locale, '内容区域') : localizeSource(locale, '文档')} · r{agent.revision}{agent.chunkSequence === null ? '' : ` · ${agent.chunkSequence + 1}`}</small>
      {agent.message && <p>{agent.message}</p>}
      {agent.status === 'conflict' && <div className="agent-conflict-note"><LocalText source="需要重新读取" /><small><LocalText source="请让 Agent 读取最新修订后重试。" /></small></div>}
      {(agent.nodeId || agent.blockId || agent.chunkSequence !== null) && <button className="agent-locate" onClick={async () => { try { const found = onLocate ? await onLocate(agent) : locate(agent); setNotice(found ? '' : '目标尚未加载，请先滚动到对应页面。') } catch { setNotice('目标尚未加载，请先滚动到对应页面。') } }}><Crosshair size={14} /><LocalText source="定位到内容" /></button>}
    </article>)}</div>
    {notice && <p role="status" className="drawer-caption"><LocalText source={notice} /></p>}
    <p className="drawer-footer"><ShieldCheck size={15} /><LocalText source="每次修改保留独立修订" /></p>
  </aside>
}

export function agentColor(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return ['#7c3aed', '#0284c7', '#db2777', '#059669', '#d97706'][hash % 5]
}
export const agentStatus: Record<string, string> = { locating: '正在定位', reading: '正在阅读', editing: '正在编辑', applied: '已提交', conflict: '遇到冲突' }

type Cursor = { agent: AgentActivity; x: number; y: number; width: number; height: number }

/** Activity is an authenticated focus signal, separate from editable content.
 * Each workspace owns its own poll, DOM lookup and cursor coordinates. */
export function AgentActivityLayer({ session, children }: { session: Session; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const [agents, setAgents] = useState<AgentActivity[]>([])
  const [cursors, setCursors] = useState<Cursor[]>([])
  const [connected, setConnected] = useState(true)
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 900)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const abort = new AbortController()
    const poll = async () => {
      try {
        const response = await api(session, '/agents', { signal: abort.signal })
        const result = await response.json() as { agents: AgentActivity[] }
        if (alive) { setAgents(previous => JSON.stringify(previous) === JSON.stringify(result.agents) ? previous : result.agents); setConnected(true) }
      } catch { if (alive) { setAgents([]); setConnected(false) } }
      if (alive) timer = setTimeout(() => void poll(), 750)
    }
    void poll()
    return () => { alive = false; abort.abort(); clearTimeout(timer) }
  }, [session])

  useEffect(() => {
    if (session.format === 'xlsx' || !agents.length) { setCursors([]); return }
    const measure = () => {
      const host = root.current
      if (!host || !host.getClientRects().length || session.format === 'xlsx' || host.querySelector('[data-hcd-history="true"]')) { setCursors([]); return }
      const result: Cursor[] = []
      const viewport = (host.querySelector('.document-scroll') || host).getBoundingClientRect()
      for (const agent of agents) {
        const id = agent.nodeId || agent.blockId
        const selector = id ? `[data-hcd-id="${CSS.escape(id)}"], [data-hcd-block-id="${CSS.escape(id)}"]` : null
        let element = selector ? host.querySelector<HTMLElement>(selector) : null
        let frame: HTMLIFrameElement | null = null
        if (!element && selector) {
          for (const candidate of host.querySelectorAll<HTMLIFrameElement>('iframe:not([data-hcd-thumbnail])')) {
            try { element = candidate.contentDocument?.querySelector<HTMLElement>(selector) || null } catch { /* Isolated preview. */ }
            if (element) { frame = candidate; break }
          }
        }
        if (!element && agent.chunkSequence !== null) element = host.querySelector(`[id="hcd-page-${agent.chunkSequence}"]`)
        if (!element) continue
        const bounds = element.getBoundingClientRect()
        const frameBounds = frame?.getBoundingClientRect()
        const scaleX = frame && frameBounds ? frameBounds.width / frame.offsetWidth : 1
        const scaleY = frame && frameBounds ? frameBounds.height / frame.offsetHeight : 1
        const x = (frameBounds?.left || 0) + bounds.left * scaleX
        const y = (frameBounds?.top || 0) + bounds.top * scaleY
        if (x < viewport.left || x > viewport.right || y < viewport.top || y > viewport.bottom) continue
        result.push({ agent, x, y, width: Math.max(4, bounds.width * scaleX), height: Math.max(18, bounds.height * scaleY) })
      }
      setCursors(previous => JSON.stringify(previous) === JSON.stringify(result) ? previous : result)
    }
    measure()
    const interval = setInterval(measure, 250)
    return () => clearInterval(interval)
  }, [agents, session.format])

  function locate(agent: AgentActivity) {
    const host = root.current
    if (!host) return false
    const id = agent.nodeId || agent.blockId
    const selector = id ? `[data-hcd-id="${CSS.escape(id)}"], [data-hcd-block-id="${CSS.escape(id)}"]` : null
    let element: Element | null = selector ? host.querySelector(selector) : null
    if (!element && selector) for (const frame of host.querySelectorAll<HTMLIFrameElement>('iframe:not([data-hcd-thumbnail])')) {
      try { if (frame.contentDocument?.querySelector(selector)) { element = frame; break } } catch { /* Isolated preview. */ }
    }
    if (!element && agent.chunkSequence !== null) element = host.querySelector(`[id="hcd-page-${agent.chunkSequence}"]`)
    element?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    return !!element
  }
  return <AgentContext.Provider value={{ agents, connected, panelOpen, setPanelOpen, locate }}><div className="agent-workspace" ref={root}>
    {children}
    {cursors.map(({ agent, x, y, width, height }, index) => <div key={agent.agentId} className={`agent-cursor agent-${agent.status}`} data-agent-id={agent.agentId} style={{ left: x, top: y, width, height, borderColor: agentColor(agent.agentId), color: agentColor(agent.agentId) }}>
      {agent.status === 'applied' && <i className="agent-commit-flash" key={agent.updatedAtEpochMs} />}
      <span style={{transform:`translateY(${-24 * cursors.slice(0,index).filter(cursor => Math.abs(cursor.x-x)<8 && Math.abs(cursor.y-y)<8).length}px)`}}>➤ {agent.name} · {agentStatus[agent.status]}</span>
    </div>)}
  </div></AgentContext.Provider>
}
