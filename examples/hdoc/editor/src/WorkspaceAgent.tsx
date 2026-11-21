import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Session } from './api.ts'
import { hasAgentActivity, type AgentRun, type AgentTasksState } from './AgentTasks.tsx'
import { useWorkflowWorkspace, workflowService } from './WorkflowWorkspace.tsx'
import { readTabState, workspaceIdentity, writeTabState } from './tabState.ts'

type Entry = { session: Session; tasks: AgentTasksState }
const identityOf = (session: Session) => workspaceIdentity(session) || [workflowService(session), null, session.userId]
const keyOf = (session: Session, documentId = session.documentId) => JSON.stringify([...identityOf(session), documentId])
const groupOf = (session: Session) => JSON.stringify(identityOf(session))
const sameWorkspace = (a: Session, b: Session) => !!a.userId && groupOf(a) === groupOf(b)
const ownerStorageKey = (session: Session) => workspaceIdentity(session) && JSON.stringify(['hcd-ai-owner-v1', ...identityOf(session)])
const valuesOf = (state: AgentTasksState) => Object.values(state).filter(value => typeof value !== 'function')
const runKey = (run: AgentRun) => run.origin ? JSON.stringify([run.origin.key, run.runId]) : run.runId

function createStore() {
  const entries = new Map<string, Entry>(), listeners = new Set<() => void>()
  let snapshot = { version: 0, owners: {} as Record<string, string>, orphanTasks: {} as Record<string, string> }
  const emit = (next: Partial<typeof snapshot> = {}) => { snapshot = { ...snapshot, ...next, version: snapshot.version + 1 }; listeners.forEach(notify => notify()) }
  return {
    entries, snapshot: () => snapshot,
    subscribe: (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } },
    publish(session: Session, tasks: AgentTasksState) {
      const key = keyOf(session), previous = entries.get(key), before = previous && valuesOf(previous.tasks), after = valuesOf(tasks)
      entries.set(key, { session, tasks })
      const group = groupOf(session)
      if (!snapshot.owners[group]) {
        const saved = readTabState<string>(ownerStorageKey(session))
        if (typeof saved === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(saved)) {
          emit({ owners: { ...snapshot.owners, [group]: keyOf(session, saved) } })
          return
        }
      }
      if (!previous || previous.session !== session || before?.some((value, index) => value !== after[index])) emit()
    },
    remove(session: Session) {
      const key = keyOf(session), previous = entries.get(key)
      if (previous?.session !== session) return
      entries.delete(key)
      const group = groupOf(session)
      emit(snapshot.owners[group] === key ? { orphanTasks: { ...snapshot.orphanTasks, [group]: previous.tasks.task } } : {})
    },
    select(session: Session) {
      const group = groupOf(session), key = keyOf(session)
      if (snapshot.owners[group] === key) return
      writeTabState(ownerStorageKey(session), session.documentId)
      emit({ owners: { ...snapshot.owners, [group]: key }, orphanTasks: { ...snapshot.orphanTasks, [group]: '' } })
    },
  }
}
type Store = ReturnType<typeof createStore>
const Context = createContext<Store | null>(null)
const fallback = createStore()

export function useWorkspaceAgentTabActivity() {
  const store = useContext(Context) || fallback
  useSyncExternalStore(store.subscribe, store.snapshot)
  return (session: Session) => {
    const tasks = store.entries.get(keyOf(session))?.tasks
    return !!tasks && hasAgentActivity(tasks)
  }
}

export function useWorkspaceTabWriting() {
  const store = useContext(Context) || fallback
  useSyncExternalStore(store.subscribe, store.snapshot)
  return (session: Session) => store.entries.get(keyOf(session))?.tasks.runs.some(run => {
    if (run.status !== 'running' && run.status !== 'cancelling') return false
    const writing = new Set<string>()
    for (const event of run.events) {
      if (event.name !== 'hcd_patch') continue
      const agent = event.agentId || run.agentId
      if (event.type === 'tool') writing.add(agent)
      if (event.type === 'tool_result') writing.delete(agent)
    }
    return writing.size > 0
  }) || false
}
export function useWorkspaceAgentBusy(session: Session, local: AgentTasksState) {
  const context = useContext(Context)
  const store = (!session.hostIntegration && context) || fallback
  const busy = () => hasAgentActivity(local) || Array.from(store.entries.values()).some(
    entry => sameWorkspace(entry.session, session) && hasAgentActivity(entry.tasks),
  )
  return useSyncExternalStore(store.subscribe, busy, busy)
}

/** Share task navigation and drafts. Document credentials, save guards and writes
 * stay attached to their original editor; tab activation never retargets a task. */
export function WorkspaceAgentProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createStore)
  return <Context.Provider value={store}>{children}</Context.Provider>
}

