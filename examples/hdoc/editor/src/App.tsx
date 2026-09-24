import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { jsonToSnapshot, schemaExtensions, type Projection } from './schema.ts'
import { ContextMenu, type MenuAction } from './ContextMenu.tsx'
import { api, type Session } from './api.ts'
import { FixedViewer } from './FixedViewer.tsx'
import { ExportControl } from './ExportControl.tsx'
import './style.css'

const UniverViewer = lazy(() => import('./UniverViewer.tsx').then(module => ({ default: module.UniverViewer })))

const palette = ['#d84a54', '#3478c0', '#9a5abb', '#13866a', '#d17d20', '#7b65d8']
function presenceColor(id: string) {
  let value = 0
  for (const character of id) value = (value * 31 + character.charCodeAt(0)) >>> 0
  return palette[value % palette.length]
}

export function App() {
  const [documentId, setDocumentId] = useState(sessionStorage.getItem('hcd-document') || '')
  const [token, setToken] = useState(sessionStorage.getItem('hcd-token') || '')
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  async function open() {
    setError('')
    try {
      const draft: Session = { documentId: documentId.trim(), token: token.trim(), scope: 'read', format: '' }
      const [auth, manifest] = await Promise.all([api(draft, '/auth'), api(draft, '')])
      const access = await auth.json() as { scope: 'read' | 'write'; userId?: string; displayName?: string; collaborationEpoch: number }
      const metadata = await manifest.json() as { source: { format: string } }
      sessionStorage.setItem('hcd-document', draft.documentId)
      sessionStorage.setItem('hcd-token', draft.token)
      setSession({ ...draft, scope: access.scope, format: metadata.source.format,
        userId: access.userId || undefined, displayName: access.displayName || undefined,
        collaborationEpoch: access.collaborationEpoch })
    } catch (cause) { setError(String(cause)) }
  }
  if (session) return <div className="hcd-surface"><Workspace key={`${session.documentId}:${session.collaborationEpoch ?? 0}`} session={session} onClose={() => setSession(null)} onEpochChange={epoch => setSession(previous => previous && ({ ...previous, collaborationEpoch: epoch }))} /></div>
  return <div className="hcd-surface"><main className="login"><div className="login-card"><div className="eyebrow">OfficeCLI / HCD</div><h1>文档编辑工作台</h1><p>输入文档 ID 和短期访问令牌。只读令牌无法提交修改。</p><label>文档 ID<input value={documentId} onChange={event => setDocumentId(event.target.value)} placeholder="doc-…" /></label><label>访问令牌<textarea rows={4} value={token} onChange={event => setToken(event.target.value)} placeholder="粘贴短期令牌" /></label><button onClick={() => void open()} disabled={!documentId || !token}>打开文档</button>{error && <p className="error">{error}</p>}</div></main></div>
}

export function Workspace({ session, onClose, onEpochChange, embedded = false }: { session: Session; onClose: () => void; onEpochChange?: (epoch: number) => void; embedded?: boolean }) {
  const semantic = ['docx', 'html', 'md', 'txt'].includes(session.format)
  if (semantic) return <SemanticEditor session={session} onClose={onClose} onEpochChange={onEpochChange} embedded={embedded} />
  if (session.format === 'xlsx') return <Suspense fallback={<div className="embedded-loading">正在加载工作簿…</div>}><UniverViewer session={session} onClose={onClose} embedded={embedded} /></Suspense>
  return <FixedViewer session={session} onClose={onClose} embedded={embedded} />
}

