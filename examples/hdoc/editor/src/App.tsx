import { LocaleSelect, useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { clearPastedBlockIds, jsonToSnapshot, schemaExtensions, type Projection } from './schema.ts'
import { ContextMenu, type MenuAction } from './ContextMenu.tsx'
import { api, type Session } from './api.ts'
import { FixedViewer } from './FixedViewer.tsx'
import { WordFormatTools } from './WordFormatTools.tsx'
import { wordTableView, type WordTableCommand, type WordTableFocus } from './WordTableView.ts'
import { WordTableDialog } from './WordTableDialog.tsx'
import { EditorHeader, EditorStatusbar, type EditorTab } from './EditorChrome.tsx'
import { DocumentSearch, type SearchHit, type SearchResult } from './DocumentSearch.tsx'
import { findSemanticText, SEARCH_RESULT_LIMIT } from './semanticSearch.ts'
import { readLayout, saveLayout, type LayoutPreferences } from './editorLayout.ts'
import { ErrorToast } from './ErrorToast.tsx'
import './style.css'

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
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  const [samples, setSamples] = useState<Array<{ id: string; title: string; format: string; mode: string }>>([])
  const [openingSample, setOpeningSample] = useState<string | null>(null)
  const [importFile, setImportFile] = useState<File | null>(null)
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
      setSession({ ...draft, scope: access.scope, format: metadata.source.format,
        userId: access.userId || undefined, displayName: access.displayName || undefined,
        collaborationEpoch: access.collaborationEpoch })
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
  async function uploadDocument() {
    if (!importFile || !uploadToken.trim()) return
    setError('')
    setUploadState('上传中…')
    try {
      if (!/\.(hcd|csv|tsv)$/i.test(importFile.name)) throw new Error('请选择 HCD、CSV 或 TSV 文件')
      const headers = { Authorization: `Bearer ${uploadToken.trim()}` }
      const response = await fetch(`/v1/import?filename=${encodeURIComponent(importFile.name)}`, {
        method: 'POST', headers, body: importFile,
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
  if (session) return <div className="hcd-surface"><Workspace key={session.documentId} session={session} onClose={() => setSession(null)} onEpochChange={epoch => setSession(previous => previous && ({ ...previous, collaborationEpoch: epoch }))} /></div>
  return <div className="hcd-surface"><main className="login"><div className={`login-card ${samples.length ? 'login-card-with-samples' : ''}`}>
    <div className="eyebrow">OfficeCLI / HCD</div><h1><LocalText source={"文档编辑工作台"} /></h1><LocaleSelect />
    {samples.length > 0 && <section className="acceptance-samples" aria-label={localizeSource(locale, "本地验收文档")}>
      <p><LocalText source={"选择真实文件验收预览、编辑、修订与下载。"} /></p>
      <div className="acceptance-grid">{samples.map(sample => <button key={sample.id} onClick={() => void openSample(sample.id)} disabled={openingSample !== null}>
        <span className="sample-format">{sample.format}</span><strong>{sample.title}</strong><small>{sample.mode}</small><span className="sample-open">{localizeDynamic(locale, openingSample === sample.id ? '打开中…' : '打开文档 →')}</span>
      </button>)}</div>
    </section>}
    <section className="manual-access"><p><LocalText source={"输入文档 ID 和短期访问令牌。只读令牌无法提交修改。"} /></p><label><LocalText source={"文档 ID"} /><input value={documentId} onChange={event => setDocumentId(event.target.value)} placeholder="doc-…" /></label><label><LocalText source={"访问令牌"} /><textarea rows={4} value={token} onChange={event => setToken(event.target.value)} placeholder={localizeSource(locale, "粘贴短期令牌")} /></label><button onClick={() => void open(documentId, token)} disabled={!documentId || !token}><LocalText source={"打开文档"} /></button></section>
    <section className="manual-access portable-import"><p><LocalText source="导入 HCD、CSV 或 TSV。上传令牌用于导入，文档访问令牌用于打开。" /></p><label><LocalText source="选择文件" /><input type="file" accept=".hcd,.csv,.tsv" onChange={event => setImportFile(event.target.files?.[0] ?? null)} /></label><label><LocalText source="上传令牌" /><textarea rows={2} value={uploadToken} onChange={event => setUploadToken(event.target.value)} placeholder={localizeSource(locale, "粘贴短期上传令牌")} /></label><button onClick={() => void uploadDocument()} disabled={!importFile || !uploadToken.trim() || uploadState === '上传中…'}><LocalText source="导入文件" /></button>{uploadState && <p role="status">{localizeDynamic(locale, uploadState)}</p>}</section>
    {error && <p className="error">{localizeDynamic(locale, error)}</p>}
  </div></main></div>
}

export function Workspace({ session, onClose, onEpochChange, embedded = false }: { session: Session; onClose: () => void; onEpochChange?: (epoch: number) => void; embedded?: boolean }) {
  const tableHistory = useRef<TableHistory | null>(null)
  const tableFocus = useRef<WordTableFocus | null>(null)
  const semantic = ['docx', 'html', 'md', 'txt'].includes(session.format)
  if (semantic) return <SemanticEditor key={session.collaborationEpoch ?? 0} session={session} onClose={onClose} onEpochChange={onEpochChange} embedded={embedded} tableHistory={tableHistory} tableFocus={tableFocus} />
  if (['xlsx', 'csv', 'tsv'].includes(session.format)) return <Suspense fallback={<div className="embedded-loading"><LocalText source={"正在加载工作簿…"} /></div>}><UniverViewer session={session} onClose={onClose} embedded={embedded} /></Suspense>
  return <FixedViewer session={session} onClose={onClose} embedded={embedded} />
}

type TableHistory = { head: number; undo: number[]; redo: number[] }

function SemanticEditor({ session, onClose, onEpochChange, embedded, tableHistory, tableFocus }: { session: Session; onClose: () => void; onEpochChange?: (epoch: number) => void; embedded: boolean; tableHistory: MutableRefObject<TableHistory | null>; tableFocus: MutableRefObject<WordTableFocus | null> }) {
  const { locale } = useI18n()
  const [readOnly, setReadOnly] = useState(session.scope === 'read')
  const [status, setStatus] = useState('连接中')
  const [revision, setRevision] = useState<number | null>(null)
  const [history, setHistory] = useState<RevisionItem[]>([])
  const [nextBefore, setNextBefore] = useState<number | null | undefined>(undefined)
  const [historical, setHistorical] = useState<Projection | null>(null)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkHref, setLinkHref] = useState('')
  const [presence, setPresence] = useState<Array<{ id: string; name: string; color: string; connections: number }>>([])
  const [layout, setLayout] = useState<LayoutPreferences>(readLayout)
  const [rightPanel, setRightPanel] = useState<'settings' | 'revisions' | null>('settings')
  const [activeTab, setActiveTab] = useState<EditorTab>('home')
  const [outline, setOutline] = useState<Array<{ pos: number; level: number; text: string }>>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchVersion, setSearchVersion] = useState(0)
  const lastOutline = useRef('')
  const lastSemantic = useRef<string | null>(null)
  const tableMutation = useRef(false)
  const [tablePending, setTablePending] = useState(false)
  const [tableFocused, setTableFocused] = useState(false)
  const [tableTarget, setTableTarget] = useState<{ index: number; blockId: string | null } | null>(null)
  const bodyEditingDisabled = readOnly || !!historical || tablePending || tableFocused
  useEffect(() => { saveLayout(layout) }, [layout])
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
    extensions: [...schemaExtensions.map(extension => session.format === 'docx' && extension.name === 'hcdOpaque'
      ? wordTableView(session, text => localizeSource(locale, text), tableFocus) : extension), Collaboration.configure({ document: ydoc }),
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
    editor?.setEditable(!readOnly && !tablePending)
  }, [editor, readOnly, tablePending])
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
    provider.on('status', connection)
    provider.on('synced', () => setStatus('已同步'))
    provider.on('stateless', saveState)
    provider.awareness?.on('change', refreshPresence)
    refreshPresence()
    return () => { provider.off('status', connection); provider.off('stateless', saveState); provider.awareness?.off('change', refreshPresence); provider.destroy(); ydoc.destroy() }
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
    if (readOnly) return revision
    setStatus('保存中')
    setError('')
    try {
      const blocks = jsonToSnapshot(editor.getJSON())
      const saved = await (await api(session, '/checkpoints', {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          'X-HCD-Collaboration-Epoch': String(session.collaborationEpoch ?? 0) },
        body: JSON.stringify({ expectedRevision: revision, blocks }),
      })).json() as { revision: number; projection: Projection }
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
  async function updateTable(update: (head: number) => Promise<TableHistory | undefined>) {
    if (!editor?.isEditable || readOnly || historical || tableMutation.current) return
    tableMutation.current = true
    setTablePending(true)
    try {
      const head = await save()
      if (head === null) return
      const next = await update(head)
      if (!next) return
      tableHistory.current = next
      setRevision(next.head)
      const access = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
      onEpochChange?.(access.collaborationEpoch)
    } catch (cause) { setError(String(cause)) }
    finally {
      tableMutation.current = false
      setTablePending(false)
    }
  }
  async function applyTablePatch(head: number, operation: Record<string, unknown>) {
    const result = await (await api(session, '/patch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 'hcd-patch/4', documentId: session.documentId, patchId: crypto.randomUUID(),
        baseRevision: head, operations: [operation],
      }),
    })).json() as { revision: number; dirtyNodeIds: string[] }
    if (operation.op !== 'table.edit' && result.dirtyNodeIds.length) {
      tableFocus.current = { nodeId: result.dirtyNodeIds[0], firstCell: operation.op === 'table.insert' }
    }
    const previous = tableHistory.current
    return { head: result.revision, undo: [...(previous?.head === head ? previous.undo : []), head], redo: [] }
  }
  function openTableDialog() {
    if (!editor) return
    const cursor = editor.state.selection.from
    let index = -1
    let blockId: string | null = null
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'bulletList' || node.type.name === 'orderedList') return true
      if (position <= cursor) {
        index++
        blockId = node.attrs.hcdBlockId ?? null
      }
      return false
    })
    setTableTarget({ index, blockId })
  }
  function insertTable(rows: number, columns: number) {
    if (!tableTarget) return
    setTableTarget(null)
    void updateTable(async head => {
      const projection = await (await api(session, `/editor?revision=${head}`)).json() as Projection
      const body = projection.blocks.filter(block => block.region === 'body')
      const afterBlock = tableTarget.blockId
        ? body.find(block => block.blockId === tableTarget.blockId) : body[tableTarget.index]
      if (tableTarget.index >= 0 && !afterBlock) throw new Error(localizeSource(locale, '所选插入位置已变更，请重新选择'))
      return applyTablePatch(head, { op: 'table.insert', rows, columns, afterBlockId: afterBlock?.blockId ?? null })
    })
  }
  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    const edit = (event: Event) => {
      const command = (event as CustomEvent<WordTableCommand>).detail
      void updateTable(async head => {
        const projection = await (await api(session, `/editor?revision=${head}`)).json() as Projection
        const block = projection.blocks.find(candidate => candidate.blockId === command.blockId)
        if (!block?.editableTableLayout) throw new Error(localizeSource(locale, '此表格无法调整行列'))
        return applyTablePatch(head, { ...command, precondition: { blockHash: block.blockHash } })
      })
    }
    dom.addEventListener('hcd-word-table-edit', edit)
    return () => dom.removeEventListener('hcd-word-table-edit', edit)
  })
  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    const focusTable = () => setTableFocused(true)
    const focusBody = () => setTableFocused(false)
    dom.addEventListener('hcd-inline-table-focus', focusTable)
    dom.addEventListener('focusin', focusBody)
    return () => {
      dom.removeEventListener('hcd-inline-table-focus', focusTable)
      dom.removeEventListener('focusin', focusBody)
    }
  }, [editor])
  function canStep(direction: 'undo' | 'redo') {
    const steps = tableHistory.current
    return !readOnly && !historical && !tablePending
      && (!!editor?.can()[direction]() || (steps?.head === revision && steps[direction].length > 0))
  }
  function step(direction: 'undo' | 'redo') {
    if (!canStep(direction)) return
    if (editor?.can()[direction]()) {
      editor.chain().focus()[direction]().run()
      return
    }
    void updateTable(async head => {
      const steps = tableHistory.current
      if (!steps || steps.head !== head) return
      const target = steps[direction].at(-1)
      if (target === undefined) return
      const result = await (await api(session, `/restore/${target}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: head }),
      })).json() as { revision: number }
      return direction === 'undo'
        ? { head: result.revision, undo: steps.undo.slice(0, -1), redo: [...steps.redo, head] }
        : { head: result.revision, undo: [...steps.undo, head], redo: steps.redo.slice(0, -1) }
    })
  }
  async function showRevision(number: number) {
    try { setHistorical(await (await api(session, `/editor?revision=${number}`)).json() as Projection) }
    catch (cause) { setError(String(cause)) }
  }
  async function restoreHistorical() {
    if (!historical || readOnly) return
    const head = await save()
    if (head === null || historical.revision >= head) return
    try {
      await api(session, `/restore/${historical.revision}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: head }) })
      const access = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
      onEpochChange?.(access.collaborationEpoch)
    } catch (cause) { setError(String(cause)) }
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
    const hits = editor ? findSemanticText(editor.state.doc, query) : []
    return { revision: revision ?? 0, hits: hits.slice(0, SEARCH_RESULT_LIMIT), truncated: hits.length > SEARCH_RESULT_LIMIT }
  }
  function replaceContent(query: string, replacement: string, hit?: SearchHit): number {
    if (!editor?.isEditable || readOnly || historical) return 0
    const { doc, schema, tr } = editor.state
    const matches = findSemanticText(doc, query)
    const targets = hit ? matches.filter(match => match.position === hit.position && match.matchLength === hit.matchLength) : matches
    if (!hit && targets.length > SEARCH_RESULT_LIMIT) throw new Error('匹配项过多，请缩小关键词范围。')
    if (hit && !targets.length) throw new Error('内容已变化，请重新选择搜索结果。')
    let count = 0
    for (const target of targets.reverse()) {
      const from = target.position!
      const to = from + target.matchLength!
      if (doc.textBetween(from, to) === replacement) continue
      // Keep the marks common to all replaced characters, including shared links.
      let marks = doc.resolve(from).nodeAfter?.marks.slice() || []
      doc.nodesBetween(from, to, node => {
        if (node.isText) marks = marks.filter(mark => mark.isInSet(node.marks))
      })
      if (replacement) tr.replaceWith(from, to, schema.text(replacement, marks))
      else tr.delete(from, to)
      count += 1
    }
    if (tr.docChanged) {
      const undo = yUndoPluginKey.getState(editor.state)?.undoManager
      undo?.stopCapturing()
      editor.view.dispatch(tr)
      undo?.stopCapturing()
    }
    return count
  }
  function navigateSearch(hit: SearchHit) {
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
    { label: '撤销', disabled: !canStep('undo'), separated: true, action: () => step('undo') },
    { label: '重做', disabled: !canStep('redo'), action: () => step('redo') },
  ]
  return <div className={`workspace semantic-workspace ${embedded ? 'embedded' : ''} ${layout.compact ? 'compact-header' : ''} ${layout.showOutline ? '' : 'outline-hidden'} ${rightPanel ? '' : 'right-hidden'}`}>
    {layout.showHeader && <EditorHeader session={session} revision={revision} status={status} activeTab={activeTab}
      onTab={tab => { setActiveTab(tab); if (tab === 'revisions') setRightPanel('revisions') }} onClose={onClose}
      onSettings={() => setRightPanel(previous => previous === 'settings' ? null : 'settings')} onSearch={() => setSearchOpen(true)} settingsOpen={rightPanel === 'settings'} beforeExport={save}
      presence={layout.showCollaborators && <details className="presence"><summary aria-label={`${localizeSource(locale, "在线协作者")} · ${presence.length}`}><span className="presence-avatars">{presence.slice(0, 3).map(user => <span key={user.id} className="avatar" title={user.name} style={{ background: user.color }}>{user.name.slice(0, 1)}</span>)}</span><span>{presence.length} <LocalText source={" 人在线"} /></span></summary><div className="presence-menu"><strong><LocalText source={"在线协作者"} /></strong>{presence.map(user => <div key={user.id} className="presence-person"><span className="avatar" style={{ background: user.color }}>{user.name.slice(0, 1)}</span><span>{user.name}{user.id === localUser.id ? localizeSource(locale, '（你）') : ''}</span>{user.connections > 1 && <small>{user.connections} <LocalText source={" 个窗口"} /></small>}</div>)}</div></details>} />}
    {!layout.showHeader && <button className="floating-settings" aria-label={localizeSource(locale, "界面设置")} aria-expanded={rightPanel === 'settings'} onClick={() => setRightPanel(previous => previous === 'settings' ? null : 'settings')}><LocalText source={"⚙ 界面设置"} /></button>}
    <DocumentSearch open={searchOpen} onOpen={() => setSearchOpen(true)} onClose={() => setSearchOpen(false)} search={searchContent} onSelect={navigateSearch} onReplace={readOnly || historical ? undefined : replaceContent} refreshKey={searchVersion} />
    {layout.showToolbar && <nav className="toolbar ribbon" aria-label={localizeSource(locale, "编辑工具栏")}>
      {activeTab === 'home' && <><div className="tool-group"><button onClick={() => step('undo')} disabled={!canStep('undo')}><LocalText source={"↶ 撤销"} /></button><button onClick={() => step('redo')} disabled={!canStep('redo')}><LocalText source={"↷ 重做"} /></button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().setParagraph().run()} disabled={bodyEditingDisabled}><LocalText source={"正文"} /></button><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={bodyEditingDisabled}><LocalText source={"标题"} /></button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().toggleBold().run()} disabled={bodyEditingDisabled}><LocalText source={"𝐁 加粗"} /></button><button onClick={() => editor?.chain().focus().toggleItalic().run()} disabled={bodyEditingDisabled}><LocalText source={"𝑰 斜体"} /></button><button onClick={openLink} disabled={bodyEditingDisabled}><LocalText source={"链接"} /></button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={bodyEditingDisabled}><LocalText source={"项目符号"} /></button><button onClick={() => editor?.chain().focus().toggleOrderedList().run()} disabled={bodyEditingDisabled}><LocalText source={"编号"} /></button></div><div className="tool-group"><button onClick={() => moveBlock(-1)} disabled={bodyEditingDisabled}><LocalText source={"段落上移"} /></button><button onClick={() => moveBlock(1)} disabled={bodyEditingDisabled}><LocalText source={"段落下移"} /></button></div></>}
      {activeTab === 'home' && session.format === 'docx' && <WordFormatTools editor={editor} readOnly={bodyEditingDisabled} />}
      {activeTab === 'insert' && <><div className="tool-group"><button onClick={() => editor?.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'text', text: '新段落' }] }).run()} disabled={bodyEditingDisabled}><LocalText source={"＋ 新增段落"} /></button><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={bodyEditingDisabled}><LocalText source={"插入标题"} /></button><button onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={bodyEditingDisabled}><LocalText source={"插入列表"} /></button></div><div className="tool-group"><button onClick={openLink} disabled={bodyEditingDisabled}><LocalText source={"插入链接"} /></button><button onClick={deleteCurrentBlock} disabled={bodyEditingDisabled}><LocalText source={"删除段落"} /></button></div></>}
      {activeTab === 'view' && <><label className="mode"><input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} /><LocalText source={"显示大纲"} /></label><label className="mode"><input type="checkbox" checked={readOnly} disabled={session.scope === 'read'} onChange={event => setReadOnly(event.target.checked)} /><LocalText source={"只读模式"} /></label><button onClick={() => setRightPanel('settings')}><LocalText source={"界面设置"} /></button></>}
      {activeTab === 'revisions' && <><button onClick={() => void save()} disabled={readOnly}><LocalText source={"创建保存点"} /></button><button onClick={() => setRightPanel('revisions')}><LocalText source={"查看修订历史"} /></button><span className="ribbon-note"><LocalText source={"当前版本 r"} />{revision ?? '…'}</span></>}
      {activeTab === 'insert' && session.format === 'docx' && <button onClick={openTableDialog} disabled={!editor || bodyEditingDisabled}><LocalText source="插入表格" /></button>}
      {activeTab !== 'revisions' && <button className="primary save-trigger" onClick={() => void save()} disabled={readOnly}><LocalText source={"保存点"} /></button>}
    </nav>}
    <div className="layout editor-layout">
      {layout.showOutline && <aside className="outline-panel" aria-label={localizeSource(locale, "文档目录")}><div className="panel-head"><h2><LocalText source={"☷ 文档目录"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "隐藏文档目录")} onClick={() => setLayoutOption('showOutline', false)}>×</button></div>{outline.length ? <nav>{outline.map(item => <button key={item.pos} className={`outline-level-${item.level}`} onClick={() => { editor?.commands.focus(); editor?.commands.setTextSelection(item.pos + 1); editor?.view.domAtPos(item.pos + 1).node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }}>{item.text}</button>)}</nav> : <p><LocalText source={"暂无标题。将段落设为标题后会显示在这里。"} /></p>}</aside>}
      <div className="document-scroll"><main className="document" onContextMenu={event => {
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
      }}><EditorContent editor={editor} />{editor && <BubbleMenu editor={editor} shouldShow={({ state }) => !readOnly && !searchOpen && !state.selection.empty} className="selection-menu"><button onClick={() => editor.chain().focus().toggleBold().run()} aria-label={localizeSource(locale, "加粗")}>𝐁</button><button onClick={() => editor.chain().focus().toggleItalic().run()} aria-label={localizeSource(locale, "斜体")}>𝑰</button><button onClick={openLink} aria-label={localizeSource(locale, "设置链接")}>🔗</button></BubbleMenu>}</main></div>
      {rightPanel && <aside className="workspace-sidebar" aria-label={localizeSource(locale, rightPanel === 'settings' ? '界面设置' : '修订历史')}>{rightPanel === 'settings' && <section className="appearance-panel"><div className="panel-head"><h2><LocalText source={"界面设置"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "隐藏右侧栏")} onClick={() => setRightPanel(null)}>×</button></div><LocaleSelect /><label><LocalText source={"显示顶部栏"} /><input type="checkbox" checked={layout.showHeader} onChange={event => setLayoutOption('showHeader', event.target.checked)} /></label><label><LocalText source={"显示操作栏"} /><input type="checkbox" checked={layout.showToolbar} onChange={event => setLayoutOption('showToolbar', event.target.checked)} /></label><label><LocalText source={"显示协作者"} /><input type="checkbox" checked={layout.showCollaborators} onChange={event => setLayoutOption('showCollaborators', event.target.checked)} /></label><label><LocalText source={"显示文档目录"} /><input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} /></label><fieldset><legend><LocalText source={"头部布局"} /></legend><label><input type="radio" name="header-density" checked={layout.compact} onChange={() => setLayoutOption('compact', true)} /><LocalText source={"紧凑"} /></label><label><input type="radio" name="header-density" checked={!layout.compact} onChange={() => setLayoutOption('compact', false)} /><LocalText source={"标准"} /></label></fieldset><button className="open-revisions" onClick={() => setRightPanel('revisions')}><LocalText source={"查看修订历史"} /></button></section>}
        {rightPanel === 'revisions' && <section className="revision-panel"><div className="panel-head"><h2><LocalText source={"◷ 修订历史"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "隐藏右侧栏")} onClick={() => setRightPanel(null)}>×</button></div><p><LocalText source={"原文修改可选保留源 DOCX，改动结构后可重建可编辑 DOCX。"} /></p>
        <div className="history">{history.slice().reverse().map(item => <button key={item.revision} onClick={() => void showRevision(item.revision)} title={item.patchId}><span className="revision-avatar" title={item.authorName || (localizeSource(locale, item.revision === 0 ? '导入' : '作者未记录'))} style={item.authorId ? { background: presenceColor(item.authorId) } : undefined}>{item.authorName?.slice(0, 1) || (item.revision === 0 ? localizeSource(locale, '导入').slice(0, 1) : '?')}</span><span className="revision-detail"><strong>r{item.revision} <small>{item.createdAtEpochMs ? new Date(item.createdAtEpochMs).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</small></strong><small>{item.authorName || (localizeSource(locale, item.revision === 0 ? '初始导入' : '作者未记录'))} · {localizeSource(locale, item.revision === 0 ? '导入' : item.patchId?.startsWith('restore-') ? '恢复版本' : item.patchId === 'editor-projection' ? '编辑投影' : '内容更新')}</small><span><LocalText source={"查看版本"} /></span></span></button>)}
          {nextBefore !== null && nextBefore !== undefined && <button onClick={() => void loadOlderRevisions()}><LocalText source={"加载更早的修订"} /></button>}
        </div>
        {historical && <section className="revision-view"><div className="panel-head"><strong>r{historical.revision} <LocalText source={" 内容"} /></strong><button onClick={() => setHistorical(null)}><LocalText source={"关闭"} /></button></div><div>{historical.blocks.filter(block => block.region === 'body').map(block => <p key={block.blockId}>{block.content.inlines.map(item => item.text).join('')}</p>)}</div><button disabled={readOnly || historical.revision >= (revision ?? 0)} onClick={() => void restoreHistorical()}><LocalText source={"恢复为此版本"} /></button></section>}
        </section>}</aside>}
    </div>
    <EditorStatusbar mode={localizeSource(locale, "连续视图")} format={session.format} revision={revision} readOnly={readOnly} status={status} />
    {menu && <ContextMenu x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} />}
    {linkOpen && <div className="hcd-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setLinkOpen(false) }}><div className="hcd-dialog" role="dialog" aria-modal="true" aria-label={localizeSource(locale, "设置链接")}><h2><LocalText source={"设置链接"} /></h2><label><LocalText source={"链接地址"} /><input autoFocus type="url" value={linkHref} onChange={event => setLinkHref(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') applyLink(); if (event.key === 'Escape') setLinkOpen(false) }} placeholder="https://example.com" /></label><div className="hcd-dialog-actions"><button onClick={() => setLinkOpen(false)}><LocalText source={"取消"} /></button><button className="primary" onClick={applyLink}><LocalText source={"应用链接"} /></button></div></div></div>}
    {error && <ErrorToast message={error} onClose={() => setError('')} />}
    {tableTarget && <WordTableDialog onCancel={() => setTableTarget(null)} onInsert={insertTable} />}
  </div>
}
