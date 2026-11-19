import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import { EmbeddedHcdEditor, useAppearance } from '@officecli/hcd-reference-editor/react'
import { useFileBinding } from './useFileBinding'
import type { Account, FileEntry } from './hostApi'
import type { Grant, SpecUndo } from './agent'
import { scopeOf } from './deskFiles'
export type PaneState = {
  ready: boolean
  scope: string
  mode: 'selection' | 'append'
}
export type PaneHandle = {
  authorize: (mode: PaneState['mode']) => Promise<Grant>
  prepare: () => Promise<void>
  clear: () => void
  undoSpec: (ref:SpecUndo) => Promise<void>
}
const socket = new URL('/collaboration', location.origin)
socket.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
export const DeskPane = forwardRef<
  PaneHandle,
  {
    file: FileEntry
    account: Account
    committedRevision?: number
    visible: boolean
    onSpecRewrite: (id:string)=>void
    onState: (id: string, state: PaneState) => void
  }
>(function DeskPane(
  { file, account, visible, onState, onSpecRewrite, committedRevision },
  ref,
) {
  const { theme } = useAppearance()
  const { launch, error, setError, selection, report, connect, clear } =
    useFileBinding(file, account)
  const check = useRef<(() => Promise<unknown>) | null>(null)
  const register = useCallback((fn: (() => Promise<unknown>) | null) => {
    check.current = fn
  }, [])
  const latest = useRef({ connect, clear, launch })
  latest.current = { connect, clear, launch }
  useImperativeHandle(
    ref,
    () => ({
      authorize: (mode) => latest.current.connect(mode),
      clear: () => latest.current.clear(),
      undoSpec: async ({id,revision,epoch})=>{
        if(check.current)await check.current()
        const launch=latest.current.launch
        if(!launch)throw Error('请重新打开原文件。')
        const r=await fetch('/v1/documents/'+encodeURIComponent(launch.documentId)+'/canvas/spec-undo',{method:'POST',headers:{Authorization:'Bearer '+launch.token,'Content-Type':'application/json','X-HCD-Collaboration-Epoch':String(epoch)},body:JSON.stringify({id,revision})})
        if(!r.ok)throw Error((await r.json()).error || '未能撤销这次改写。')
      },
      prepare: async () => {
        if (check.current) await check.current()
      },
    }),
    [],
  )
  const scope = scopeOf(file, selection),
    mode = selection ? 'selection' : 'append'
  const synced =
    !selection || selection.target.kind==='spec' ||
    committedRevision === undefined ||
    selection.revision >= committedRevision
  useEffect(() => {
    onState(file.id, { ready: !!launch && !error && synced, scope, mode })
  }, [file.id, launch, error, scope, mode, onState, synced])
  const onError = useCallback((e: Error) => setError(e.message), [setError])
  return (
    <section
      className={'desk-editor' + (visible ? ' is-visible' : '')}
      id={'pane-' + file.id}
      role="tabpanel"
      aria-label={file.name}
      aria-hidden={!visible}
      inert={!visible}
      data-file-id={file.id}
    >
      {error && (
        <div role="alert" className="desk-error">
          {error}
        </div>
      )}
      {launch ? (
        <EmbeddedHcdEditor
          documentId={launch.documentId}
          title={file.name}
          token={launch.token}
          committedRevision={committedRevision}
          apiUrl="/v1/documents"
          collabUrl={socket.href}
          locale="zh-CN"
          appearance={theme}
          chatPanel={false}
          canvasLayout="fill"
          onPreparationChange={register}
          onSelectionChange={report}
          onSpecRewriteRequest={account.workspace.selectionMcp && file.canDelegateSelection ? async target=>{report(target);await connect();onSpecRewrite(file.id)} : undefined}
          onError={onError}
        />
      ) : (
        <div className="desk-loading" role="status">
          正在打开{file.name}…
        </div>
      )}
    </section>
  )
})
