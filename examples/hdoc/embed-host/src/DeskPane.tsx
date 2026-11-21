import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { EmbeddedHcdEditor, useAppearance, type HcdEmbedSelection } from '@officecli/hcd-reference-editor/react'
import { useFileBinding } from './useFileBinding'
import type { Account, FileEntry } from './hostApi'
import type { Grant } from './agent'
import { scopeOf, selectionKey } from './deskFiles'
export type PaneState = {
  ready: boolean
  selectionKey: string
  scope: string
  mode: 'selection' | 'append'
}
export type PaneHandle = {
  authorize: (mode: PaneState['mode'], expected?: string) => Promise<Grant>
  selection: () => HcdEmbedSelection | null
  prepare: () => Promise<void>
  clear: () => void
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
    onSpecRewrite: (id: string, selection: HcdEmbedSelection) => void
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
  const [editorReady, setEditorReady] = useState(false)
  const register = useCallback((fn: (() => Promise<unknown>) | null) => {
    check.current = fn
    setEditorReady(!!fn)
  }, [])
  const latest = useRef({ connect, clear, selection })
  latest.current = { connect, clear, selection }
  useImperativeHandle(
    ref,
    () => ({
      selection: () => latest.current.selection,
      authorize: async (mode, expected) => {
        if (!check.current) throw Error('请等待编辑器完成同步。')
        if (expected && expected !== selectionKey(latest.current.selection)) throw Error('选区已变化，请重新核对。')
        return latest.current.connect(mode)
      },
      clear: () => latest.current.clear(),
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
  const key = selectionKey(selection)
  useEffect(() => {
    onState(file.id, { selectionKey: key, ready: !!launch && !error && editorReady && synced, scope, mode })
  }, [file.id, launch, error, scope, mode, onState, synced, key, editorReady])
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
          integratedToolbar
          onPreparationChange={register}
          onSelectionChange={report}
          onSpecRewriteRequest={account.workspace.selectionMcp && file.canDelegateSelection ? async target => {
            report(target)
            await connect()
            onSpecRewrite(file.id, target)
          } : undefined}
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
