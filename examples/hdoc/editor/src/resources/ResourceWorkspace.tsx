import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Sparkles } from 'lucide-react'
import type { Session } from '../api.ts'
import { useWorkflowWorkspace } from '../WorkflowWorkspace.tsx'
import { findResourceSession, readResource, type ResourcePreview, type ResourceReference } from './resourceReference.ts'
import './resources.css'

export type ResourceNavigation = { sequence: number; ref: ResourceReference; preview: ResourcePreview; ai: boolean; origin: string }
type ResourceWorkspace = {
  sessions: Session[]; activeDocument: string | null; navigation: ResourceNavigation | null
  navigate: (ref: ResourceReference, owner: Session, ai?: boolean) => Promise<void>
  complete: (sequence: number, error?: string) => void
}
const Context = createContext<ResourceWorkspace | null>(null)
export const useResourceWorkspace = () => useContext(Context)

export function ResourceWorkspaceProvider({ sessions, activeDocument, activate, children }: { sessions: Session[]; activeDocument: string | null; activate: (id: string) => void; children: ReactNode }) {
  const workflow = useWorkflowWorkspace()
  const [navigation, setNavigation] = useState<ResourceNavigation | null>(null), [status, setStatus] = useState(''), [error, setError] = useState('')
  const sequence = useRef(0)
  const currentSessions = useRef(sessions)
  currentSessions.current = sessions
  const currentDocument = useRef(activeDocument)
  currentDocument.current = activeDocument
  const value = useMemo<ResourceWorkspace>(() => ({ sessions, activeDocument, navigation,
    navigate: async (ref, owner, ai = false) => {
      const ticket = ++sequence.current, source = findResourceSession(ref, sessions, owner)
      if (!source) throw new Error('请先在工作空间打开源文件，验证访问权限后再进入。')
      if (ai && source.scope !== 'write') throw new Error('当前源文件为只读，无法启动编辑任务。')
      const from = currentDocument.current
      setError(''); setStatus('正在定位引用…')
      try {
        await workflow?.prepare([source])
        const preview = await readResource(source, ref)
        if (ticket !== sequence.current) return
        if (currentDocument.current !== from) { setStatus(''); return }
        if (findResourceSession(ref, currentSessions.current, owner) !== source) throw new Error('源文件已关闭或授权已改变，请重新打开后进入。')
        setNavigation({ sequence: ticket, ref, preview, ai, origin: owner.documentId })
        activate(source.documentId)
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
      } catch (cause) { if (ticket === sequence.current) { setStatus(''); setError(String(cause)) } throw cause }
    },
    complete: (ticket, cause) => { if (ticket === sequence.current) { setStatus(''); setError(cause || '') } },
  }), [sessions, activeDocument, navigation, workflow, activate])
  useEffect(() => {
    if (!navigation || sessions.some(session => session.documentId === navigation.ref.documentId)) return
    setNavigation(null)
    setStatus('')
    setError('')
  }, [sessions, navigation])
  const inSource = navigation && activeDocument === navigation.ref.documentId
  return <Context.Provider value={value}>
    {inSource && <div className="resource-navigation" role="region" aria-label="资源引用定位">
      <button type="button" disabled={!sessions.some(s => s.documentId === navigation.origin)} onClick={() => { activate(navigation.origin); requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))) }}><ArrowLeft size={14} />返回白板</button>
      <span>{navigation.preview.title} · {navigation.preview.label}</span><small role="status">{status || (error ? '' : '已进入源文件')}</small>
      {!error && sessions.some(s => s.documentId === navigation.ref.documentId && s.scope === 'write') && <button type="button" onClick={() => { const owner = sessions.find(s => s.documentId === navigation.origin); if (owner) void value.navigate(navigation.ref, owner, true).catch(() => {}) }}><Sparkles size={14} />让 AI 编辑此引用</button>}
    </div>}
    {error && <p role="alert" className="resource-navigation-error">{error}</p>}
    {children}
  </Context.Provider>
}

export function useResourceNavigation(session: Session, ready: boolean, locate: (navigation: ResourceNavigation) => Promise<void> | void) {
  const workspace = useResourceWorkspace(), handler = useRef(locate), complete = useRef(workspace?.complete), handled = useRef(0)
  handler.current = locate; complete.current = workspace?.complete
  const request = workspace?.navigation
  const active = workspace?.activeDocument === session.documentId
  useEffect(() => {
    if (!active || !ready || !request || request.ref.documentId !== session.documentId || handled.current >= request.sequence) return
    handled.current = request.sequence
    void Promise.resolve().then(() => handler.current(request)).then(() => complete.current?.(request.sequence), cause => complete.current?.(request.sequence, String(cause)))
  }, [active, ready, request, session.documentId])
}
