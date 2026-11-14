import { Layers2, Plus, X } from 'lucide-react'
import { WorkspaceLibrary, FormatIcon } from './WorkspaceLibrary.tsx'
import { LocaleSelect, useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { clearPastedBlockIds, jsonToSnapshot, schemaExtensions, type Projection } from './schema.ts'
import { ContextMenu, type MenuAction } from './ContextMenu.tsx'
import { api, type Session } from './api.ts'
import { loadTheme, type ThemeFace } from './themeCss.ts'
import { BlockFontPicker } from './BlockFontPicker.tsx'
import { FixedViewer } from './FixedViewer.tsx'
import { EditorHeader, EditorStatusbar, ContentToolbar, PanelDock, CollapseOutlineIcon } from './EditorChrome.tsx'
import { DocumentSearch, type SearchHit, type SearchResult } from './DocumentSearch.tsx'
import { readLayout, saveLayout, type LayoutPreferences } from './editorLayout.ts'
import { ErrorToast } from './ErrorToast.tsx'
import { AgentActivityLayer, AgentPanel, useAgentWorkspace } from './AgentActivityLayer.tsx'
import { opaquePreviewExtension } from './opaquePreview.ts'
import { CanvasZoomProvider, CanvasViewport } from './CanvasZoom.tsx'
import { DocumentViewProvider, useDocumentViewState } from './DocumentViewState.tsx'
import { RevisionWorkspace } from './RevisionWorkspace.tsx'
import './style.css'
import './soft-canvas.css'
import './revision-workspace.css'

const UniverViewer = lazy(() => import('./UniverViewer.tsx').then(module => ({ default: module.UniverViewer })))

const palette = ['#d84a54', '#3478c0', '#9a5abb', '#13866a', '#d17d20', '#7b65d8']
type RevisionItem = { revision: number; patchId?: string; authorId?: string; authorName?: string; createdAtEpochMs?: number }
function presenceColor(id: string) {
  let value = 0
  for (const character of id) value = (value * 31 + character.charCodeAt(0)) >>> 0
  return palette[value % palette.length]
}
function browserUserId(): string {
  const key = 'hcd-editor-browser-user-v1'
  try {
    const existing = localStorage.getItem(key)
    if (existing && /^[0-9a-f-]{36}$/.test(existing)) return existing
    const created = crypto.randomUUID()
    localStorage.setItem(key, created)
    return created
  } catch { return crypto.randomUUID() }
}

export function App() {
  const { locale } = useI18n()
  const [documentId, setDocumentId] = useState(sessionStorage.getItem('hcd-document') || '')
  const [token, setToken] = useState(sessionStorage.getItem('hcd-token') || '')
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeDocument, setActiveDocument] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [samples, setSamples] = useState<Array<{ id: string; title: string; format: string; mode: string }>>([])
  const [openingSample, setOpeningSample] = useState<string | null>(null)
  const [portableFile, setPortableFile] = useState<File | null>(null)
  const [uploadToken, setUploadToken] = useState('')
  const [uploadState, setUploadState] = useState('')
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let active = true
    fetch('/__hcd_demo/documents').then(response => response.ok ? response.json() : [])
      .then((available: typeof samples) => { if (active) setSamples(available) })
      .catch(() => {})
    return () => { active = false }
  }, [])
  async function open(id: string, accessToken: string, remember = true) {
    setError('')
    try {
      const draft: Session = { documentId: id.trim(), token: accessToken.trim(), scope: 'read', format: '' }
      const [auth, manifest] = await Promise.all([api(draft, '/auth'), api(draft, '')])
      const access = await auth.json() as { scope: 'read' | 'write'; userId?: string; displayName?: string; collaborationEpoch: number }
      const metadata = await manifest.json() as { source: { format: string } }
      if (remember) {
        sessionStorage.setItem('hcd-document', draft.documentId)
        sessionStorage.setItem('hcd-token', draft.token)
      }
      const opened = { ...draft, title: samples.find(sample => sample.id === draft.documentId)?.title, scope: access.scope, format: metadata.source.format,
        userId: access.userId || undefined, displayName: access.displayName || undefined,
        collaborationEpoch: access.collaborationEpoch }
      setSessions(previous => previous.some(item => item.documentId === opened.documentId)
        ? previous.map(item => item.documentId === opened.documentId ? opened : item) : [...previous, opened])
      setActiveDocument(opened.documentId)
    } catch (cause) { setError(String(cause)) }
  }
  async function openSample(id: string) {
    setOpeningSample(id)
    setError('')
    try {
      const response = await fetch(`/__hcd_demo/session/${encodeURIComponent(id)}`, { method: 'POST' })
      if (!response.ok) throw new Error(`无法打开验收文档：${response.status}`)
      const sample = await response.json() as { documentId: string; token: string }
      sessionStorage.removeItem('hcd-document')
      sessionStorage.removeItem('hcd-token')
      setDocumentId('')
      setToken('')
      await open(sample.documentId, sample.token, false)
    } catch (cause) { setError(String(cause)) }
    finally { setOpeningSample(null) }
  }
  async function uploadPortable() {
    if (!portableFile || !uploadToken.trim()) return
    setError('')
    setUploadState('上传中…')
    try {
      if (!portableFile.name.toLowerCase().endsWith('.hcd')) throw new Error('请选择 .hcd 文件')
      const headers = { Authorization: `Bearer ${uploadToken.trim()}` }
      const response = await fetch(`/v1/import?filename=${encodeURIComponent(portableFile.name)}`, {
        method: 'POST', headers, body: portableFile,
      })
      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
      const job = await response.json() as { jobId: string; documentId: string; state: string; error?: string }
      let current = job
      for (let attempt = 0; current.state !== 'completed' && current.state !== 'failed' && attempt < 600; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        const status = await fetch(`/v1/jobs/${encodeURIComponent(job.jobId)}`, { headers })
        if (!status.ok) throw new Error(`${status.status}: ${await status.text()}`)
        current = await status.json() as typeof job
      }
      if (current.state !== 'completed') throw new Error(current.state === 'failed' ? current.error || 'HCD 校验或导入失败' : `导入仍在进行，任务 ID：${job.jobId}`)
      setDocumentId(current.documentId)
      setUploadToken('')
      setUploadState(`已导入 ${current.documentId}。输入该文档的访问令牌后打开。`)
    } catch (cause) {
      setUploadState('')
      setError(`HCD 导入失败：${String(cause)}`)
    }
  }
  function closeTab(id: string) {
    if (!window.confirm('关闭此文档标签？请先保存未提交的修改。切换标签可以保留编辑状态。')) return
    setSessions(previous => previous.filter(item => item.documentId !== id))
    if (activeDocument === id) setActiveDocument(null)
  }
  const library = <WorkspaceLibrary samples={samples} sessions={sessions} opening={openingSample} onOpen={id => void openSample(id)} onResume={setActiveDocument}>
    <section className="manual-access"><p><LocalText source={"输入文档 ID 和短期访问令牌。只读令牌无法提交修改。"} /></p><label><LocalText source={"文档 ID"} /><input value={documentId} onChange={event => setDocumentId(event.target.value)} placeholder="doc-…" /></label><label><LocalText source={"访问令牌"} /><textarea rows={4} value={token} onChange={event => setToken(event.target.value)} placeholder={localizeSource(locale, "粘贴短期令牌")} /></label><button onClick={() => void open(documentId, token)} disabled={!documentId || !token}><LocalText source={"打开文档"} /></button></section>
    <section className="manual-access portable-import"><p><LocalText source={"重新打开单文件 HCD。上传令牌用于导入，文档访问令牌用于打开。"} /></p><label><LocalText source={"HCD 文件"} /><input type="file" accept=".hcd" onChange={event => setPortableFile(event.target.files?.[0] ?? null)} /></label><label><LocalText source={"上传令牌"} /><textarea rows={2} value={uploadToken} onChange={event => setUploadToken(event.target.value)} placeholder={localizeSource(locale, "粘贴短期上传令牌")} /></label><button onClick={() => void uploadPortable()} disabled={!portableFile || !uploadToken.trim() || uploadState === '上传中…'}><LocalText source={"导入 HCD"} /></button>{uploadState && <p role="status">{localizeDynamic(locale, uploadState)}</p>}</section>
    {error && <p className="error">{localizeDynamic(locale, error)}</p>}
  </WorkspaceLibrary>
  return <div className="hcd-surface multi-document-workspace">
    <nav className="document-tabs" aria-label={localizeSource(locale, "已打开的文档")} hidden={!sessions.length}>
      <button className="tabs-brand" aria-label={localizeSource(locale, '文档工作台')} onClick={() => setActiveDocument(null)}><Layers2 size={21} /><strong>office.</strong></button><button className={activeDocument === null ? 'active open-document-tab' : 'open-document-tab'} aria-label={localizeSource(locale, '打开其他文档')} onClick={() => setActiveDocument(null)}><Plus size={15} /><LocalText source="打开文档" /></button>
      {sessions.map(item => <div className={`document-tab ${activeDocument === item.documentId ? 'active' : ''}`} key={item.documentId}>
        <button aria-current={activeDocument === item.documentId ? 'page' : undefined} onClick={() => { setActiveDocument(item.documentId); requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))) }} title={item.documentId}>
          <FormatIcon format={item.format} size={14} /> <span>{item.title || item.documentId}</span><small>{item.format.toUpperCase()}</small>
          {item.scope === 'read' && <span> · 只读</span>}
        </button><button className="close-document-tab" aria-label={`关闭 ${item.documentId}`} onClick={() => closeTab(item.documentId)}><X size={13} /></button>
      </div>)}
    </nav>
    <div className="document-tab-panel document-library" hidden={activeDocument !== null}>{library}</div>
    {sessions.map(item => <div className="document-tab-panel" key={item.documentId} hidden={activeDocument !== item.documentId} data-document-id={item.documentId}>
      <Workspace key={item.documentId} session={item} onClose={() => setActiveDocument(null)} onEpochChange={epoch => setSessions(previous => previous.map(value => value.documentId === item.documentId ? { ...value, collaborationEpoch: epoch } : value))} />
    </div>)}
  </div>
}

