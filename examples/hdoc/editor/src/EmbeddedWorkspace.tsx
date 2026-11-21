import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api, type Session } from './api'
import type { EmbeddedWorkspaceProps, HcdWorkspaceSearchLocation } from './public'
import { ResourceWorkspaceProvider } from './resources/ResourceWorkspace'
import type { ResourceReference } from './resources/resourceReference'
import { WorkflowWorkspaceProvider } from './WorkflowWorkspace'
import { SelectionTransferProvider } from './SelectionTransferWorkspace'

export type ResourcePreset = { sourceId: string; blockId?: string; sheetId?: string; range?: string }
type Group = Pick<EmbeddedWorkspaceProps, 'files' | 'activate' | 'selection' | 'ask' | 'sourceLink' | 'organize' | 'mentionable' | 'activeDocumentId' | 'searchLocation'> & {
  chooseBoard: (source: ResourcePreset) => void
  placement: { boardId: string; source: ResourcePreset } | null
  finishPlacement: () => void
  resolve: (documentId: string) => Promise<Session>
  register: (session: Session) => () => void
}
const Context = createContext<Group | null>(null)
export const useEmbeddedWorkspace = () => useContext(Context)

export function useRegisterEmbeddedSession(session: Session | null) {
  const register = useEmbeddedWorkspace()?.register
  useEffect(() => session && register ? register(session) : undefined, [register, session])
}

export function useEmbeddedSearchLocation(
  session: Session, revision: number | null | undefined, ready: boolean,
  locate: (location: HcdWorkspaceSearchLocation) => void | Promise<void>, reportError: (error: string) => void,
) {
  const group = useEmbeddedWorkspace(), handled = useRef<string | undefined>(undefined)
  const callbacks = useRef({ locate, reportError })
  callbacks.current = { locate, reportError }
  const request = group?.searchLocation, active = group?.activeDocumentId === session.documentId
  useEffect(() => {
    if (!active || !ready || revision == null || !request || request.documentId !== session.documentId ||
      handled.current === request.requestId || revision < request.revision) return
    handled.current = request.requestId
    void Promise.resolve().then(() => callbacks.current.locate(request)).catch(error => {
      if (handled.current === request.requestId) callbacks.current.reportError(error instanceof Error ? error.message : String(error))
    })
  }, [active, ready, request, revision, session.documentId])
}

/** Only editors explicitly grouped by their host share resource discovery and navigation. */
export function EmbeddedWorkspace(props: EmbeddedWorkspaceProps) {
  const { activeDocumentId, files, activate, selection, ask, sourceLink, children } = props
  const mayAsk = useCallback((ref: ResourceReference) => !!ask &&
    (ref.anchor.kind === 'sheet-range' || !!ref.anchor.blockId) &&
    files.some(f => f.documentId === ref.documentId && f.writable && f.canAsk !== false), [files, ask])
  const [choosing, setChoosing] = useState<ResourcePreset | null>(null)
  const [placement, setPlacement] = useState<Group['placement']>(null)
  const [boardId, setBoardId] = useState('')
  const boards = files.filter(f => f.format === 'excalidraw' && f.writable)
  const chooseBoard = (source: ResourcePreset) => { setChoosing(source); setBoardId(boards[0]?.documentId || '') }
  const finishPlacement = useCallback(() => setPlacement(null), [])
  const [sessions, setSessions] = useState<Session[]>([])
  const current = useRef(props)
  current.current = props
  const mounted = useRef(sessions)
  mounted.current = sessions
  const register = useCallback((session: Session) => {
    setSessions(list => [...list.filter(item => item.documentId !== session.documentId), session])
    return () => setSessions(list => list.filter(item => item !== session))
  }, [])
  const resolve = useCallback(async (id: string) => {
    const open = mounted.current.find(session => session.documentId === id)
    if (open) return open
    const file = current.current.files.find(file => file.documentId === id)
    if (!file) throw new Error('源文件不可访问。')
    const access = await current.current.access(id)
    const session: Session = { documentId: id, title: file.title, format: file.format, scope: 'read', ...access }
    const auth = await (await api(session, '/auth')).json()
    if (auth.documentId !== id || !auth.hostIntegration || !auth.operations?.includes('document.view')) throw new Error('源文件授权已失效。')
    return { ...session, serviceId: auth.serviceId, userId: auth.userId, scope: auth.scope, operations: auth.operations,
      collaborationEpoch: auth.collaborationEpoch, hostIntegration: true } as Session
  }, [])
  const group: Group = { files, activate, resolve, selection, ask, sourceLink, organize: props.organize,
    mentionable:props.mentionable, activeDocumentId, searchLocation: props.searchLocation, register, placement, chooseBoard, finishPlacement }
  return <Context.Provider value={group}><WorkflowWorkspaceProvider sessions={sessions} activate={activate}>
    <ResourceWorkspaceProvider sessions={sessions} activeDocument={activeDocumentId} activate={activate} resolve={resolve} mayAsk={mayAsk}>
      <SelectionTransferProvider host={{ files, resolve }}>{children}</SelectionTransferProvider>
      {choosing && <ChooseBoard boards={boards} id={boardId} select={setBoardId} cancel={() => setChoosing(null)} apply={() => {
        setPlacement({ boardId, source: choosing }); setChoosing(null); activate(boardId)
      }}/>}
    </ResourceWorkspaceProvider>
  </WorkflowWorkspaceProvider></Context.Provider>
}

function ChooseBoard({boards, id, select, cancel, apply}: {boards: EmbeddedWorkspaceProps['files']; id: string; select: (id: string) => void; cancel: () => void; apply: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="resource-picker" aria-label="选择目标白板" onCancel={cancel}>
    <h2>引用到白板</h2>
    <label>目标白板<select aria-label="目标白板" value={id} onChange={e => select(e.target.value)}>{boards.map(b => <option key={b.documentId} value={b.documentId}>{b.title}</option>)}</select></label>
    {!boards.length && <p>请先在首页创建一份可编辑的白板。</p>}
    <footer><button onClick={cancel}>取消</button><button className="resource-primary" disabled={!id} onClick={apply}>继续</button></footer>
  </dialog>
}