function SemanticEditor({ session, onClose, onEpochChange, embedded }: { session: Session; onClose: () => void; onEpochChange?: (epoch: number) => void; embedded: boolean }) {
  const [readOnly, setReadOnly] = useState(session.scope === 'read')
  const [status, setStatus] = useState('连接中')
  const [revision, setRevision] = useState<number | null>(null)
  const [history, setHistory] = useState<Array<{ revision: number; patchId?: string }>>([])
  const [nextBefore, setNextBefore] = useState<number | null | undefined>(undefined)
  const [historical, setHistorical] = useState<Projection | null>(null)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [presence, setPresence] = useState<Array<{ name: string; color: string }>>([])
  const localUser = useMemo(() => {
    const id = session.userId || crypto.randomUUID()
    return { name: session.displayName || `协作者 ${id.slice(0, 4)}`, color: presenceColor(id) }
  }, [session.userId, session.displayName])
  const ydoc = useMemo(() => new Y.Doc(), [session.documentId])
  const provider = useMemo(() => new HocuspocusProvider({
    url: session.collabUrl || import.meta.env.VITE_HCD_COLLAB_URL || 'ws://127.0.0.1:8768',
    name: `${session.documentId}:${session.collaborationEpoch ?? 0}`,
    document: ydoc,
    token: session.token,
  }), [session.documentId, session.collaborationEpoch, session.token, ydoc])
  const editor = useEditor({
    extensions: [...schemaExtensions, Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider, user: localUser })],
    editable: !readOnly,
    editorProps: { attributes: { class: 'hcd-editor-body' } },
    onUpdate: () => { if (!readOnly) setStatus('编辑中') },
  }, [ydoc])
  useEffect(() => {
    editor?.setEditable(!readOnly)
  }, [editor, readOnly])
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
    const refreshPresence = () => setPresence(Array.from(provider.awareness?.getStates().values() || [])
      .map(value => value.user as { name?: string; color?: string } | undefined)
      .filter((value): value is { name: string; color: string } => Boolean(value?.name && value?.color)))
    provider.on('status', connection)
    provider.on('synced', () => setStatus('已同步'))
    provider.on('stateless', saveState)
    provider.awareness?.on('change', refreshPresence)
    refreshPresence()
    return () => { provider.off('status', connection); provider.off('stateless', saveState); provider.awareness?.off('change', refreshPresence); provider.destroy(); ydoc.destroy() }
  }, [provider, ydoc])
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
        const result = await revisionResponse.json() as { headRevision: number; revisions: Array<{ revision: number; patchId?: string }>; nextBefore: number | null }
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
        revisions: Array<{ revision: number; patchId?: string }>; nextBefore: number | null
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
  const actions: MenuAction[] = [
    { label: '复制选中内容', action: () => { if (editor) void navigator.clipboard.writeText(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, '\n')) } },
    { label: '粘贴文本', disabled: readOnly, action: () => { if (editor) void navigator.clipboard.readText().then(text => editor.chain().focus().insertContent(text).run()).catch(cause => setError(String(cause))) } },
    { label: '新增段落', disabled: readOnly, separated: true, action: () => editor?.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'text', text: '新段落' }] }).run() },
    { label: '删除段落', disabled: readOnly, action: deleteCurrentBlock },
    { label: '设为标题', disabled: readOnly, action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: '设为列表', disabled: readOnly, action: () => editor?.chain().focus().toggleBulletList().run() },
    { label: '加粗', disabled: readOnly, separated: true, action: () => editor?.chain().focus().toggleBold().run() },
    { label: '斜体', disabled: readOnly, action: () => editor?.chain().focus().toggleItalic().run() },
    { label: '上移段落', disabled: readOnly, separated: true, action: () => moveBlock(-1) },
    { label: '下移段落', disabled: readOnly, action: () => moveBlock(1) },
  ]
  return <div className={`workspace ${embedded ? 'embedded' : ''}`}>
    <header>
      <div><span className="eyebrow">OfficeCLI / HCD / {session.format.toUpperCase()}</span><h1>协作编辑器</h1><small>{session.documentId} · revision {revision ?? '…'}</small></div>
      <div className="header-actions">
        <div className="presence" aria-label="在线协作者">{presence.map((user, index) => <span key={`${user.name}-${index}`} className="avatar" title={user.name} style={{ background: user.color }}>{user.name.slice(0, 1)}</span>)}<span>{presence.length} 人在线</span></div>
        <span className="status">{status}</span><ExportControl session={session} revision={revision} beforeExport={save} /><button className="ghost" onClick={onClose}>关闭</button>
      </div>
    </header>
    <nav className="toolbar" aria-label="编辑工具栏">
      <div className="tool-group"><button onClick={() => editor?.chain().focus().toggleBold().run()} disabled={readOnly}>加粗</button><button onClick={() => editor?.chain().focus().toggleItalic().run()} disabled={readOnly}>斜体</button></div>
      <div className="tool-group"><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={readOnly}>标题</button><button onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={readOnly}>列表</button></div>
      <div className="tool-group"><button onClick={() => editor?.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'text', text: '新段落' }] }).run()} disabled={readOnly}>新增段落</button><button onClick={deleteCurrentBlock} disabled={readOnly}>删除段落</button><button onClick={() => moveBlock(-1)} disabled={readOnly}>上移</button><button onClick={() => moveBlock(1)} disabled={readOnly}>下移</button></div>
      <button className="primary" onClick={() => void save()} disabled={readOnly}>保存点</button>
      <label className="mode"><input type="checkbox" checked={readOnly} disabled={session.scope === 'read'} onChange={event => setReadOnly(event.target.checked)} />只读</label>
    </nav>
    <div className="layout">
      <main className="document" onContextMenu={event => {
        event.preventDefault()
        if (editor) {
          const point = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
          if (point) editor.commands.setTextSelection(point.pos)
        }
        setMenu({ x: event.clientX, y: event.clientY })
      }}><EditorContent editor={editor} /></main>
      <aside><h2>修订历史</h2><p>结构编辑后导出 DOCX 将重建语义版式。</p>
        <div className="history">{history.slice().reverse().map(item => <button key={item.revision} onClick={() => void showRevision(item.revision)}><strong>r{item.revision}</strong><span>{item.patchId || '导入'}</span></button>)}
          {nextBefore !== null && nextBefore !== undefined && <button onClick={() => void loadOlderRevisions()}>加载更早的修订</button>}
        </div>
        {historical && <section className="revision-view"><div className="panel-head"><strong>r{historical.revision} 内容</strong><button onClick={() => setHistorical(null)}>关闭</button></div><div>{historical.blocks.filter(block => block.region === 'body').map(block => <p key={block.blockId}>{block.content.inlines.map(item => item.text).join('')}</p>)}</div><button disabled={readOnly || historical.revision >= (revision ?? 0)} onClick={() => void restoreHistorical()}>恢复为此版本</button></section>}
      </aside>
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} />}
    {error && <div className="toast error">{error}</div>}
  </div>
}