type WorkspaceProps = { session: Session; onClose: () => void; onEpochChange?: (epoch: number) => void; embedded?: boolean }
export function Workspace(props: WorkspaceProps) {
  return <DocumentViewProvider key={`${props.session.apiUrl || ''}:${props.session.documentId}`} initialPreview={props.session.scope === 'read'}><CanvasZoomProvider>
    <EpochWorkspace key={props.session.collaborationEpoch ?? 0} {...props} />
  </CanvasZoomProvider></DocumentViewProvider>
}

function EpochWorkspace({ session, onClose, onEpochChange, embedded = false }: WorkspaceProps) {
  const semantic = ['docx', 'html', 'md', 'txt'].includes(session.format)
  const content = semantic ? <SemanticEditor session={session} onClose={onClose} onEpochChange={onEpochChange} embedded={embedded} />
    : session.format === 'xlsx' ? <Suspense fallback={<div className="embedded-loading"><LocalText source={"正在加载工作簿…"} /></div>}><UniverViewer session={session} onClose={onClose} embedded={embedded} /></Suspense>
      : <FixedViewer session={session} onClose={onClose} embedded={embedded} />
  return <AgentActivityLayer session={session}>{content}</AgentActivityLayer>
}

function SemanticEditor({ session, onClose, onEpochChange, embedded }: { session: Session; onClose: () => void; onEpochChange?: (epoch: number) => void; embedded: boolean }) {
  const { locale } = useI18n()
  const { preview, setPreview: setReadOnly, focused, setFocused, wrapText, setWrapText, selectedRevision, setSelectedRevision, comparing, setComparing, rightPanel, setRightPanel, activeTab, setActiveTab } = useDocumentViewState()
  const readOnly = session.scope === 'read' || preview
  const [status, setStatus] = useState('连接中')
  const [revision, setRevision] = useState<number | null>(null)
  const [history, setHistory] = useState<RevisionItem[]>([])
  const [nextBefore, setNextBefore] = useState<number | null | undefined>(undefined)
  const [historical, setHistorical] = useState<Projection | null>(null)
  const [comparisonHead, setComparisonHead] = useState<Projection | null>(null)
  const [historyLoading, setHistoryLoading] = useState(selectedRevision !== null)
  const [historyReload, setHistoryReload] = useState(0)
  const [editorSynced, setEditorSynced] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [restoring, setRestoring] = useState(false)
  const historyRequest = useRef<AbortController | null>(null)
  const historyActive = selectedRevision !== null
  useEffect(() => () => historyRequest.current?.abort(), [])
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkHref, setLinkHref] = useState('')
  const [presence, setPresence] = useState<Array<{ id: string; name: string; color: string; connections: number }>>([])
  const { panelOpen, setPanelOpen } = useAgentWorkspace()
  const [layout, setLayout] = useState<LayoutPreferences>(() => readLayout(session.documentId))
  function showRightPanel(panel: 'settings' | 'revisions') { setFocused(false); setPanelOpen(false); setRightPanel(panel) }
  const [outline, setOutline] = useState<Array<{ pos: number; level: number; text: string }>>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchVersion, setSearchVersion] = useState(0)
  const [themeCss, setThemeCss] = useState('')
  const [themeFaces, setThemeFaces] = useState<ThemeFace[]>([])
  const lastOutline = useRef('')
  const lastSemantic = useRef<string | null>(null)
  const canonicalHead = useRef<Promise<number> | null>(null)
  useEffect(() => { saveLayout(layout, session.documentId) }, [layout, session.documentId])
  useEffect(() => {
    let live = true
    loadTheme(session, null, { editor: true })
      .then(theme => { if (live) { setThemeCss(theme.css); setThemeFaces(theme.faces) } })
      .catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [session])
  function setLayoutOption(key: keyof LayoutPreferences, value: boolean) {
    setLayout(previous => ({ ...previous, [key]: value }))
  }
  const ydoc = useMemo(() => new Y.Doc(), [session.documentId])
  const localUser = useMemo(() => {
    const id = session.userId || browserUserId()
    return { id, clientId: ydoc.clientID, name: session.displayName?.trim() || `User ${id.slice(0, 4)}`, color: presenceColor(id) }
  }, [session.userId, session.displayName, ydoc])
  const provider = useMemo(() => new HocuspocusProvider({
    url: session.collabUrl || import.meta.env.VITE_HCD_COLLAB_URL || 'ws://127.0.0.1:8768',
    name: `${session.documentId}:${session.collaborationEpoch ?? 0}`,
    document: ydoc,
    token: session.token,
  }), [session.documentId, session.collaborationEpoch, session.token, ydoc])
  const editor = useEditor({
    extensions: [...schemaExtensions.map(extension => extension.name === 'hcdOpaque' ? opaquePreviewExtension(session) : extension), Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider, user: localUser, render: user => {
        const cursor = document.createElement('span')
        const samePerson = user.id === localUser.id
        const earlierConnection = Array.from(provider.awareness?.getStates().values() || []).some(value =>
          value.user?.id === user.id && typeof value.user?.clientId === 'number' && value.user.clientId < user.clientId)
        if (samePerson || earlierConnection) { cursor.style.display = 'none'; return cursor }
        cursor.className = 'collaboration-carets__caret'
        cursor.style.borderColor = user.color
        const label = document.createElement('span')
        label.className = 'collaboration-carets__label'
        label.style.backgroundColor = user.color
        label.textContent = String(user.name || 'User').slice(0, 64)
        cursor.append(label)
        return cursor
      } })],
    editable: !readOnly,
    editorProps: { attributes: { class: 'hcd-editor-body' }, transformPasted: clearPastedBlockIds },
    onUpdate: ({ editor: changedEditor }) => {
      setSearchVersion(previous => previous + 1)
      const semantic = JSON.stringify(jsonToSnapshot(changedEditor.getJSON()).map(block => block.content))
      if (lastSemantic.current !== null && semantic !== lastSemantic.current && !readOnly) setStatus('编辑中')
      lastSemantic.current = semantic
      const headings: Array<{ pos: number; level: number; text: string }> = []
      changedEditor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') headings.push({ pos, level: node.attrs.level || 1, text: node.textContent || '未命名标题' })
      })
      const serialized = JSON.stringify(headings)
      if (serialized !== lastOutline.current) { lastOutline.current = serialized; setOutline(headings) }
    },
  }, [ydoc])
  useEffect(() => {
    editor?.setEditable(!readOnly && !historyActive)
  }, [editor, readOnly, historyActive])
  useEffect(() => {
    const connection = ({ status: next }: { status: string }) => setStatus(next === 'connected' ? '已连接' : '连接中')
    const saveState = ({ payload }: { payload: string }) => {
      let message: { type?: string; status?: string; revision?: number }
      try { message = JSON.parse(payload) } catch { return }
      if (message.type !== 'hcd-save-status') return
      if (message.status === 'editing') setStatus('编辑中')
      if (message.status === 'saving') setStatus('保存中')
      if (message.status === 'failed') {
        setStatus('保存失败')
        setError('自动保存失败，正在重试')
      }
      if (message.status === 'saved') {
        setStatus('已保存')
        setError(previous => previous === '自动保存失败，正在重试' ? '' : previous)
        if (Number.isSafeInteger(message.revision)) {
          setRevision(previous => Math.max(previous ?? 0, message.revision!))
        }
      }
    }
    const refreshPresence = () => {
      const unique = new Map<string, { id: string; name: string; color: string; connections: number }>()
      for (const [clientId, value] of provider.awareness?.getStates() || []) {
        const user = value.user as { id?: string; name?: string; color?: string } | undefined
        if (!user?.name) continue
        const id = user.id || (user.name === localUser.name && user.color === localUser.color ? localUser.id : `client:${clientId}`)
        const previous = unique.get(id)
        if (previous) { previous.connections += 1; continue }
        unique.set(id, { id, name: user.name.trim().slice(0, 64), color: user.color || presenceColor(id), connections: 1 })
      }
      setPresence(Array.from(unique.values()).sort((left, right) => Number(right.id === localUser.id) - Number(left.id === localUser.id)))
    }
    const synced = () => {
      setEditorSynced(true)
      setStatus('已同步')
      // Creating the semantic projection can advance the imported revision while
      // the first collaboration room is loading. Wait for that baseline on save.
      const head = api(session, '/editor').then(response => response.json()).then((projection: Projection) => {
        setRevision(previous => Math.max(previous ?? 0, projection.revision))
        return projection.revision
      })
      canonicalHead.current = head
      void head.catch(cause => setError(String(cause)))
    }
    provider.on('status', connection)
    provider.on('synced', synced)
    provider.on('stateless', saveState)
    provider.awareness?.on('change', refreshPresence)
    refreshPresence()
    return () => { provider.off('status', connection); provider.off('synced', synced); provider.off('stateless', saveState); provider.awareness?.off('change', refreshPresence); provider.destroy(); ydoc.destroy() }
  }, [provider, ydoc, localUser])
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const [revisionResponse, authResponse] = await Promise.all([api(session, '/revisions'), api(session, '/auth')])
        const access = await authResponse.json() as { collaborationEpoch: number }
        if (access.collaborationEpoch !== (session.collaborationEpoch ?? 0)) {
          onEpochChange?.(access.collaborationEpoch)
          return
        }
        const result = await revisionResponse.json() as { headRevision: number; revisions: RevisionItem[]; nextBefore: number | null }
        if (!alive) return
        setRevision(previous => { if (previous !== null && result.headRevision > previous) setStatus('已保存'); return result.headRevision })
        setHistory(previous => Array.from(new Map([...previous, ...result.revisions].map(item => [item.revision, item])).values()).sort((a, b) => a.revision - b.revision))
        setNextBefore(previous => previous === undefined ? result.nextBefore : previous)
      } catch (cause) { if (alive) setError(String(cause)) }
    }
    void refresh()
    const interval = setInterval(() => void refresh(), 5000)
    return () => { alive = false; clearInterval(interval) }
  }, [session, onEpochChange])
  async function loadOlderRevisions() {
    if (nextBefore === null || nextBefore === undefined) return
    try {
      const result = await (await api(session, `/revisions?before=${nextBefore}`)).json() as {
        revisions: RevisionItem[]; nextBefore: number | null
      }
      setHistory(previous => Array.from(new Map([...previous, ...result.revisions].map(item => [item.revision, item])).values()).sort((a, b) => a.revision - b.revision))
      setNextBefore(result.nextBefore)
    } catch (cause) { setError(String(cause)) }
  }
  async function save(): Promise<number | null> {
    if (!editor || revision === null) return null
    if (session.scope === 'read') return revision
    setStatus('保存中')
    setError('')
    try {
      const expectedRevision = Math.max(revision, await (canonicalHead.current ?? Promise.resolve(revision)))
      const blocks = jsonToSnapshot(editor.getJSON())
      let saved: { revision: number; projection: Projection }
      try {
        saved = await (await api(session, '/checkpoints', {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            'X-HCD-Collaboration-Epoch': String(session.collaborationEpoch ?? 0) },
          body: JSON.stringify({ expectedRevision, blocks }),
        })).json() as typeof saved
      } catch (cause) {
        if (!String(cause).includes('409:')) throw cause
        // The collaboration sidecar may have committed this exact snapshot first.
        // Only acknowledge identical content; a divergent revision stays a conflict.
        const projection = await (await api(session, '/editor')).json() as Projection
        const contents = (items: typeof blocks) => JSON.stringify(items.map(({ content }) => ({
          kind: content.kind, level: content.level ?? null, font: content.font ?? null,
          inlines: content.inlines.filter(inline => inline.text).map(inline => ({
            text: inline.text, bold: !!inline.bold, italic: !!inline.italic, link: inline.link ?? null,
          })),
        })))
        if (contents(blocks) !== contents(projection.blocks.filter(block => block.region === 'body'))) throw cause
        saved = { revision: projection.revision, projection }
      }
      const nodes = ydoc.getXmlFragment('default').toArray().flatMap(item => {
        if (!(item instanceof Y.XmlElement)) return []
        if (item.nodeName === 'bulletList' || item.nodeName === 'orderedList') return item.toArray().filter((node): node is Y.XmlElement => node instanceof Y.XmlElement)
        return [item]
      })
      const canonical = saved.projection.blocks.filter(block => block.region === 'body')
      if (nodes.length === canonical.length) ydoc.transact(() => nodes.forEach((node, index) => {
        if (node.getAttribute('hcdBlockId') !== canonical[index].blockId) {
          node.setAttribute('hcdBlockId', canonical[index].blockId)
        }
      }), 'hcd-canonical-ids')
      setRevision(saved.revision)
      setStatus('已保存')
      return saved.revision
    } catch (cause) { setStatus('保存失败'); setError(String(cause)); return null }
  }
  function showRevision(number: number) {
    setSelectedRevision(number)
    setHistoryReload(value => value + 1)
    if (window.matchMedia('(max-width: 900px)').matches) setRightPanel(null)
  }
  useEffect(() => {
    historyRequest.current?.abort()
    if (selectedRevision === null) return
    const request = new AbortController()
    historyRequest.current = request
    setHistorical(null); setComparisonHead(null)
    setHistoryLoading(true); setHistoryError(''); setMenu(null); setSearchOpen(false)
    void Promise.all([
      api(session, `/editor?revision=${selectedRevision}`, { signal: request.signal }).then(response => response.json() as Promise<Projection>),
      api(session, '/editor', { signal: request.signal }).then(response => response.json() as Promise<Projection>),
    ]).then(([old, head]) => {
      if (!request.signal.aborted) { setHistorical(old); setComparisonHead(head) }
    }).catch(cause => { if (!request.signal.aborted) setHistoryError(String(cause)) })
      .finally(() => { if (!request.signal.aborted) setHistoryLoading(false) })
    return () => request.abort()
  }, [session, selectedRevision, historyReload])
  function returnToCurrent() {
    historyRequest.current?.abort()
    setSelectedRevision(null); setHistorical(null); setHistoryLoading(false); setHistoryError(''); setComparing(false)
  }
  const comparisonCurrent = useMemo<Projection | null>(() => {
    if (!comparisonHead || !editor || !historyActive) return null
    const canonical = new Map(comparisonHead.blocks.map(block => [block.blockId, block]))
    return { ...comparisonHead, blocks: jsonToSnapshot(editor.getJSON()).map((block, index) => ({
      ...canonical.get(block.blockId || ''), blockId: block.blockId || `local-draft-${index}`,
      blockHash: canonical.get(block.blockId || '')?.blockHash || '', region: 'body',
      readOnly: canonical.get(block.blockId || '')?.readOnly || block.content.kind === 'opaque', content: block.content,
    })) }
  }, [comparisonHead, editor, searchVersion, historyActive])
  const visibleOutline = useMemo(() => historyActive
    ? (historical?.blocks || []).filter(block => block.region === 'body' && block.content.kind === 'heading').map(block => ({
      key: block.blockId, blockId: block.blockId, pos: null, level: block.content.level || 1,
      text: block.content.inlines.map(inline => inline.text).join('') || localizeSource(locale, '未命名标题'),
    }))
    : outline.map(item => ({ ...item, key: String(item.pos), blockId: null, pos: item.pos })), [historical, historyActive, outline, locale])
  const selectedMetadata = history.find(item => item.revision === selectedRevision)
  const revisionMetadata = [selectedMetadata?.authorName || localizeSource(locale, selectedRevision === 0 ? '初始导入' : '作者未记录'),
    selectedMetadata?.createdAtEpochMs ? new Date(selectedMetadata.createdAtEpochMs).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · ')
  function locateHistoricalBlock(blockId: string) {
    const column = editor?.view.dom.closest('.workspace')?.querySelector('.revision-column')
    column?.querySelectorAll('.history-search-hit').forEach(node => node.classList.remove('history-search-hit'))
    const target = column?.querySelector(`[data-hcd-block-id="${CSS.escape(blockId)}"]`)
    target?.classList.add('history-search-hit')
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  function navigateOutline(item: typeof visibleOutline[number]) {
    if (item.blockId) { locateHistoricalBlock(item.blockId); return }
    if (!editor || item.pos === null) return
    editor.commands.focus()
    editor.commands.setTextSelection(item.pos + 1)
    editor.view.domAtPos(item.pos + 1).node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  async function restoreHistorical() {
    if (!historical || session.scope !== 'write' || restoring) return
    setRestoring(true)
    try {
      const head = await save()
      if (head === null || historical.revision >= head) return
      await api(session, `/restore/${historical.revision}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: head }) })
      const access = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
      onEpochChange?.(access.collaborationEpoch)
    } catch (cause) { setError(String(cause)) }
    finally { setRestoring(false) }
  }
  function moveBlock(direction: -1 | 1) {
    if (!editor || readOnly) return
    const { state } = editor
    const positions: Array<{ pos: number; node: typeof state.doc }> = []
    state.doc.forEach((node, offset) => positions.push({ pos: offset, node: node as typeof state.doc }))
    const current = positions.findIndex(({ pos, node }) => state.selection.from >= pos && state.selection.from < pos + node.nodeSize)
    const other = current + direction
    if (current < 0 || other < 0 || other >= positions.length) return
    const first = positions[Math.min(current, other)]
    const second = positions[Math.max(current, other)]
    const tr = state.tr.replaceWith(first.pos, second.pos + second.node.nodeSize, direction < 0 ? [second.node, first.node] : [second.node, first.node])
    editor.view.dispatch(tr)
  }
  function deleteCurrentBlock() {
    if (!editor || readOnly) return
    const current = editor.state.selection.from
    let range: { from: number; to: number } | null = null
    editor.state.doc.forEach((node, pos) => {
      if (current >= pos && current < pos + node.nodeSize) range = { from: pos, to: pos + node.nodeSize }
    })
    if (range) editor.chain().focus().deleteRange(range).run()
  }
  function openLink() {
    if (!editor || readOnly) return
    setLinkHref(String(editor.getAttributes('link').href || ''))
    setLinkOpen(true)
  }
  function applyLink() {
    if (!editor || readOnly) return
    const value = linkHref.trim()
    try {
      const url = new URL(value)
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || value.length > 2048) throw new Error('链接只支持 http、https 或 mailto，且不能超过 2048 个字符')
      editor.chain().focus().extendMarkRange('link').setLink({ href: url.href }).run()
      setLinkOpen(false)
      setError('')
    } catch (cause) { setError(cause instanceof TypeError ? '请输入完整的 http、https 或 mailto 链接' : String(cause)) }
  }
  async function searchContent(query: string): Promise<SearchResult> {
    const hits: SearchHit[] = []
    if (!editor) return { revision: revision ?? 0, hits, truncated: false }
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return { revision: revision ?? 0, hits, truncated: false }
    if (historyActive) {
      for (const block of historical?.blocks || []) {
        if (block.region !== 'body') continue
        const text = block.content.inlines.map(inline => inline.text).join('')
        const lower = text.toLocaleLowerCase()
        let start = 0
        while (hits.length <= 200) {
          const offset = lower.indexOf(needle, start)
          if (offset < 0) break
          hits.push({ chunkSequence: 0, region: 'body', nodeId: block.blockId, offset,
            preview: text.slice(Math.max(0, offset - 32), offset + needle.length + 48), matchLength: query.trim().length })
          start = offset + needle.length
        }
        if (hits.length > 200) break
      }
      return { revision: selectedRevision!, hits: hits.slice(0, 200), truncated: hits.length > 200 }
    }
    editor.state.doc.descendants((node, pos) => {
      if (hits.length > 200) return false
      if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true
      const text = node.textContent
      const lower = text.toLocaleLowerCase()
      let start = 0
      while (hits.length <= 200) {
        const offset = lower.indexOf(needle, start)
        if (offset < 0) break
        const before = Math.max(0, offset - 32)
        const after = Math.min(text.length, offset + query.length + 48)
        hits.push({ chunkSequence: 0, region: 'body', nodeId: String(pos), offset,
          position: pos + 1 + offset, matchLength: query.trim().length,
          preview: `${before ? '…' : ''}${text.slice(before, after)}${after < text.length ? '…' : ''}` })
        start = offset + Math.max(needle.length, 1)
      }
      return false
    })
    return { revision: revision ?? 0, hits: hits.slice(0, 200), truncated: hits.length > 200 }
  }
  function navigateSearch(hit: SearchHit) {
    if (historyActive) {
      locateHistoricalBlock(hit.nodeId)
      return
    }
    if (!editor || hit.position === undefined) return
    const from = Math.min(hit.position, editor.state.doc.content.size)
    editor.commands.setTextSelection({ from, to: Math.min(from + (hit.matchLength || 1), editor.state.doc.content.size) })
    editor.view.domAtPos(from).node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  const actions: MenuAction[] = [
    { label: '复制选中内容', action: () => { if (editor) void navigator.clipboard.writeText(menu?.selectedText || editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, '\n')).catch(cause => setError(String(cause))) } },
    { label: '粘贴文本', disabled: readOnly, action: () => { if (editor) void navigator.clipboard.readText().then(text => editor.chain().focus().insertContent(text).run()).catch(cause => setError(String(cause))) } },
    { label: '新增段落', disabled: readOnly, separated: true, action: () => editor?.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'text', text: '新段落' }] }).run() },
    { label: '删除段落', disabled: readOnly, action: deleteCurrentBlock },
    { label: '设为标题', disabled: readOnly, action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: '设为列表', disabled: readOnly, action: () => editor?.chain().focus().toggleBulletList().run() },
    { label: '加粗', disabled: readOnly, separated: true, action: () => editor?.chain().focus().toggleBold().run() },
    { label: '斜体', disabled: readOnly, action: () => editor?.chain().focus().toggleItalic().run() },
    { label: '设置链接', disabled: readOnly, action: openLink },
    { label: '移除链接', disabled: readOnly || !editor?.isActive('link'), action: () => editor?.chain().focus().extendMarkRange('link').unsetLink().run() },
    { label: '上移段落', disabled: readOnly, separated: true, action: () => moveBlock(-1) },
    { label: '下移段落', disabled: readOnly, action: () => moveBlock(1) },
    { label: '撤销', disabled: readOnly || !editor?.can().undo(), separated: true, action: () => editor?.chain().focus().undo().run() },
    { label: '重做', disabled: readOnly || !editor?.can().redo(), action: () => editor?.chain().focus().redo().run() },
  ]
  return <div data-format={session.format} data-hcd-history={historyActive ? 'true' : undefined} className={`workspace semantic-workspace ${embedded ? 'embedded' : ''} ${layout.compact ? 'compact-header' : ''} ${layout.showOutline && !focused ? '' : 'outline-hidden'} ${(rightPanel || panelOpen) && !focused ? '' : 'right-hidden'} ${focused ? 'focus-mode' : ''}`}>
    {layout.showHeader && <EditorHeader session={session} revision={selectedRevision ?? revision} status={historyActive ? '历史只读' : status} activeTab={activeTab}
      onTab={tab => { setActiveTab(tab); if (tab === 'revisions') { setPanelOpen(false); showRightPanel('revisions') } }} onClose={onClose}
      onSettings={() => setRightPanel(previous => previous === 'settings' ? null : 'settings')} onSearch={() => setSearchOpen(true)} settingsOpen={rightPanel === 'settings' && !panelOpen && !focused} focused={focused} onFocus={() => setFocused(value => !value)} readOnly={readOnly || historyActive} onReadOnly={value => { if (historyActive) returnToCurrent(); if (session.scope === 'write') setReadOnly(value) }} beforeExport={historyActive ? async () => selectedRevision : save}
      presence={layout.showCollaborators && <details className="presence"><summary aria-label={`${localizeSource(locale, "在线协作者")} · ${presence.length}`}><span className="presence-avatars">{presence.slice(0, 3).map(user => <span key={user.id} className="avatar" title={user.name} style={{ background: user.color }}>{user.name.slice(0, 1)}</span>)}</span><span>{presence.length} <LocalText source={" 人在线"} /></span></summary><div className="presence-menu"><strong><LocalText source={"在线协作者"} /></strong>{presence.map(user => <div key={user.id} className="presence-person"><span className="avatar" style={{ background: user.color }}>{user.name.slice(0, 1)}</span><span>{user.name}{user.id === localUser.id ? localizeSource(locale, '（你）') : ''}</span>{user.connections > 1 && <small>{user.connections} <LocalText source={" 个窗口"} /></small>}</div>)}</div></details>} />}
    {!layout.showHeader && <button className="floating-settings" aria-label={localizeSource(locale, "界面设置")} aria-expanded={rightPanel === 'settings'} onClick={() => { setFocused(false); setPanelOpen(false); setRightPanel(previous => previous === 'settings' ? null : 'settings') }}><LocalText source={"⚙ 界面设置"} /></button>}
    <DocumentSearch open={searchOpen} onOpen={() => setSearchOpen(true)} onClose={() => setSearchOpen(false)} search={searchContent} onSelect={navigateSearch} refreshKey={`${searchVersion}:${selectedRevision ?? 'current'}:${historyLoading}`} />
    <div className="layout editor-layout">
      {layout.showOutline && !focused && <aside className="outline-panel" aria-label={localizeSource(locale, "文档目录")}><div className="panel-head"><h2><LocalText source={"☷ 文档目录"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "隐藏文档目录")} onClick={() => setLayoutOption('showOutline', false)}><CollapseOutlineIcon /></button></div>{visibleOutline.length ? <nav>{visibleOutline.map(item => <button key={item.key} className={`outline-level-${item.level}`} onClick={() => navigateOutline(item)}>{item.text}</button>)}</nav> : <p><LocalText source={historyActive ? historyLoading ? "正在加载历史版本…" : "此版本暂无标题" : "暂无标题。将段落设为标题后会显示在这里。"} /></p>}</aside>}
      {(!layout.showOutline || focused) && <PanelDock side="left" onOpen={() => { setFocused(false); setLayoutOption('showOutline', true) }} />}
      <section className="content-shell" aria-label={localizeSource(locale, '文档内容')}>
        {!focused && <ContentToolbar onSearch={() => setSearchOpen(true)} activeTab={activeTab} onTab={tab => { setActiveTab(tab); if (tab === 'revisions') { setPanelOpen(false); showRightPanel('revisions') } }} expanded={layout.showToolbar} onToggle={() => setLayoutOption('showToolbar', !layout.showToolbar)} readOnly={readOnly || historyActive} format={session.format} />}
    {layout.showToolbar && !focused && !readOnly && !historyActive && <nav className="toolbar ribbon" aria-label={localizeSource(locale, "编辑工具栏")}>
      {session.format !== 'txt' && activeTab === 'home' && <><div className="tool-group"><button onClick={() => editor?.chain().focus().undo().run()} disabled={readOnly || !editor?.can().undo()}><LocalText source={"↶ 撤销"} /></button><button onClick={() => editor?.chain().focus().redo().run()} disabled={readOnly || !editor?.can().redo()}><LocalText source={"↷ 重做"} /></button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().setParagraph().run()} disabled={readOnly}><LocalText source={"正文"} /></button><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={readOnly}><LocalText source={"标题"} /></button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().toggleBold().run()} disabled={readOnly}><LocalText source={"𝐁 加粗"} /></button><button onClick={() => editor?.chain().focus().toggleItalic().run()} disabled={readOnly}><LocalText source={"𝑰 斜体"} /></button><button onClick={openLink} disabled={readOnly}><LocalText source={"链接"} /></button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={readOnly}><LocalText source={"项目符号"} /></button><button onClick={() => editor?.chain().focus().toggleOrderedList().run()} disabled={readOnly}><LocalText source={"编号"} /></button></div><div className="tool-group"><button onClick={() => moveBlock(-1)} disabled={readOnly}><LocalText source={"段落上移"} /></button><button onClick={() => moveBlock(1)} disabled={readOnly}><LocalText source={"段落下移"} /></button></div></>}
      {!['txt', 'md'].includes(session.format) && activeTab === 'home' && <BlockFontPicker editor={editor} faces={themeFaces} disabled={readOnly || historical !== null} />}
      {session.format !== 'txt' && activeTab === 'insert' && <><div className="tool-group"><button onClick={() => editor?.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'text', text: '新段落' }] }).run()} disabled={readOnly}><LocalText source={"＋ 新增段落"} /></button><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={readOnly}><LocalText source={"插入标题"} /></button><button onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={readOnly}><LocalText source={"插入列表"} /></button></div><div className="tool-group"><button onClick={openLink} disabled={readOnly}><LocalText source={"插入链接"} /></button><button onClick={deleteCurrentBlock} disabled={readOnly}><LocalText source={"删除段落"} /></button></div></>}
      {activeTab === 'view' && <><label className="mode"><input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} /><LocalText source={"显示大纲"} /></label><label className="mode"><input type="checkbox" checked={readOnly} disabled={session.scope === 'read'} onChange={event => setReadOnly(event.target.checked)} /><LocalText source={"只读模式"} /></label><button onClick={() => showRightPanel('settings')}><LocalText source={"界面设置"} /></button></>}
      {activeTab === 'revisions' && <><button onClick={() => void save()} disabled={readOnly}><LocalText source={"创建保存点"} /></button><button onClick={() => showRightPanel('revisions')}><LocalText source={"查看修订历史"} /></button><span className="ribbon-note"><LocalText source={"当前版本 r"} />{revision ?? '…'}</span></>}
      {session.format === 'txt' && <div className="tool-group"><button disabled={readOnly || !editor?.can().undo()} onClick={() => editor?.chain().focus().undo().run()}><LocalText source="↶ 撤销" /></button><button disabled={readOnly || !editor?.can().redo()} onClick={() => editor?.chain().focus().redo().run()}><LocalText source="↷ 重做" /></button><button aria-pressed={wrapText} onClick={() => setWrapText(value => !value)}><LocalText source="自动换行" /></button><span className="ribbon-note"><LocalText source="纯文本 · 等宽显示" /></span></div>}
      {activeTab !== 'revisions' && <button className="primary save-trigger" onClick={() => void save()} disabled={readOnly}><LocalText source={"保存点"} /></button>}
    </nav>}
      <CanvasViewport hidden={historyActive}><main className={`document ${session.format === 'txt' && !wrapText ? 'text-no-wrap' : ''}`} onContextMenu={event => {
        event.preventDefault()
        const selection = window.getSelection()
        const selectedAtPoint = selection && selection.rangeCount > 0 && Array.from(selection.getRangeAt(0).getClientRects()).some(rect =>
          event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)
        const selectedText = selectedAtPoint ? selection?.toString() || '' : ''
        if (editor) {
          const point = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
          if (point && !selectedText) editor.commands.setTextSelection(point.pos)
        }
        setMenu({ x: event.clientX, y: event.clientY, selectedText })
      }}>{themeCss && <style>{themeCss}</style>}<EditorContent editor={editor} />{editor && <BubbleMenu editor={editor} shouldShow={({ state }) => session.format !== 'txt' && !historyActive && !readOnly && !searchOpen && !state.selection.empty} className="selection-menu"><button onClick={() => editor.chain().focus().toggleBold().run()} aria-label={localizeSource(locale, "加粗")}>𝐁</button><button onClick={() => editor.chain().focus().toggleItalic().run()} aria-label={localizeSource(locale, "斜体")}>𝑰</button><button onClick={openLink} aria-label={localizeSource(locale, "设置链接")}>🔗</button></BubbleMenu>}</main></CanvasViewport>
      {historyActive && <RevisionWorkspace session={session} selected={selectedRevision} historical={historical} current={comparisonCurrent} comparing={comparing} loading={historyLoading || (comparing && !editorSynced)} error={historyError} metadata={revisionMetadata} canRestore={session.scope === 'write' && selectedRevision < (revision ?? 0)} restoring={restoring} onCompare={setComparing} onReturn={returnToCurrent} onRetry={() => void showRevision(selectedRevision)} onRestore={() => void restoreHistorical()} />}
      </section>
      {panelOpen && !focused && <AgentPanel />}
      {!panelOpen && !focused && rightPanel && <aside className="workspace-sidebar" aria-label={localizeSource(locale, rightPanel === 'settings' ? '界面设置' : '修订历史')}>{rightPanel === 'settings' && <section className="appearance-panel"><div className="panel-head"><h2><LocalText source={"界面设置"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "隐藏右侧栏")} onClick={() => setRightPanel(null)}>×</button></div><LocaleSelect /><label><LocalText source={"显示顶部栏"} /><input type="checkbox" checked={layout.showHeader} onChange={event => setLayoutOption('showHeader', event.target.checked)} /></label><label><LocalText source={"显示操作栏"} /><input type="checkbox" checked={layout.showToolbar} onChange={event => setLayoutOption('showToolbar', event.target.checked)} /></label><label><LocalText source={"显示协作者"} /><input type="checkbox" checked={layout.showCollaborators} onChange={event => setLayoutOption('showCollaborators', event.target.checked)} /></label><label><LocalText source={"显示文档目录"} /><input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} /></label><fieldset><legend><LocalText source={"头部布局"} /></legend><label><input type="radio" name="header-density" checked={layout.compact} onChange={() => setLayoutOption('compact', true)} /><LocalText source={"紧凑"} /></label><label><input type="radio" name="header-density" checked={!layout.compact} onChange={() => setLayoutOption('compact', false)} /><LocalText source={"标准"} /></label></fieldset><button className="open-revisions" onClick={() => showRightPanel('revisions')}><LocalText source={"查看修订历史"} /></button></section>}
        {rightPanel === 'revisions' && <section className="revision-panel"><div className="panel-head"><h2><LocalText source={"◷ 修订历史"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "隐藏右侧栏")} onClick={() => setRightPanel(null)}>×</button></div><p><LocalText source="点击版本，在中央预览或与当前内容对比。" /></p>
        <div className="history">{history.slice().reverse().map(item => <button key={item.revision} data-revision={item.revision} aria-pressed={selectedRevision === item.revision} onClick={() => void showRevision(item.revision)} title={item.patchId}><span className="revision-avatar" title={item.authorName || (localizeSource(locale, item.revision === 0 ? '导入' : '作者未记录'))} style={item.authorId ? { background: presenceColor(item.authorId) } : undefined}>{item.authorName?.slice(0, 1) || (item.revision === 0 ? localizeSource(locale, '导入').slice(0, 1) : '?')}</span><span className="revision-detail"><strong>r{item.revision} <small>{item.createdAtEpochMs ? new Date(item.createdAtEpochMs).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</small></strong><small>{item.authorName || (localizeSource(locale, item.revision === 0 ? '初始导入' : '作者未记录'))} · {localizeSource(locale, item.revision === 0 ? '导入' : item.patchId?.startsWith('restore-') ? '恢复版本' : item.patchId === 'editor-projection' ? '编辑投影' : '内容更新')}</small><span><LocalText source={"查看版本"} /></span></span></button>)}
          {nextBefore !== null && nextBefore !== undefined && <button onClick={() => void loadOlderRevisions()}><LocalText source={"加载更早的修订"} /></button>}
        </div>
        {historyActive && <button className="return-current" onClick={returnToCurrent}><LocalText source="返回当前" /></button>}
        </section>}</aside>}
      {(focused || (!rightPanel && !panelOpen)) && <PanelDock side="right" onOpen={() => { setFocused(false); setPanelOpen(false); showRightPanel('settings') }} onHistory={() => { setFocused(false); setPanelOpen(false); showRightPanel('revisions') }} onAgents={() => { setFocused(false); setPanelOpen(true) }} />}
    </div>
    <EditorStatusbar mode={localizeSource(locale, "连续视图")} format={session.format} revision={selectedRevision ?? revision} readOnly={readOnly || historyActive} status={historyActive ? '历史只读' : status} />
    {menu && <ContextMenu x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} />}
    {linkOpen && <div className="hcd-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setLinkOpen(false) }}><div className="hcd-dialog" role="dialog" aria-modal="true" aria-label={localizeSource(locale, "设置链接")}><h2><LocalText source={"设置链接"} /></h2><label><LocalText source={"链接地址"} /><input autoFocus type="url" value={linkHref} onChange={event => setLinkHref(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') applyLink(); if (event.key === 'Escape') setLinkOpen(false) }} placeholder="https://example.com" /></label><div className="hcd-dialog-actions"><button onClick={() => setLinkOpen(false)}><LocalText source={"取消"} /></button><button className="primary" onClick={applyLink}><LocalText source={"应用链接"} /></button></div></div></div>}
    {error && <ErrorToast message={error} onClose={() => setError('')} />}
  </div>
}
