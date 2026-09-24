import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
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
type LayoutPreferences = { showHeader: boolean; showToolbar: boolean; showCollaborators: boolean; showOutline: boolean; compact: boolean }
type RevisionItem = { revision: number; patchId?: string; authorId?: string; authorName?: string; createdAtEpochMs?: number }
const defaultLayout: LayoutPreferences = { showHeader: true, showToolbar: true, showCollaborators: true, showOutline: true, compact: true }
const layoutKey = 'hcd-editor-layout-v1'
function readLayout(): LayoutPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey) || '{}') as Partial<LayoutPreferences>
    return Object.fromEntries(Object.entries(defaultLayout).map(([key, fallback]) =>
      [key, typeof saved[key as keyof LayoutPreferences] === 'boolean' ? saved[key as keyof LayoutPreferences] : fallback])) as LayoutPreferences
  } catch { return defaultLayout }
}
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
  const [history, setHistory] = useState<RevisionItem[]>([])
  const [nextBefore, setNextBefore] = useState<number | null | undefined>(undefined)
  const [historical, setHistorical] = useState<Projection | null>(null)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkHref, setLinkHref] = useState('')
  const [presence, setPresence] = useState<Array<{ name: string; color: string }>>([])
  const [layout, setLayout] = useState<LayoutPreferences>(readLayout)
  const [rightPanel, setRightPanel] = useState<'settings' | 'revisions' | null>('settings')
  const [activeTab, setActiveTab] = useState<'home' | 'insert' | 'view' | 'revisions'>('home')
  const [outline, setOutline] = useState<Array<{ pos: number; level: number; text: string }>>([])
  const lastOutline = useRef('')
  const lastSemantic = useRef<string | null>(null)
  useEffect(() => { localStorage.setItem(layoutKey, JSON.stringify(layout)) }, [layout])
  function setLayoutOption(key: keyof LayoutPreferences, value: boolean) {
    setLayout(previous => ({ ...previous, [key]: value }))
  }
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
    onUpdate: ({ editor: changedEditor }) => {
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
  return <div className={`workspace semantic-workspace ${embedded ? 'embedded' : ''} ${layout.compact ? 'compact-header' : ''} ${layout.showOutline ? '' : 'outline-hidden'} ${rightPanel ? '' : 'right-hidden'}`}>
    {layout.showHeader && <header className="editor-header">
      <div className="document-identity"><span className="brand">HCD</span><div className="document-title"><strong title={session.documentId}>{session.documentId}</strong><small>{session.format.toUpperCase()} · r{revision ?? '…'}</small></div><span className="status" role="status">{status}</span></div>
      <nav className="header-tabs" aria-label="编辑功能"><button className={activeTab === 'home' ? 'active' : ''} onClick={() => setActiveTab('home')}>开始</button><button className={activeTab === 'insert' ? 'active' : ''} onClick={() => setActiveTab('insert')}>插入</button><button className={activeTab === 'view' ? 'active' : ''} onClick={() => setActiveTab('view')}>视图</button><button className={activeTab === 'revisions' ? 'active' : ''} onClick={() => { setActiveTab('revisions'); setRightPanel('revisions') }}>修订</button></nav>
      <div className="header-actions">
        {layout.showCollaborators && <div className="presence" aria-label="在线协作者">{presence.map((user, index) => <span key={`${user.name}-${index}`} className="avatar" title={user.name} style={{ background: user.color }}>{user.name.slice(0, 1)}</span>)}<span>{presence.length} 人在线</span></div>}
        <ExportControl session={session} revision={revision} beforeExport={save} /><button className="settings-trigger" aria-label="界面设置" aria-expanded={rightPanel === 'settings'} onClick={() => setRightPanel(previous => previous === 'settings' ? null : 'settings')}>⚙</button><button className="ghost" onClick={onClose}>关闭</button>
      </div>
    </header>}
    {!layout.showHeader && <button className="floating-settings" aria-label="界面设置" aria-expanded={rightPanel === 'settings'} onClick={() => setRightPanel(previous => previous === 'settings' ? null : 'settings')}>⚙ 界面设置</button>}
    {layout.showToolbar && <nav className="toolbar ribbon" aria-label="编辑工具栏">
      {activeTab === 'home' && <><div className="tool-group"><button onClick={() => editor?.chain().focus().undo().run()} disabled={readOnly || !editor?.can().undo()}>↶ 撤销</button><button onClick={() => editor?.chain().focus().redo().run()} disabled={readOnly || !editor?.can().redo()}>↷ 重做</button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().setParagraph().run()} disabled={readOnly}>正文</button><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={readOnly}>标题</button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().toggleBold().run()} disabled={readOnly}>𝐁 加粗</button><button onClick={() => editor?.chain().focus().toggleItalic().run()} disabled={readOnly}>𝑰 斜体</button><button onClick={openLink} disabled={readOnly}>链接</button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={readOnly}>项目符号</button><button onClick={() => editor?.chain().focus().toggleOrderedList().run()} disabled={readOnly}>编号</button></div><div className="tool-group"><button onClick={() => moveBlock(-1)} disabled={readOnly}>段落上移</button><button onClick={() => moveBlock(1)} disabled={readOnly}>段落下移</button></div></>}
      {activeTab === 'insert' && <><div className="tool-group"><button onClick={() => editor?.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'text', text: '新段落' }] }).run()} disabled={readOnly}>＋ 新增段落</button><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={readOnly}>插入标题</button><button onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={readOnly}>插入列表</button></div><div className="tool-group"><button onClick={openLink} disabled={readOnly}>插入链接</button><button onClick={deleteCurrentBlock} disabled={readOnly}>删除段落</button></div></>}
      {activeTab === 'view' && <><label className="mode"><input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} />显示大纲</label><label className="mode"><input type="checkbox" checked={readOnly} disabled={session.scope === 'read'} onChange={event => setReadOnly(event.target.checked)} />只读模式</label><button onClick={() => setRightPanel('settings')}>界面设置</button></>}
      {activeTab === 'revisions' && <><button onClick={() => void save()} disabled={readOnly}>创建保存点</button><button onClick={() => setRightPanel('revisions')}>查看修订历史</button><span className="ribbon-note">当前版本 r{revision ?? '…'}</span></>}
      {activeTab !== 'revisions' && <button className="primary save-trigger" onClick={() => void save()} disabled={readOnly}>保存点</button>}
    </nav>}
    <div className="layout editor-layout">
      {layout.showOutline && <aside className="outline-panel" aria-label="文档目录"><div className="panel-head"><h2>☷ 文档目录</h2><button className="panel-close" aria-label="隐藏文档目录" onClick={() => setLayoutOption('showOutline', false)}>×</button></div>{outline.length ? <nav>{outline.map(item => <button key={item.pos} className={`outline-level-${item.level}`} onClick={() => { editor?.commands.focus(); editor?.commands.setTextSelection(item.pos + 1); editor?.view.domAtPos(item.pos + 1).node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }}>{item.text}</button>)}</nav> : <p>暂无标题。将段落设为标题后会显示在这里。</p>}</aside>}
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
      }}><EditorContent editor={editor} />{editor && <BubbleMenu editor={editor} shouldShow={({ state }) => !readOnly && !state.selection.empty} className="selection-menu"><button onClick={() => editor.chain().focus().toggleBold().run()} aria-label="加粗">𝐁</button><button onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="斜体">𝑰</button><button onClick={openLink} aria-label="设置链接">🔗</button></BubbleMenu>}</main></div>
      {rightPanel && <aside className="workspace-sidebar" aria-label={rightPanel === 'settings' ? '界面设置' : '修订历史'}>{rightPanel === 'settings' && <section className="appearance-panel"><div className="panel-head"><h2>界面设置</h2><button className="panel-close" aria-label="隐藏右侧栏" onClick={() => setRightPanel(null)}>×</button></div><label>显示顶部栏<input type="checkbox" checked={layout.showHeader} onChange={event => setLayoutOption('showHeader', event.target.checked)} /></label><label>显示操作栏<input type="checkbox" checked={layout.showToolbar} onChange={event => setLayoutOption('showToolbar', event.target.checked)} /></label><label>显示协作者<input type="checkbox" checked={layout.showCollaborators} onChange={event => setLayoutOption('showCollaborators', event.target.checked)} /></label><label>显示文档目录<input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} /></label><fieldset><legend>头部布局</legend><label><input type="radio" name="header-density" checked={layout.compact} onChange={() => setLayoutOption('compact', true)} />紧凑</label><label><input type="radio" name="header-density" checked={!layout.compact} onChange={() => setLayoutOption('compact', false)} />标准</label></fieldset><button className="open-revisions" onClick={() => setRightPanel('revisions')}>查看修订历史</button></section>}
        {rightPanel === 'revisions' && <section className="revision-panel"><div className="panel-head"><h2>◷ 修订历史</h2><button className="panel-close" aria-label="隐藏右侧栏" onClick={() => setRightPanel(null)}>×</button></div><p>结构编辑后导出 DOCX 将重建语义版式。</p>
        <div className="history">{history.slice().reverse().map(item => <button key={item.revision} onClick={() => void showRevision(item.revision)} title={item.patchId}><span className="revision-avatar" title={item.authorName || (item.revision === 0 ? '导入' : '作者未记录')} style={item.authorId ? { background: presenceColor(item.authorId) } : undefined}>{item.authorName?.slice(0, 1) || (item.revision === 0 ? '导' : '?')}</span><span className="revision-detail"><strong>r{item.revision} <small>{item.createdAtEpochMs ? new Date(item.createdAtEpochMs).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</small></strong><small>{item.authorName || (item.revision === 0 ? '初始导入' : '作者未记录')} · {item.revision === 0 ? '导入' : item.patchId?.startsWith('restore-') ? '恢复版本' : item.patchId === 'editor-projection' ? '编辑投影' : '内容更新'}</small><span>查看版本</span></span></button>)}
          {nextBefore !== null && nextBefore !== undefined && <button onClick={() => void loadOlderRevisions()}>加载更早的修订</button>}
        </div>
        {historical && <section className="revision-view"><div className="panel-head"><strong>r{historical.revision} 内容</strong><button onClick={() => setHistorical(null)}>关闭</button></div><div>{historical.blocks.filter(block => block.region === 'body').map(block => <p key={block.blockId}>{block.content.inlines.map(item => item.text).join('')}</p>)}</div><button disabled={readOnly || historical.revision >= (revision ?? 0)} onClick={() => void restoreHistorical()}>恢复为此版本</button></section>}
        </section>}</aside>}
    </div>
    <footer className="editor-statusbar"><span>连续视图 · {session.format.toUpperCase()}</span><span>r{revision ?? '…'} · {readOnly ? '只读' : '可编辑'} · {status}</span></footer>
    {menu && <ContextMenu x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} />}
    {linkOpen && <div className="hcd-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setLinkOpen(false) }}><div className="hcd-dialog" role="dialog" aria-modal="true" aria-label="设置链接"><h2>设置链接</h2><label>链接地址<input autoFocus type="url" value={linkHref} onChange={event => setLinkHref(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') applyLink(); if (event.key === 'Escape') setLinkOpen(false) }} placeholder="https://example.com" /></label><div className="hcd-dialog-actions"><button onClick={() => setLinkOpen(false)}>取消</button><button className="primary" onClick={applyLink}>应用链接</button></div></div></div>}
    {error && <div className="toast error">{error}</div>}
  </div>
}