export function useWorkspaceAgentRegistration(session: Session, tasks: AgentTasksState) {
  const context = useContext(Context), store = session.hostIntegration ? null : context
  useLayoutEffect(() => { store?.publish(session, tasks) })
  useLayoutEffect(() => () => store?.remove(session), [store, session])
  return store
}

export function useWorkspaceAgentTasks(session: Session | undefined, local: AgentTasksState | null) {
  const context = useContext(Context), workflow = useWorkflowWorkspace()
  const store = session?.hostIntegration ? null : context
  const snapshot = useSyncExternalStore((store || fallback).subscribe, (store || fallback).snapshot)
  const [error, setError] = useState('')
  if (!store || !session || !local) return { tasks: local, targetBar: null, openRun: undefined }
  const current = session, candidates = [...store.entries.values()].filter(entry => sameWorkspace(entry.session, current))
  const ownerKey = snapshot.owners[groupOf(current)], orphanTask = snapshot.orphanTasks[groupOf(current)] || ''
  const localEntry = candidates.find(entry => keyOf(entry.session) === keyOf(current))
  const sharedEntry = candidates.find(entry => keyOf(entry.session) === ownerKey)
  // Return to a file's own draft if there is one. A tab with no draft can
  // still display a cross-document task with its original target.
  const owner = (local.task.trim() || local.target) && localEntry ? localEntry : ownerKey ? sharedEntry : localEntry
  const base = owner?.tasks || local
  const valid = (entry: Entry | undefined) => {
    if (!entry || store.entries.get(keyOf(entry.session))?.session !== entry.session || !sameWorkspace(entry.session, current)) throw new Error('目标文件已关闭或访问身份已改变，请重新选择目标文件。')
    if (entry.session.scope !== 'write') throw new Error('目标文件为只读，无法提交编辑任务。')
    return entry
  }
  const guard = (entry: Entry) => async () => {
    valid(entry)
    if (!workflow) throw new Error('工作空间尚未就绪。')
    await workflow.prepare([entry.session])
    valid(entry)
  }
  const act = async (action: () => Promise<unknown>) => { setError(''); try { await action() } catch (cause) { setError(String(cause)) } }
  const entryForRun = (run: AgentRun) => valid(candidates.find(entry => keyOf(entry.session) === run.origin?.key))
  const continuations: AgentTasksState['continuations'] = {}
  const runs = candidates.flatMap(entry => entry.tasks.runs.map(run => {
    const result = { ...run, origin: { key: keyOf(entry.session), documentId: entry.session.documentId, title: entry.session.title || entry.session.documentId, writable: entry.tasks.writable, continuationAvailable: entry.tasks.continuationAvailable } }
    if (entry.tasks.continuations[run.runId]) continuations[runKey(result)] = entry.tasks.continuations[run.runId]
    return result
  })).sort((a, b) => (b.createdAtEpochMs || 0) - (a.createdAtEpochMs || 0) || runKey(a).localeCompare(runKey(b)))
  const continuingEntry = candidates.find(entry => entry.tasks.continuing)
  const tasks: AgentTasksState = {
    ...base, runs, continuations,
    continuing: continuingEntry ? JSON.stringify([keyOf(continuingEntry.session), continuingEntry.tasks.continuing]) : '',
    task: owner ? base.task : orphanTask, writable: !!owner && base.writable,
    error: error || base.error,
    setTask: value => { if (owner) { store.select(owner.session); owner.tasks.setTask(value) } },
    requestTask: (text, target = null, version) => { store.select(current); local.requestTask(text, target, version) },
    start: () => act(async () => { const entry = valid(owner); store.select(entry.session); await entry.tasks.start(guard(entry)) }),
    cancel: run => act(async () => { const entry = entryForRun(run); await entry.tasks.cancel(run) }),
    reviewContinuation: run => act(async () => { const entry = entryForRun(run); await entry.tasks.reviewContinuation(run, guard(entry)) }),
    resumeContinuation: run => act(async () => { const entry = entryForRun(run); await entry.tasks.resumeContinuation(run, guard(entry)) }),
  }
  const activate = (entry: Entry) => { workflow?.activate(entry.session.documentId); requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))) }
  const openRun = (run: AgentRun) => { const entry = candidates.find(item => keyOf(item.session) === run.origin?.key); if (entry) activate(entry) }
  const targetBar = <div className="workspace-agent-target" aria-label="AI 编辑目标">
    <span>编辑目标</span><button type="button" disabled={!owner} onClick={() => owner && activate(owner)}>{owner?.session.title || owner?.session.documentId || '目标文件已关闭'}</button>
    {(!owner || keyOf(owner.session) !== keyOf(current)) && <button type="button" onClick={() => {
      store.select(current)
      if (!owner && !local.task.trim() && !local.target) local.requestTask(orphanTask)
      setError('')
    }}>使用当前文件</button>}
  </div>
  return { tasks, targetBar, openRun }
}
