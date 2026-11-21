import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from './api.ts'
import { readWorkflowBookmarks, workflowBookmarkKey } from './agentWorkflow.ts'

export const workflowService = (session: Session) => new URL(session.apiUrl || '/v1/documents', window.location.href).href.replace(/\/$/, '')
const documentKey = (session: Session) => JSON.stringify([workflowService(session), session.userId, session.documentId])
type Workspace = { sessions: Session[]; activate: (id: string) => void; prepare: (sessions: Session[]) => Promise<void>; register: (session: Session, prepare: () => Promise<unknown>) => () => void; openWorkflow: (session: Session, id: string) => boolean; requested?: { documentId: string; workflowId: string; sequence: number } }
const Context = createContext<Workspace | null>(null)
export const useWorkflowWorkspace = () => useContext(Context)

/** Reuse the mounted editors' save guards, including hidden document tabs.
 * No work is sent to a model until every participating editor is ready. */
export function WorkflowWorkspaceProvider({ sessions, activate, children }: { sessions: Session[]; activate: (id: string) => void; children: ReactNode }) {
  const preparations = useRef(new Map<string, () => Promise<unknown>>())
  const [requested, setRequested] = useState<Workspace['requested']>()
  const register = useCallback((session: Session, prepare: () => Promise<unknown>) => {
    const key = documentKey(session)
    preparations.current.set(key, prepare)
    return () => { if (preparations.current.get(key) === prepare) preparations.current.delete(key) }
  }, [])
  const prepare = useCallback(async (documents: Session[]) => {
    for (const document of documents) {
      if (document.scope !== 'write') continue
      const save = preparations.current.get(documentKey(document))
      if (!save) throw new Error(`请先打开「${document.title || document.documentId}」并等待编辑器加载完成。`)
      try { await save() } catch (error) { throw new Error(`「${document.title || document.documentId}」尚未就绪：${String(error)}`) }
    }
  }, [])
  const openWorkflow = useCallback((session: Session, id: string) => {
    const anchor = sessions.find(document => document.userId === session.userId && workflowService(document) === workflowService(session)
      && readWorkflowBookmarks(workflowBookmarkKey(document, workflowService(document))).some(item => item.workflowId === id))
    if (!anchor) return false
    activate(anchor.documentId)
    setRequested(previous => ({ documentId: anchor.documentId, workflowId: id, sequence: (previous?.sequence || 0) + 1 }))
    return true
  }, [sessions, activate])
  const value = useMemo(() => ({ sessions, activate, prepare, register, openWorkflow, requested }), [sessions, activate, prepare, register, openWorkflow, requested])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export type PreparationListener = (prepare: (() => Promise<unknown>) | null) => void
export const EmbedPreparation = createContext<PreparationListener | undefined>(undefined)

export function useWorkflowPreparation(session: Session | undefined, beforeRun: (() => Promise<unknown>) | undefined, enabled = true) {
  const workspace = useWorkflowWorkspace(), latest = useRef(beforeRun)
  latest.current = beforeRun
  const register = workspace?.register
  const host = useContext(EmbedPreparation)
  useLayoutEffect(() => {
    if (!enabled || !session || !host || !beforeRun) return
    host(async () => latest.current?.())
    return () => host(null)
  }, [host, session, enabled, !!beforeRun])
  useLayoutEffect(() => {
    if (!enabled || !session || !register) return
    return register(session, async () => {
      if (!latest.current) throw new Error('编辑器尚未提供保存检查。')
      return latest.current()
    })
  }, [register, session, enabled])
}
