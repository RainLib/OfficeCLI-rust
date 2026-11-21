import { OfficeFeatureTools } from './OfficeFeatures'
import { WordOfficeView, wordOfficeExtension } from './WordOfficeView'
import { DocumentRibbon, RibbonGroup } from './DocumentRibbon'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import { WordFormatTools } from './WordFormatTools.tsx'
import { findSemanticText, SEARCH_RESULT_LIMIT } from './semanticSearch.ts'
import { WorkspaceAgentProvider } from './WorkspaceAgent.tsx'
import { Heading2, Languages, List, MessageSquarePlus, Pilcrow, Sparkles, WandSparkles } from 'lucide-react'
import { LeftPanelShell } from './LeftPanelShell.tsx'
import { WorkspaceLibrary } from './WorkspaceLibrary.tsx'
import { DocumentTabs } from './DocumentTabs.tsx'
import { HostIntegrationBoundary, permits } from './HostIntegration.tsx'
import { LocaleSelect, useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Selection } from '@tiptap/extensions'
import { BubbleMenu } from '@tiptap/react/menus'
import { boundedCollaboration } from './boundedCollaboration.ts'
import { keepHistory, type TableHistoryStep, type TableHistoryRequest } from './editHistory.ts'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { DraftRecovery, useSemanticDraft } from './useSemanticDraft.tsx'
import { clearPastedBlockIds, jsonToSnapshot, schemaExtensions, type Projection } from './schema.ts'
import { ContextMenu, type MenuAction } from './ContextMenu.tsx'
import { CommandMenu } from './CommandMenu.tsx'
import { api, type Session } from './api.ts'
import { loadTheme, type ThemeFace } from './themeCss.ts'
import { BlockFontPicker } from './BlockFontPicker.tsx'
import { FixedViewer } from './FixedViewer.tsx'
import { EditorHeader, EditorStatusbar, ContentToolbar, CollapseSidebarIcon } from './EditorChrome.tsx'
import { DocumentSearch, type SearchHit, type SearchResult } from './DocumentSearch.tsx'
import { readLayout, saveLayout, type LayoutPreferences } from './editorLayout.ts'
import { ErrorToast } from './ErrorToast.tsx'
import { AgentActivityLayer, AgentPanel, useAgentWorkspace } from './AgentActivityLayer.tsx'
import { opaquePreviewExtension } from './opaquePreview.ts'
import { InsertTable } from './InsertTable.tsx'
import { tableLayoutSignature, type TableActionDetail } from './tableStructureControls.ts'
import { loadWordPresentation, wordPresentation } from './wordPresentation.ts'
import { WordRunningMargin } from './WordRunningMargin.tsx'
import { createSemanticResources } from './semanticResources.ts'
import { WordPagePreview } from './WordPagePreview.tsx'
import { WordPictureLayoutDialog } from './WordPictureLayoutDialog.tsx'
import type { WordPictureLayout, WordPictureTarget } from './wordPictureLayout.ts'
import { WordReviewPanel, type CommentDraft, type ReviewAction, type ReviewLocation } from './WordReviewPanel.tsx'
import { wordReviewAnchors } from './wordReviewAnchors.ts'
import { collaborationCheckpoint } from './collaborationCheckpoint.ts'
import { rebindCollaboration } from './rebindCollaboration.ts'
import { authenticateWorkspaceTab, maxRecentTabs, maxWorkspaceTabs, readWorkspaceSession, saveWorkspaceSession, type SavedTab, type TabGroup } from './workspaceSession.ts'
import { CanvasZoomProvider, CanvasViewport } from './CanvasZoom.tsx'
import { tabStateKey } from './tabState.ts'
import { useEmbeddedTextSelection } from './embedSelection'
import { useDocumentTabSelection } from './useDocumentTabSelection.ts'
import { DocumentViewProvider, useDocumentViewState } from './DocumentViewState.tsx'
import { RevisionWorkspace } from './RevisionWorkspace.tsx'
import './style.css'
import './soft-canvas.css'
import './revision-workspace.css'
import './workspace-appearance.css'
import './panel-shells.css'
import './office-ribbon.css'
import { AppearanceProvider, AppearanceSelect, useAppearance } from './Appearance.tsx'
import { DocumentPanelTools } from './DocumentPanelTools.tsx'
import { WorkspacePanel } from './WorkspacePanel.tsx'
import { WorkspaceDrawers } from './WorkspaceDrawers.tsx'
import { useAdminConnection } from './adminConnection.ts'
import { WorkflowWorkspaceProvider, useWorkflowPreparation } from './WorkflowWorkspace.tsx'
import { useEmbeddedSearchLocation, useEmbeddedWorkspace } from './EmbeddedWorkspace'
import { ResourceWorkspaceProvider, useResourceNavigation } from './resources/ResourceWorkspace.tsx'
import { SelectionTransferProvider, useSelectionTransferWorkspace, useTransferNavigation } from './SelectionTransferWorkspace.tsx'
import { captureDocumentTransfer, decodeTransferLink, locateDocumentTransfer, supportsTransfer } from './selectionTransfer.ts'

const ImageWorkspace = lazy(() => import('./ImageWorkspace.tsx').then(module => ({ default: module.ImageWorkspace })))
const CanvasWorkspace = lazy(() => import('./canvas/CanvasWorkspace.tsx').then(module => ({ default: module.CanvasWorkspace })))
const UniverViewer = lazy(() => import('./UniverViewer.tsx').then(module => ({ default: module.UniverViewer })))

const palette = ['#d84a54', '#3478c0', '#9a5abb', '#13866a', '#d17d20', '#7b65d8']
type RevisionItem = { revision: number; patchId?: string; authorId?: string; authorName?: string; createdAtEpochMs?: number }
function snapshotContents(items: ReturnType<typeof jsonToSnapshot>) {
  return JSON.stringify(items.map(({ content }) => {
    // PM coalesces equal marks while the source keeps separate formatting runs.
    // These are the same saved text; run boundaries must not create a false
    // unsaved-draft conflict when another collaborator/Agent commits next.
    const inlines: Array<{ text: string; bold: boolean; italic: boolean; link: string | null }> = []
    for (const inline of content.inlines.filter(inline => inline.text)) {
      const next = { text: inline.text, bold: !!inline.bold, italic: !!inline.italic, link: inline.link ?? null }
      const previous = inlines.at(-1)
      if (previous && previous.bold === next.bold && previous.italic === next.italic && previous.link === next.link) previous.text += next.text
      else inlines.push(next)
    }
    return { kind: content.kind, level: content.level ?? null, font: content.font ?? null, inlines }
  }))
}
function presenceColor(id: string) {
  let value = 0
  for (const character of id) value = (value * 31 + character.charCodeAt(0)) >>> 0
  return palette[value % palette.length]
}
let transientBrowserUser: string | undefined
function browserUserId(): string {
  const key = 'hcd-editor-browser-user-v1'
  try {
    const existing = localStorage.getItem(key)
    if (existing && /^[0-9a-f-]{36}$/.test(existing)) return existing
    const created = crypto.randomUUID()
    localStorage.setItem(key, created)
    return created
  } catch { return transientBrowserUser ||= crypto.randomUUID() }
}

function rememberedConnection(key: string) {
  try { return sessionStorage.getItem(key) || '' } catch { return '' }
}

export function App() {
  return <AppearanceProvider persist localControls={false}><WorkspaceApp /></AppearanceProvider>
}

function WorkspaceApp() {
  const { theme } = useAppearance()
  const { locale } = useI18n()
  const [savedWorkspace] = useState(readWorkspaceSession)
  const [restoringWorkspace, setRestoringWorkspace] = useState(!!savedWorkspace?.tabs.length)
  const [unavailableTabs, setUnavailableTabs] = useState<Array<SavedTab & { error: string }>>([])
  const [linkedDocument] = useState(()=>new URLSearchParams(location.search).get('doc-id') || '')
  const [documentId, setDocumentId] = useState(() => linkedDocument || rememberedConnection('hcd-document'))
  const [token, setToken] = useState(() => rememberedConnection('hcd-token'))
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeDocument, setActiveDocument] = useState<string | null>(null)
  const [pinnedTabs, setPinnedTabs] = useState(() => savedWorkspace?.pinned || [])
  const [recentTabs, setRecentTabs] = useState(() => savedWorkspace?.recent || [])
  const [savingTabs, setSavingTabs] = useState<string[]>([])
  const [tabGroups, setTabGroups] = useState(() => savedWorkspace?.groups || [])
  const recentActivity = useRef<string[]>([])
  const tabStack = useRef<HTMLDivElement>(null)
  const foreground = useRef(activeDocument)
  const tabScroll = useRef(new Map<string, { viewport: HTMLElement; left: number; top: number }[]>())
  const displayTabs = useMemo(() => {
    const grouped = new Set(tabGroups.flatMap(group => group.members))
    return [
      ...sessions.filter(session => pinnedTabs.includes(session.documentId)),
      ...tabGroups.flatMap(group => sessions.filter(session => group.members.includes(session.documentId) && !pinnedTabs.includes(session.documentId))),
      ...sessions.filter(session => !grouped.has(session.documentId) && !pinnedTabs.includes(session.documentId)),
    ]
  }, [sessions, pinnedTabs, tabGroups])
  const liveWorkspace = useRef({ sessions, unavailableTabs, displayTabs })
  liveWorkspace.current = { sessions, unavailableTabs, displayTabs }
  const activate = useCallback((id: string | null) => {
    const previous = foreground.current
    if (previous && previous !== id) {
      const panel = tabStack.current?.querySelector(`[data-document-id="${CSS.escape(previous)}"]`)
      const scroll = [...(panel?.querySelectorAll<HTMLElement>('.canvas-viewport') || [])]
        .filter(viewport => !viewport.hidden)
        .map(viewport => ({ viewport, left: viewport.scrollLeft, top: viewport.scrollTop }))
      tabScroll.current.set(previous, scroll)
    }
    if (id) recentActivity.current = [id, ...recentActivity.current.filter(previous => previous !== id)]
    setActiveDocument(id)
  }, [])
  useLayoutEffect(() => {
    foreground.current = activeDocument
    if (activeDocument === null) return
    for (const { viewport, top, left } of tabScroll.current.get(activeDocument) || []) {
      if (viewport.isConnected) viewport.scrollTo({ top, left, behavior: 'instant' })
    }
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => cancelAnimationFrame(frame)
  }, [activeDocument])

  const [error, setError] = useState('')
  const [samples, setSamples] = useState<Array<{ id: string; title: string; format: string; mode: string }>>([])
  const [openingSample, setOpeningSample] = useState<string | null>(null)
  const [portableFile, setPortableFile] = useState<File | null>(null)
  const [uploadToken, setUploadToken] = useState('')
  const [uploadState, setUploadState] = useState('')
  useEffect(() => {
    if (!savedWorkspace?.tabs.length) return
    const request = new AbortController()
    void Promise.allSettled(savedWorkspace.tabs.map(tab => authenticateWorkspaceTab(tab, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])))).then(results => {
      if (request.signal.aborted) return
      const opened: Session[] = [], unavailable: typeof unavailableTabs = []
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') opened.push(result.value)
        else unavailable.push({ ...savedWorkspace.tabs[index], error: /401:|403:/.test(String(result.reason)) ? '访问已过期或无权限，请重新连接。' : '暂时无法恢复文档，请重试连接。' })
      })
      setSessions(opened); setUnavailableTabs(unavailable)
      activate(linkedDocument ? (opened.some(item=>item.documentId===linkedDocument)?linkedDocument:null) : opened.some(item => item.documentId === savedWorkspace.activeDocument) ? savedWorkspace.activeDocument : null)
      setRestoringWorkspace(false)
    })
    return () => request.abort()
  }, [savedWorkspace, activate])
  useEffect(() => {
    if (!restoringWorkspace) saveWorkspaceSession([...displayTabs, ...unavailableTabs], activeDocument, pinnedTabs, recentTabs, tabGroups)
  }, [displayTabs, unavailableTabs, activeDocument, restoringWorkspace, pinnedTabs, recentTabs, tabGroups])
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let active = true
    fetch('/__hcd_demo/documents').then(response => response.ok ? response.json() : [])
      .then((available: typeof samples) => { if (active) setSamples(available) })
      .catch(() => {})
    return () => { active = false }
  }, [])
  async function open(id: string, accessToken: string, remember = true, title?: string, foreground = true) {
    setError('')
    try {
      const opened = await authenticateWorkspaceTab({ documentId: id, token: accessToken, title: title || samples.find(sample => sample.id === id.trim())?.title }, AbortSignal.timeout(15_000))
      const known = liveWorkspace.current
      if (known.sessions.length + known.unavailableTabs.length >= maxWorkspaceTabs
        && ![...known.sessions, ...known.unavailableTabs].some(tab => tab.documentId === opened.documentId)) {
        throw new Error('已达到标签页上限，请关闭一个文件后再打开。')
      }
      if (remember) {
        try {
          sessionStorage.setItem('hcd-document', opened.documentId)
          sessionStorage.setItem('hcd-token', opened.token)
        } catch { /* Browser storage is optional. */ }
      }
      setUnavailableTabs(previous => previous.filter(item => item.documentId !== opened.documentId))
      setSessions(previous => previous.some(item => item.documentId === opened.documentId)
        ? previous.map(item => item.documentId === opened.documentId ? opened : item) : [...previous, opened])
      setRecentTabs(previous => previous.filter(tab => tab.documentId !== opened.documentId))
      if (foreground) activate(opened.documentId)
      return true
    } catch (cause) { setError(String(cause)); return false }
  }
  useAdminConnection(!restoringWorkspace, (id, accessToken) => open(id, accessToken))
  async function openSample(id: string) {
    setOpeningSample(id)
    setError('')
    try {
      const response = await fetch(`/__hcd_demo/session/${encodeURIComponent(id)}`, { method: 'POST' })
      if (!response.ok) throw new Error(`无法打开验收文档：${response.status}`)
      const sample = await response.json() as { documentId: string; token: string }
      try { sessionStorage.removeItem('hcd-document'); sessionStorage.removeItem('hcd-token') } catch { /* Browser storage is optional. */ }
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
      if (/\.(png|jpe?g|webp)$/i.test(portableFile.name)) {
        const response = await fetch(`/v1/images?filename=${encodeURIComponent(portableFile.name)}`, { method: 'POST', headers: { Authorization: `Bearer ${uploadToken.trim()}` }, body: portableFile })
        if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
        const imported = await response.json() as { documentId: string; token: string; title: string }
        await open(imported.documentId, imported.token, false, imported.title)
        setUploadState('图片已导入。'); return
      }
      if (!/\.(hcd|csv|tsv)$/i.test(portableFile.name)) throw new Error('请选择 HCD、CSV、TSV、PNG、JPEG 或 WebP 文件')
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
  function assignGroup(ids: string[], groupId: string | null, newName?: string) {
    const members = ids.filter(id => !pinnedTabs.includes(id))
    if (!members.length) return
    setTabGroups(previous => {
      const groups = previous.map(group => {
        const remaining = group.members.filter(id => !members.includes(id))
        return { ...group, members: group.id === groupId ? [...remaining, ...members] : remaining }
      })
      if (groupId && newName) groups.push({ id: groupId, name: newName, members, collapsed: false })
      return groups.filter(group => group.members.length)
    })
  }

  function closeTabs(closed: Session[]) {
    const tabs = liveWorkspace.current.displayTabs
    const removed = closed.filter(tab => tabs.some(current => current.documentId === tab.documentId && current.token === tab.token))
    const ids = new Set(removed.map(tab => tab.documentId))
    if (!ids.size) return
    const remaining = tabs.filter(tab => !ids.has(tab.documentId))
    for (const id of ids) tabScroll.current.delete(id)
    recentActivity.current = recentActivity.current.filter(id => !ids.has(id))
    const fallback = recentActivity.current.find(id => remaining.some(tab => tab.documentId === id))
    setSessions(previous => previous.filter(tab => !ids.has(tab.documentId)))
    setPinnedTabs(previous => previous.filter(id => !ids.has(id)))
    setTabGroups(previous => previous.map(group => ({ ...group, members: group.members.filter(id => !ids.has(id)) })).filter(group => group.members.length))
    const recent = removed.map(({ documentId, token, title }) => ({ documentId, token, title }))
    setRecentTabs(previous => [...recent, ...previous.filter(tab => !ids.has(tab.documentId))].slice(0, maxRecentTabs))
    setActiveDocument(previous => {
      if (!previous || !ids.has(previous)) return previous
      const index = tabs.findIndex(tab => tab.documentId === previous)
      return fallback || remaining[Math.min(index, remaining.length - 1)]?.documentId || null
    })
    if (ids.has(documentId)) {
      setDocumentId(''); setToken('')
      try { sessionStorage.removeItem('hcd-document'); sessionStorage.removeItem('hcd-token') } catch { /* Browser storage is optional. */ }
    }
  }

  const groupOf = (id: string) => tabGroups.find(group => group.members.includes(id))?.id || null
  function reorderTab(id: string, target: string, after: boolean) {
    if (id === target || pinnedTabs.includes(id) !== pinnedTabs.includes(target)) return
    const destination = groupOf(target)
    if (groupOf(id) !== destination) assignGroup([id], destination)
    setSessions(previous => {
      const moved = previous.find(tab => tab.documentId === id)
      const next = previous.filter(tab => tab.documentId !== id)
      const index = next.findIndex(tab => tab.documentId === target)
      if (!moved || index < 0) return previous
      next.splice(index + Number(after), 0, moved)
      return next
    })
  }
  function moveTab(id: string, direction: -1 | 1) {
    const index = displayTabs.findIndex(tab => tab.documentId === id), target = displayTabs[index + direction]
    if (index >= 0 && target && groupOf(id) === groupOf(target.documentId)) reorderTab(id, target.documentId, direction === 1)
  }
  function pinTab(id: string) {
    if (!pinnedTabs.includes(id)) assignGroup([id], null)
    setPinnedTabs(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id])
  }
  function updateGroup(id: string, update: Partial<Pick<TabGroup, 'name' | 'collapsed'>>) {
    setTabGroups(previous => previous.map(group => group.id === id ? { ...group, ...update } : group))
  }
  const library = <WorkspaceLibrary samples={samples} sessions={sessions} opening={openingSample} onOpen={id => void openSample(id)} onResume={activate}>
    {!!unavailableTabs.length && <section className="manual-access workspace-restore-errors" aria-label={localizeSource(locale, '待恢复的文档')}><h3><LocalText source="待恢复的文档" /></h3>{unavailableTabs.map(item => <div key={item.documentId}><strong>{item.title || item.documentId}</strong><p role="status">{localizeSource(locale, item.error)}</p><button onClick={() => { setDocumentId(item.documentId); setToken(''); document.querySelector<HTMLInputElement>('.manual-access input')?.focus() }}><LocalText source="重新连接" /></button><button onClick={() => void open(item.documentId, item.token, false)}><LocalText source="重试" /></button><button onClick={() => setUnavailableTabs(previous => previous.filter(tab => tab.documentId !== item.documentId))}><LocalText source="移除" /></button></div>)}</section>}
    <section className="manual-access"><p><LocalText source={"输入文档 ID 和短期访问令牌。只读令牌无法提交修改。"} /></p><label><LocalText source={"文档 ID"} /><input value={documentId} onChange={event => setDocumentId(event.target.value)} placeholder="doc-…" /></label><label><LocalText source={"访问令牌"} /><textarea rows={4} value={token} onChange={event => setToken(event.target.value)} placeholder={localizeSource(locale, "粘贴短期令牌")} /></label><button onClick={() => void open(documentId, token)} disabled={!documentId || !token}><LocalText source={"打开文档"} /></button></section>
    <section className="manual-access portable-import"><p><LocalText source={"重新打开HCD 或独立图片。上传令牌用于导入。"} /></p><label><LocalText source={"HCD / 图片文件"} /><input type="file" accept=".hcd,.csv,.tsv,.png,.jpg,.jpeg,.webp" onChange={event => setPortableFile(event.target.files?.[0] ?? null)} /></label><label><LocalText source={"上传令牌"} /><textarea rows={2} value={uploadToken} onChange={event => setUploadToken(event.target.value)} placeholder={localizeSource(locale, "粘贴短期上传令牌")} /></label><button onClick={() => void uploadPortable()} disabled={!portableFile || !uploadToken.trim() || uploadState === '上传中…'}><LocalText source={"导入文档 / 图片"} /></button>{uploadState && <p role="status">{localizeDynamic(locale, uploadState)}</p>}</section>
    {error && <p className="error">{localizeDynamic(locale, error)}</p>}
  </WorkspaceLibrary>
  if (restoringWorkspace) return <div className="hcd-surface multi-document-workspace" data-theme={theme} data-workspace-restoring="true"><p className="embedded-loading" role="status"><LocalText source="正在恢复工作空间…" /></p></div>
  return <WorkflowWorkspaceProvider sessions={sessions} activate={activate}><div className="hcd-surface multi-document-workspace" data-theme={theme} data-workspace-restoring="false"><WorkspaceAgentProvider><ResourceWorkspaceProvider sessions={sessions} activeDocument={activeDocument} activate={activate}>
    <SelectionTransferProvider defaultUploadToken={uploadToken} register={(result, access, title) => open(result.documentId, access, false, title, false)}>
    <DocumentTabs sessions={displayTabs} active={activeDocument} pinned={pinnedTabs} recent={recentTabs} groups={tabGroups} activate={activate}
      pin={pinTab} move={moveTab} reorder={reorderTab} assignGroup={assignGroup} updateGroup={updateGroup}
      onSaving={setSavingTabs} onClose={closeTabs} reopen={tab => open(tab.documentId, tab.token, false, tab.title)}
      forget={id => setRecentTabs(previous => previous.filter(tab => tab.documentId !== id))} />
    <div className="document-tab-stack" ref={tabStack}>
    <div className="document-tab-panel document-library" hidden={activeDocument !== null}>{library}</div>
    {sessions.map(item => <div className="document-tab-panel" key={item.documentId} hidden={activeDocument !== item.documentId} inert={activeDocument !== item.documentId || savingTabs.includes(item.documentId)} data-document-id={item.documentId}>
      <Workspace key={item.documentId} session={item} onOpenDocument={(id, token, title) => void open(id, token, false, title)} onClose={() => activate(null)} onEpochChange={epoch => setSessions(previous => previous.map(value => value.documentId === item.documentId ? { ...value, collaborationEpoch: epoch } : value))} />
    </div>)}
    </div>
  </SelectionTransferProvider></ResourceWorkspaceProvider></WorkspaceAgentProvider></div></WorkflowWorkspaceProvider>
}

type WorkspaceProps = { session: Session; onClose: () => void; onEpochChange?: (epoch: number) => void; embedded?: boolean; onOpenDocument?: (id: string, token: string, title?: string) => void }
export function Workspace(props: WorkspaceProps) {
  const storageKey = `${props.session.apiUrl || ''}:${props.session.documentId}:${props.session.userId || browserUserId()}`
  return <HostIntegrationBoundary session={props.session}>{effective => <DocumentViewProvider key={JSON.stringify([storageKey, effective.serviceId])} storageKey={storageKey}><CanvasZoomProvider storageKey={storageKey}>
    <AgentActivityLayer session={effective}><EpochWorkspace {...props} session={effective} /></AgentActivityLayer>
  </CanvasZoomProvider></DocumentViewProvider>}</HostIntegrationBoundary>
}

function EpochWorkspace({ session, onClose, onEpochChange, onOpenDocument, embedded = false }: WorkspaceProps) {
  if (session.format === 'excalidraw') return <Suspense fallback={<div className="embedded-loading">正在加载自由画布…</div>}><CanvasWorkspace session={session} onClose={onClose} /></Suspense>
  const semantic = ['docx', 'html', 'md', 'txt'].includes(session.format)
  if (['png', 'jpg', 'jpeg', 'webp'].includes(session.format)) return <Suspense fallback={<div className="embedded-loading">正在加载图片工作台…</div>}><ImageWorkspace session={session} onClose={onClose} onOpenDocument={onOpenDocument} /></Suspense>
  const content = semantic ? <SemanticEditor session={session} onClose={onClose} onEpochChange={onEpochChange} embedded={embedded} />
    : ['xlsx','csv','tsv'].includes(session.format) ? <Suspense fallback={<div className="embedded-loading"><LocalText source={"正在加载工作簿…"} /></div>}><UniverViewer session={session} onClose={onClose} embedded={embedded} /></Suspense>
      : <FixedViewer session={session} onClose={onClose} embedded={embedded} />
  return content
}

function SemanticEditor({ session, onClose, onEpochChange, embedded }: { session: Session; onClose: () => void; onEpochChange?: (epoch: number) => void; embedded: boolean }) {
  const { locale } = useI18n()
  const resourceSession = useRef(session); resourceSession.current = session
  const resources = useMemo(()=>createSemanticResources(()=>resourceSession.current), [session.documentId])
  const { focused, setFocused, wrapText, setWrapText, selectedRevision, setSelectedRevision, comparing, setComparing, rightPanel, setRightPanel, activeTab, setActiveTab } = useDocumentViewState()
  const [editorSynced, setEditorSynced] = useState(false)
  const [editorReady, setEditorReady] = useState(false)
  const [tableTextFocused, setTableTextFocused] = useState(false)
  const [tableBusy, setTableBusy] = useState(false)
  const [wordPicture, setWordPicture] = useState<WordPictureTarget | null>(null)
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null)
  const tableBusyRef = useRef(false), activeTableBlock = useRef<string | null>(null)
  const pendingTableFocus = useRef(false)
  const pendingCell = useRef<string | null>(null)
  const tableAction = useRef<(detail: TableActionDetail) => void>(() => {})
  const tableHistory = useRef<{ past: TableHistoryStep[]; future: TableHistoryStep[] }>({ past: [], future: [] })
  const [, refreshHistory] = useState(0)
  const historyBridge = useRef({ can: (_direction: 'undo' | 'redo'): boolean => false, travel: (_direction: 'undo' | 'redo') => {}, edited: () => {} })
  const insertionBlock = useRef<{ id: string | null; index: number }>({ id: null, index: -1 })
  const [epochDraft, setEpochDraft] = useState<{ epoch: number; current: Projection | null } | null>(null)
  const localEdits = useRef(0), checkpointedEdits = useRef(0), hasSynced = useRef(false)
  const [status, setStatus] = useState('连接中')
  const [revision, setRevision] = useState<number | null>(null)
  const [history, setHistory] = useState<RevisionItem[]>([])
  const [nextBefore, setNextBefore] = useState<number | null | undefined>(undefined)
  const [historical, setHistorical] = useState<Projection | null>(null)
  const [comparisonHead, setComparisonHead] = useState<Projection | null>(null)
  const [historyLoading, setHistoryLoading] = useState(selectedRevision !== null)
  const [historyReload, setHistoryReload] = useState(0)
  const [historyError, setHistoryError] = useState('')
  const [restoring, setRestoring] = useState(false)
  const historyRequest = useRef<AbortController | null>(null)
  const historyActive = selectedRevision !== null
  useEffect(() => () => historyRequest.current?.abort(), [])
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; selectedText: string; span?: { from: number; to: number }; section?: { from: number; to: number } } | null>(null)
  const [command, setCommand] = useState<{ x: number; y: number } | null>(null)
  const commandTrigger = useRef<(event: KeyboardEvent) => boolean>(() => false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkHref, setLinkHref] = useState('')
  const [presence, setPresence] = useState<Array<{ id: string; name: string; color: string; connections: number }>>([])
  const { panelOpen, setPanelOpen, requestTask, operations: agentOperations } = useAgentWorkspace()
  const transfers = useSelectionTransferWorkspace()
  const hostWorkspace = useEmbeddedWorkspace()
  const canTransfer = !!transfers && supportsTransfer(session)
  const committedAgentRevision = Math.max(-1, ...agentOperations.filter(operation=>operation.status === 'applied').map(operation=>operation.revision))
  const [layout, setLayout] = useState<LayoutPreferences>(() => readLayout(session.documentId, session.integratedToolbar))
  function showRightPanel(panel: 'settings' | 'revisions') { setFocused(false); setPanelOpen(false); setRightPanel(panel) }
  const [outline, setOutline] = useState<Array<{ pos: number; level: number; text: string }>>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchVersion, setSearchVersion] = useState(0)
  const [themeCss, setThemeCss] = useState('')
  const [themeFaces, setThemeFaces] = useState<ThemeFace[]>([])
  const lastOutline = useRef('')
  const lastSemantic = useRef<string | null>(null)
  const canonicalHead = useRef<Promise<number> | null>(null)
  useEffect(() => { saveLayout(layout, session.documentId, session.integratedToolbar) }, [layout, session.documentId, session.integratedToolbar])
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
  const ydoc = useMemo(() => new Y.Doc(), [session.documentId, session.collaborationEpoch])
  const boundDocument = useRef(ydoc)
  useEffect(() => {
    const updated = (_update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
      if (hasSynced.current && transaction.local && origin !== 'hcd-canonical-ids') localEdits.current++
    }
    ydoc.on('update', updated)
    return () => ydoc.off('update', updated)
  }, [ydoc])
  useEffect(() => {
    if (!epochDraft) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [epochDraft])
  const localUser = useMemo(() => {
    const id = session.userId || browserUserId()
    return { id, clientId: ydoc.clientID, name: session.displayName?.trim() || `User ${id.slice(0, 4)}`, color: presenceColor(id) }
  }, [session.userId, session.displayName, ydoc])
  const liveToken = useRef(session.token); liveToken.current = session.token
  const provider = useMemo(() => new HocuspocusProvider({
    url: session.collabUrl || import.meta.env.VITE_HCD_COLLAB_URL || 'ws://127.0.0.1:8768',
    name: `${session.documentId}:${session.collaborationEpoch ?? 0}`,
    document: ydoc,
    token: () => liveToken.current,
  }), [session.documentId, session.collaborationEpoch, session.collabUrl, ydoc])
  useEffect(() => { if (provider.isAuthenticated) void provider.sendToken().catch(() => {}) }, [provider, session.token])
  const draftProtection = useSemanticDraft(session, ydoc, provider, () => {
    localEdits.current++
    setStatus('已恢复本地草稿')
  })
  const readOnly = session.scope === 'read' || !editorSynced || !draftProtection.ready || epochDraft !== null || tableBusy
  const wordPreview = session.format === 'docx' && session.scope === 'read' && editorReady
  const editor = useEditor({
    extensions: [...schemaExtensions.map(extension => extension.name === 'hcdOpaque' ? opaquePreviewExtension(session, locale, resources, pendingCell, session.format === 'docx' ? setWordPicture : undefined) : extension), wordOfficeExtension, Selection.configure({ className: 'hcd-inactive-selection' }), wordPresentation, boundedCollaboration({ can: direction => historyBridge.current.can(direction), travel: direction => historyBridge.current.travel(direction), edited: () => historyBridge.current.edited() }).configure({ document: ydoc }),
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
    editable: false,
    editorProps: { attributes: { class: 'hcd-editor-body' }, transformPasted: clearPastedBlockIds, handleKeyDown: (_view, event) => commandTrigger.current(event) },
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
  }, [session.documentId])
  const documentViewReady = editorSynced && draftProtection.ready && boundDocument.current === ydoc && revision !== null && !historyActive
  useEmbeddedTextSelection(session, editor, documentViewReady && !readOnly, revision)
  const rememberCheckpointSelection = useDocumentTabSelection(session, editor, documentViewReady, revision)
  useEffect(() => {
    if (!editor) return
    const tableFocus = (event: Event) => { setTableTextFocused(true); activeTableBlock.current = (event as CustomEvent<{ blockId: string }>).detail?.blockId || null }
    const bodyFocus = () => { setTableTextFocused(false); activeTableBlock.current = null }
    const action = (event: Event) => tableAction.current((event as CustomEvent<TableActionDetail>).detail)
    editor.view.dom.addEventListener('hcd-inline-table-focus', tableFocus)
    editor.on('focus', bodyFocus)
    editor.view.dom.addEventListener('hcd-table-action', action)
    return () => { editor.view.dom.removeEventListener('hcd-inline-table-focus', tableFocus); editor.view.dom.removeEventListener('hcd-table-action', action); editor.off('focus', bodyFocus) }
  }, [editor])
  useEffect(() => {
    if (!editor || boundDocument.current === ydoc) return
    hasSynced.current = false
    setEditorSynced(false)
    editor.setEditable(false)
    const bind = () => {
      if (editor.isDestroyed || boundDocument.current === ydoc) return
      rebindCollaboration(editor, ydoc, provider, localUser)
      boundDocument.current = ydoc
      localEdits.current = 0; checkpointedEdits.current = 0
      setEpochDraft(null)
      hasSynced.current = true; setEditorSynced(true)
    }
    provider.on('synced', bind)
    if (provider.isSynced) bind()
    return () => { provider.off('synced', bind) }
  }, [editor, ydoc, provider, localUser])
  useEffect(() => {
    if (!editor || revision === null || session.format !== 'docx') return
    const request = new AbortController()
    void loadWordPresentation(editor, session, revision, request.signal, resources)
      .catch(cause => { if (!request.signal.aborted) setError(`Word 排版加载失败：${String(cause)}`) })
    return () => request.abort()
  }, [editor, session, revision, resources])
  useEffect(() => {
    editor?.setEditable(!readOnly && !historyActive)
    if (editor && !readOnly && !historyActive && boundDocument.current === ydoc && pendingTableFocus.current) {
      pendingTableFocus.current = false
      editor.view.dom.focus({ preventScroll: true })
    }
  }, [editor, readOnly, historyActive, ydoc, editorSynced])
  useEffect(() => {
    let active = true
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
        // A checkpoint announcement can race a new keystroke. Clear the local
        // dirty guard only after reading identical canonical content and only
        // if no local transaction happened during that read.
        const version = localEdits.current
        const draftVersion = draftProtection.version()
        if (editor) void resources.projection(Number.isSafeInteger(message.revision) ? message.revision! : null).then(projection => {
          // Epoch rebinding resets counters. A response from a detached room
          // must never acknowledge a later room that reused the same number.
          if (!active) return
          if (version === localEdits.current && snapshotContents(jsonToSnapshot(editor.getJSON())) === snapshotContents(projection.blocks.filter(block => block.region === 'body'))) {
            checkpointedEdits.current = version
            draftProtection.acknowledge(draftVersion)
          }
        }).catch(() => {})
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
      hasSynced.current = true
      setEditorSynced(true)
      setEditorReady(true)
      setStatus('已同步')
      // Creating the semantic projection can advance the imported revision while
      // the first collaboration room is loading. Wait for that baseline on save.
      const head = resources.projection().then((projection: Projection) => {
        if (active) setRevision(previous => Math.max(previous ?? 0, projection.revision))
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
    if (provider.isSynced) synced()
    return () => { active = false; provider.off('status', connection); provider.off('synced', synced); provider.off('stateless', saveState); provider.awareness?.off('change', refreshPresence) }
  }, [provider, ydoc, localUser, editor])
  useEffect(() => () => provider.destroy(), [provider])
  useEffect(() => () => ydoc.destroy(), [ydoc])
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const canViewHistory = permits(session, 'history.view')
        const [revisionResponse, authResponse] = await Promise.all([api(session, canViewHistory ? '/revisions' : ''), api(session, '/auth')])
        const access = await authResponse.json() as { collaborationEpoch: number }
        if (!alive) return
        if (access.collaborationEpoch !== (session.collaborationEpoch ?? 0)) {
          if (tableBusyRef.current) return
          if (localEdits.current > checkpointedEdits.current) {
            // An offline keystroke may never have reached the sidecar's dirty
            // marker. Keep this Y.Doc, including inline table drafts, available.
            const current = await (await api(session, '/editor')).json() as Projection
            if (alive) setEpochDraft({ epoch: access.collaborationEpoch, current })
          } else onEpochChange?.(access.collaborationEpoch)
          return
        }
        const received = await revisionResponse.json()
        const result = canViewHistory ? received as { headRevision: number; revisions: RevisionItem[]; nextBefore: number | null } : { headRevision: received.revision as number, revisions: [], nextBefore: null }
        if (!alive) return
        setRevision(previous => { if (previous !== null && result.headRevision > previous) setStatus('已保存'); return result.headRevision })
        setHistory(previous => Array.from(new Map([...previous, ...result.revisions].map(item => [item.revision, item])).values()).sort((a, b) => a.revision - b.revision))
        setNextBefore(previous => previous === undefined ? result.nextBefore : previous)
      } catch (cause) { if (alive) setError(String(cause)) }
    }
    void refresh()
    const interval = setInterval(() => void refresh(), 5000)
    return () => { alive = false; clearInterval(interval) }
  }, [session, onEpochChange, provider, committedAgentRevision])
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
    if (epochDraft) { setError('协同版本已变化，请先保留并核对本地草稿。'); return null }
    if (session.scope === 'read') return revision
    setStatus('保存中')
    setError('')
    try {
      // A save point includes peers' synchronized edits and clears the shared
      // pending marker before an Agent or source export continues.
      const sharedRevision = await collaborationCheckpoint(provider)
      const expectedRevision = Math.max(revision, sharedRevision, await (canonicalHead.current ?? Promise.resolve(revision)))
      const blocks = jsonToSnapshot(editor.getJSON())
      const localVersion = localEdits.current
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
        if (snapshotContents(blocks) !== snapshotContents(projection.blocks.filter(block => block.region === 'body'))) throw cause
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
      resources.remember(saved.projection)
      if (localVersion === localEdits.current) {
        checkpointedEdits.current = localVersion
        rememberCheckpointSelection(saved.revision)
      }
      setStatus('已保存')
      return saved.revision
    } catch (cause) { setStatus('保存失败'); setError(String(cause)); return null }
  }
  function selectedBlock() {
    if (!editor) return { id: null as string | null, index: -1, end: 0 }
    const id = activeTableBlock.current
    let found = { id: null as string | null, index: -1, end: editor.state.doc.content.size }, index = 0
    editor.state.doc.descendants((node, pos) => {
      if (!['paragraph', 'heading', 'listItem', 'hcdOpaque'].includes(node.type.name)) return
      if (id ? node.attrs.hcdBlockId === id : pos <= editor.state.selection.from && editor.state.selection.from <= pos + node.nodeSize) {
        const resolved = editor.state.doc.resolve(pos)
        found = { id: node.attrs.hcdBlockId || null, index, end: node.type.name === 'listItem' && resolved.depth ? resolved.end(1) + 1 : pos + node.nodeSize }
      }
      index++
      return false
    })
    return found
  }
  async function savePictureLayout(target: WordPictureTarget, layout: WordPictureLayout | null) {
    if (!editor || readOnly || historyActive || tableBusyRef.current) throw new Error('请等待文档同步。')
    tableBusyRef.current = true
    setTableBusy(true)
    setError('')
    try {
      const version = localEdits.current
      const checkpoint = await collaborationCheckpoint(provider)
      if (localEdits.current === version) checkpointedEdits.current = version
      const latest = await (await api(session, `/nodes/${encodeURIComponent(target.nodeId)}`)).json() as { revision: number; visualHash?: string }
      if (latest.revision < checkpoint || latest.visualHash !== target.visualHash) throw new Error('图片版式已变化，请重新打开图片设置。')
      const saved = await (await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(session.collaborationEpoch ?? 0) },
        body: JSON.stringify({
          schemaVersion: 'hcd-patch/57', documentId: session.documentId, patchId: crypto.randomUUID(), baseRevision: latest.revision,
          operations: [{ op: 'docx.picture.layout', nodeId: target.nodeId, layout, precondition: { visualHash: target.visualHash } }],
        }),
      })).json() as { revision: number }
      const access = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
      setRevision(saved.revision)
      setStatus('已保存')
      onEpochChange?.(access.collaborationEpoch)
    } finally {
      tableBusyRef.current = false
      setTableBusy(false)
    }
  }
  async function beginWordComment(selection?: { from: number; to: number }) {
    if (!editor || readOnly || historyActive) return
    const { from, to } = selection || editor.state.selection
    try {
      if (from >= to) throw new Error(localizeSource(locale, '请先选择需要批注的文字。'))
      const quote = editor.state.doc.textBetween(from, to, '\n')
      const target = await captureDocumentTransfer(editor, from, to)
      if (target.spans.length !== 1 || !quote.trim()) throw new Error(localizeSource(locale, '请选择一个段落中的文字。'))
      setCommentDraft({ ...target.spans[0], quote })
      setMenu(null)
      setFocused(false)
      setActiveTab('review')
      setRightPanel('word-review')
    } catch (cause) { setError(String(cause)) }
  }
  async function writeWordReview(action: ReviewAction, observedRevision?: number) {
    if (!editor || readOnly || historyActive || tableBusyRef.current) throw new Error('请等待文档同步。')
    tableBusyRef.current = true
    setTableBusy(true)
    try {
      const saved = await save()
      if (saved === null) throw new Error('请先保存正文，再提交审阅操作。')
      if (observedRevision !== undefined && observedRevision !== saved) throw new Error('文档已有更新，请核对审阅面板后重试。')
      const receipt = await (await api(session, '/word-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(session.collaborationEpoch ?? 0) },
        body: JSON.stringify({ baseRevision: saved, patchId: crypto.randomUUID(), action }),
      })).json() as { revision: number }
      setRevision(receipt.revision)
      if (action.kind === 'decide') {
        const access = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
        onEpochChange?.(access.collaborationEpoch)
      }
    } finally {
      tableBusyRef.current = false
      setTableBusy(false)
    }
  }
  function locateWordComment(location: ReviewLocation, anchorId?: string) {
    if (!editor) return
    if (historyActive) { locateHistoricalBlock(location.blockId); return }
    const selector = '[data-hcd-block-id="' + CSS.escape(location.blockId) + '"]'
    if (!wordPreview && location.end > location.start) {
      try {
        const live = wordReviewAnchors.getState(editor.state)?.anchors.find(anchor => anchor.id === anchorId)
        if (live?.from !== undefined && live.to !== undefined && live.from < live.to) {
          editor.commands.setTextSelection({ from: live.from, to: live.to })
          editor.view.dom.querySelector(selector)?.scrollIntoView({ block: 'center', behavior: 'instant' })
        } else locateDocumentTransfer(editor, { kind: 'text', spans: [{ ...location, textHash: '' }] })
        // A restored tab can already report hasFocus while its DOM range is
        // empty. Always reconcile the range after the comment click/layout;
        // Tiptap's focus command may otherwise return early on hasFocus.
        const clickedFrom = document.activeElement
        requestAnimationFrame(() => {
          if (!editor.isDestroyed && editor.view.dom.getClientRects().length
            && (document.activeElement === clickedFrom || document.activeElement === document.body
              || editor.view.dom.contains(document.activeElement))) editor.view.focus()
        })
        return
      } catch { /* The live Yjs paragraph may have moved ahead of the saved range. */ }
    }
    const surface = editor.view.dom.closest('.workspace')
    const targets = wordPreview
      ? Array.from(surface?.querySelectorAll<HTMLIFrameElement>('.word-page-preview iframe') || [], frame =>
        frame.contentDocument?.querySelector<HTMLElement>(selector + ',[data-hcd-id="' + CSS.escape(location.blockId) + '"]'))
      : [editor.view.dom.querySelector<HTMLElement>(selector)]
    const target = targets.find(Boolean)
    target?.scrollIntoView({ block: 'center' })
    target?.animate([{ backgroundColor: '#eee0a1' }, { backgroundColor: 'transparent' }], { duration: 1300 })
  }
  function insertEmptyParagraph() {
    if (!editor || readOnly || historyActive) return
    const { end } = selectedBlock()
    editor.chain().insertContentAt(end, { type: 'paragraph', attrs: { hcdBlockId: null } }).setTextSelection(end + 1).focus().run()
  }
  async function mutateTable(detail: TableActionDetail | { rows: number; columns: number } | TableHistoryRequest) {
    if (!editor || readOnly || historyActive || tableBusyRef.current) return
    tableBusyRef.current = true; pendingTableFocus.current = true; setTableBusy(true); setError(''); setStatus('保存中')
    try {
      const version = localEdits.current
      const checkpoint = await collaborationCheckpoint(provider)
      if (version === localEdits.current) checkpointedEdits.current = version
      const current = await resources.projection(checkpoint)
      const body = current.blocks.filter(block => block.region === 'body')
      let operation: Record<string, unknown>
      let restored: TableHistoryStep | undefined
      if ('historyDirection' in detail) {
        const direction = detail.historyDirection
        restored = (direction === 'undo' ? tableHistory.current.past : tableHistory.current.future).at(-1)
        if (!restored) throw new Error('没有可撤销的表格操作。')
        const expected = direction === 'undo' ? restored.afterHash : restored.beforeHash
        const live = body.find(block => block.blockId === restored!.blockId)
        if ((live?.blockHash ?? null) !== expected) throw new Error('该表格已有后续修改，无法覆盖撤销。请先撤销本地文字编辑，或在修订历史中核对协作者的变化。')
        const targetHash = direction === 'undo' ? restored.beforeHash : restored.afterHash
        operation = targetHash === null
          ? { op: 'table.delete', blockId: restored.blockId, precondition: { blockHash: expected } }
          : { op: 'table.restore', blockId: restored.blockId, sourceRevision: direction === 'undo' ? restored.beforeRevision : restored.afterRevision,
              afterBlockId: restored.afterBlockId, precondition: { blockHash: expected } }
      } else if ('action' in detail) {
        const block = body.find(block => block.blockId === detail.blockId)
        if (!block) throw new Error('表格已变化，请重新定位后操作。')
        if (detail.expectedLayout) {
          const table = new DOMParser().parseFromString(block.readOnlyHtml || '', 'text/html').querySelectorAll('table')[detail.tableIndex]
          if (!table || tableLayoutSignature(table) !== detail.expectedLayout) throw new Error('表格布局已变化，请重新选择单元格。')
        }
        if (detail.action === 'deleteTable') {
          const tables = new DOMParser().parseFromString(block.readOnlyHtml || '', 'text/html').querySelectorAll('table')
          if (detail.tableIndex !== 0 || [...tables].filter(table => !table.parentElement?.closest('table')).length !== 1) throw new Error('请通过外层表格操作删除整表。')
          operation = { op: 'table.delete', blockId: block.blockId, precondition: { blockHash: block.blockHash } }
        } else if (detail.action === 'activateCell') {
          operation = { op: 'table.cell.activate', blockId: detail.blockId, tableIndex: detail.tableIndex, row: detail.row, column: detail.column, precondition: { blockHash: block.blockHash } }
        } else if (detail.action === 'mergeCells') {
          operation = { op: 'table.cells.merge', blockId: detail.blockId, tableIndex: detail.tableIndex, range: detail.range, precondition: { blockHash: block.blockHash } }
        } else if (detail.action === 'splitCell') {
          operation = { op: 'table.cell.split', blockId: detail.blockId, tableIndex: detail.tableIndex, row: detail.row, column: detail.column, precondition: { blockHash: block.blockHash } }
        } else operation = { op: 'table.edit', blockId: detail.blockId, tableIndex: detail.tableIndex, action: detail.action, index: detail.index, precondition: { blockHash: block.blockHash } }
      } else {
        const target = insertionBlock.current
        const afterBlockId = target.id || (target.index >= 0 ? body[target.index]?.blockId : null)
        if (target.index >= 0 && !afterBlockId) throw new Error('插入位置已变化，请重新选择。')
        operation = { op: 'table.insert', afterBlockId: afterBlockId ?? null, rows: detail.rows, columns: detail.columns }
      }
      // Keep an editable paragraph when removing a document's only body block.
      const operations = operation.op === 'table.delete' && body.length === 1
        ? [{ op: 'insert', afterBlockId: operation.blockId, block: { kind: 'paragraph', inlines: [] } }, operation] : [operation]
      const result = await (await api(session, '/patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(session.collaborationEpoch ?? 0) },
        body: JSON.stringify({ schemaVersion: operation.op === 'table.cells.merge' || operation.op === 'table.cell.split' ? 'hcd-patch/67' : 'hcd-patch/4', documentId: session.documentId, patchId: `table-${crypto.randomUUID()}`, baseRevision: current.revision, operations }),
      })).json() as { revision: number; dirtyNodeIds?: string[] }
      if (operation.op === 'table.cell.activate') {
        pendingCell.current = result.dirtyNodeIds?.[0] ?? null
        if (pendingCell.current) pendingTableFocus.current = false
      }
      const [saved, access] = await Promise.all([
        resources.projection(result.revision),
        api(session, '/auth').then(response=>response.json() as Promise<{ collaborationEpoch: number }>),
      ])
      if ('historyDirection' in detail && restored) {
        const history = tableHistory.current
        if (detail.historyDirection === 'undo') { history.past.pop(); history.future = keepHistory([...history.future, restored]) }
        else { history.future.pop(); history.past = keepHistory([...history.past, restored]) }
      } else {
        const old = 'action' in detail ? body.find(block => block.blockId === detail.blockId) : undefined
        const changed = saved.blocks.find(block => old ? block.blockId === old.blockId : !body.some(previous => previous.blockId === block.blockId) && block.region === 'body')
        if (changed && operation.op === 'table.insert') {
          pendingCell.current = changed.editableTextNodeIds?.[0] ?? null
          if (pendingCell.current) pendingTableFocus.current = false
        }
        if (changed || old && 'action' in detail && detail.action === 'deleteTable') {
          const blocks = changed ? saved.blocks.filter(block => block.region === 'body') : body
          const blockId = changed?.blockId ?? old!.blockId
          const index = blocks.findIndex(block => block.blockId === blockId)
          const step = { blockId, afterBlockId: index > 0 ? blocks[index - 1].blockId : null,
            beforeRevision: current.revision, beforeHash: old?.blockHash ?? null, afterRevision: result.revision, afterHash: changed?.blockHash ?? null }
          tableHistory.current = { past: keepHistory([...tableHistory.current.past, step]), future: [] }
        }
      }
      refreshHistory(value => value + 1)
      checkpointedEdits.current = localEdits.current
      setRevision(result.revision); setStatus('已保存'); setTableTextFocused(false); activeTableBlock.current = null
      onEpochChange?.(access.collaborationEpoch)
    } catch (cause) {
      setStatus('操作失败')
      setError(String(cause).includes('409:') ? '文档或协作状态已变化，未提交此操作。请等待同步后重新选择表格位置。' : String(cause))
    } finally { tableBusyRef.current = false; setTableBusy(false) }
  }
  tableAction.current = detail => { void mutateTable(detail) }
  historyBridge.current = {
    can: direction => !readOnly && !historyActive && !!(direction === 'undo' ? tableHistory.current.past : tableHistory.current.future).length,
    travel: direction => { void mutateTable({ historyDirection: direction }) },
    edited: () => { if (tableHistory.current.future.length) { tableHistory.current.future = []; refreshHistory(value => value + 1) } },
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
  function explainOutline(event: React.MouseEvent, item: typeof visibleOutline[number]) {
    if (!canTransfer || historyActive || !editor || item.pos === null) return
    event.preventDefault()
    const pos = item.pos
    const following = outline.find(heading => heading.pos > pos && heading.level <= item.level)
    setMenu({ x: event.clientX, y: event.clientY, selectedText: '', section: { from: pos + 1, to: following?.pos ?? editor.state.doc.content.size } })
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
      const url = value.startsWith('#') ? null : new URL(value)
      const href = url?.href ?? value
      if (url && !['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) || /[\u0000-\u001f\u007f-\u009f\\]/u.test(value) || new TextEncoder().encode(href).length > 2048) throw new Error('链接支持 http、https、mailto、tel 或 #页内位置，且不能超过 2048 字节')
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
      setLinkOpen(false)
      setError('')
    } catch (cause) { setError(cause instanceof TypeError ? '请输入完整链接或 #页内位置' : String(cause)) }
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
    const live = findSemanticText(editor.state.doc, query)
    return { revision: revision ?? 0, hits: live.slice(0, SEARCH_RESULT_LIMIT), truncated: live.length > SEARCH_RESULT_LIMIT }
  }
  function replaceContent(query: string, replacement: string, hit?: SearchHit): number {
    if (!editor?.isEditable || readOnly || historyActive) return 0
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
    if (historyActive) {
      locateHistoricalBlock(hit.nodeId)
      return
    }
    if (!editor || hit.position === undefined) return
    const from = Math.min(hit.position, editor.state.doc.content.size)
    editor.commands.setTextSelection({ from, to: Math.min(from + (hit.matchLength || 1), editor.state.doc.content.size) })
    editor.view.domAtPos(from).node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  useEmbeddedSearchLocation(session, revision, !!editor && editorSynced && boundDocument.current === ydoc, async ({ hit, query }) => {
    if (!editor) return
    if (historyActive) await returnToCurrent()
    setFocused(false)
    const blockId = hit.blockId
    const host = editor.view.dom.closest('.workspace')
    const block = blockId && editor.view.dom.querySelector(`[data-hcd-block-id="${CSS.escape(blockId)}"]`)
    const embedded = wordPreview || hit.region !== 'body' || !block || block.classList.contains('hcd-opaque')
    if (blockId && !embedded) {
      const end = hit.offset + Array.from(query).length
      let found = ''
      editor.state.doc.descendants(node => {
        if (node.attrs.hcdBlockId !== blockId) return true
        found = Array.from(node.textContent).slice(hit.offset, end).join('')
        return false
      })
      if (found.toLowerCase() !== query.toLowerCase()) throw new Error('此处正文已更新，请重新搜索。')
      locateDocumentTransfer(editor, { kind: 'text', spans: [{ blockId, start: hit.offset, end, textHash: '' }] })
      if (editor.isEditable) editor.view.focus()
      return
    }
    const selectors = [`[data-hcd-id="${CSS.escape(hit.nodeId)}"]`]
    if (blockId) selectors.push(`[data-hcd-block-id="${CSS.escape(blockId)}"]`)
    for (let attempt = 0; attempt < 25 && host?.isConnected; attempt++) {
      const frames = host.querySelectorAll<HTMLIFrameElement>('.word-page-preview iframe, .hcd-opaque-preview iframe')
      for (const frame of frames) {
        const target = selectors.map(selector => frame.contentDocument?.querySelector<HTMLElement>(selector)).find(Boolean)
        if (!target?.isConnected || !frame.getClientRects().length) continue
        frame.scrollIntoView({ block: 'center' })
        target.scrollIntoView({ block: 'center' })
        target.animate([{ backgroundColor: '#eee0a1' }, { backgroundColor: 'transparent' }], { duration: 1700 })
        return
      }
      await new Promise(resolve => setTimeout(resolve, 80))
    }
    throw new Error('找不到搜索结果对应的原文，请重新搜索。')
  }, setError)
  function askAgent(task: string) {
    if (!editor || readOnly || historyActive) return
    const selection = editor.state.selection
    let blockId: string | undefined
    for (let depth = selection.$from.depth; depth > 0; depth--) {
      if (selection.$from.node(depth).attrs.hcdBlockId) { blockId = selection.$from.node(depth).attrs.hcdBlockId; break }
    }
    const selectedText = menu?.selectedText || editor.state.doc.textBetween(selection.from, selection.to, '\n')
    setFocused(false)
    const targetVersion = revision !== null && session.collaborationEpoch !== undefined
      ? { revision, collaborationEpoch: session.collaborationEpoch } : undefined
    requestTask(task, { ...(blockId ? { blockId } : {}), ...(selectedText ? { selectedText } : {}), format: session.format }, { targetVersion })
  }
  const explainOnCanvas: MenuAction = {
    label: '在白板讲解', icon: <Sparkles size={15} />, accent: true,
    disabled: !canTransfer || !editor || !editorSynced || historyActive || (!menu?.section && !menu?.span && editor.state.selection.empty),
    action: () => {
      const epoch = session.collaborationEpoch
      if (!transfers || !editor || epoch === undefined) return
      const range = menu?.section || menu?.span
      void captureDocumentTransfer(editor, range?.from, range?.to).then(selection => {
        setFocused(false)
        transfers.begin(session, selection, epoch)
        if (!session.hostIntegration) setPanelOpen(true)
      }).catch(cause => setError(String(cause)))
    },
  }
  commandTrigger.current = event => {
    if (event.key !== '/' || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || readOnly || historyActive || !editor
      || !editor.state.selection.empty || !editor.state.selection.$from.parent.isTextblock || editor.state.selection.$from.parent.content.size !== 0) return false
    const point = editor.view.coordsAtPos(editor.state.selection.from)
    setMenu(null); setCommand({ x: point.left, y: point.bottom + 7 })
    return true
  }
  const agentActions: MenuAction[] = session.hideNativeChat ? [] : [
    { label: '用 Agent 修改…', icon: <Sparkles size={15} />, accent: true, disabled: readOnly || historyActive, action: () => askAgent('请修改当前选中内容：') },
    { label: '润色当前段落', icon: <WandSparkles size={15} />, disabled: readOnly || historyActive, action: () => askAgent('润色当前选中内容；未选中文字时只润色当前段落。保留原意、所有数字、日期和格式。') },
    { label: '翻译为英文', icon: <Languages size={15} />, disabled: readOnly || historyActive, action: () => askAgent('将当前选中内容翻译为英文；未选中文字时只翻译当前段落。保留数字、日期和原有格式。') },
  ]
  const commandActions: MenuAction[] = [...agentActions,
    { label: '正文', icon: <Pilcrow size={15} />, action: () => { editor?.commands.setParagraph(); editor?.view.focus() } },
    { label: '二级标题', icon: <Heading2 size={15} />, action: () => { editor?.commands.setHeading({ level: 2 }); editor?.view.focus() } },
    { label: '项目符号', icon: <List size={15} />, action: () => { editor?.commands.toggleBulletList(); editor?.view.focus() } },
  ].filter(action => session.format !== 'txt' || !['二级标题', '项目符号'].includes(action.label))
  const actions: MenuAction[] = [
    ...agentActions,
    ...(session.format === 'docx' && menu?.span && !readOnly && !historyActive ? [{
      label: '新建批注', icon: <MessageSquarePlus size={15} />, action: () => void beginWordComment(menu.span),
    }] : []),
    ...(canTransfer ? [explainOnCanvas] : []),
    ...(hostWorkspace && editor && !historyActive ? [{ label: '引用段落到白板', action: () => {
      const pos = menu?.section?.from ?? editor.state.selection.from
      const resolved = editor.state.doc.resolve(pos)
      for (let level = resolved.depth; level > 0; level--) {
        const blockId = resolved.node(level).attrs.hcdBlockId
        if (blockId) { hostWorkspace.chooseBoard({ sourceId: session.documentId, blockId }); return }
      }
      setError('请先保存并选择要引用的段落。')
    } }] : []),
    { label: '复制选中内容', separated: true, action: () => { if (editor) void navigator.clipboard.writeText(menu?.selectedText || editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, '\n')).catch(cause => setError(String(cause))) } },
    { label: '粘贴文本', disabled: readOnly, action: () => { if (editor) void navigator.clipboard.readText().then(text => editor.chain().focus().insertContent(text).run()).catch(cause => setError(String(cause))) } },
    { label: '新增段落', disabled: readOnly, separated: true, action: insertEmptyParagraph },
    { label: '删除段落', disabled: readOnly, action: deleteCurrentBlock },
    { label: '设为标题', secondary: true, disabled: readOnly, action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: '设为列表', secondary: true, disabled: readOnly, action: () => editor?.chain().focus().toggleBulletList().run() },
    { label: '加粗', secondary: true, disabled: readOnly, separated: true, action: () => editor?.chain().focus().toggleBold().run() },
    { label: '斜体', secondary: true, disabled: readOnly, action: () => editor?.chain().focus().toggleItalic().run() },
    { label: '设置链接', secondary: true, disabled: readOnly, action: openLink },
    { label: '移除链接', secondary: true, disabled: readOnly || !editor?.isActive('link'), action: () => editor?.chain().focus().extendMarkRange('link').unsetLink().run() },
    { label: '上移段落', secondary: true, disabled: readOnly, separated: true, action: () => moveBlock(-1) },
    { label: '下移段落', secondary: true, disabled: readOnly, action: () => moveBlock(1) },
    { label: '撤销', secondary: true, disabled: readOnly || !editor?.can().undo(), separated: true, action: () => editor?.commands.undo() },
    { label: '重做', secondary: true, disabled: readOnly || !editor?.can().redo(), action: () => editor?.commands.redo() },
  ]
  useResourceNavigation(session, !!editor && editorSynced && revision !== null && boundDocument.current === ydoc, async ({ ref, preview, ai }) => {
    if (!editor || ref.anchor.kind !== 'document') throw new Error('文档编辑器尚未就绪。')
    if (historyActive) await returnToCurrent()
    setFocused(false)
    if (revision !== preview.revision) throw new Error('源文档已更新，请刷新引用再进入。')
    const blockId = ref.anchor.blockId
    if (blockId) {
      let position: number | null = null, length = 0
      editor.state.doc.descendants((node, pos) => { if (node.attrs.hcdBlockId === blockId) { position = pos; length = node.content.size; return false } })
      if (position === null) throw new Error('引用段落已变化，请刷新白板预览。')
      editor.commands.setTextSelection({ from: position + 1, to: position + 1 + length })
      if (!ai && editor.isEditable) editor.commands.focus(undefined, { scrollIntoView: false })
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const host = editor.view.dom.closest('.workspace')
      let target = host?.querySelector<HTMLElement>(`[data-hcd-block-id="${CSS.escape(blockId)}"]`)
      if (!target?.getClientRects().length) for (const frame of host?.querySelectorAll('iframe') || []) {
        try { const found = frame.contentDocument?.querySelector<HTMLElement>(`[data-hcd-block-id="${CSS.escape(blockId)}"]`); if (found) { target = found; break } } catch { /* Isolated preview. */ }
      }
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    if (ai && hostWorkspace) {
      if (!hostWorkspace.ask || session.collaborationEpoch === undefined) throw new Error('此工作台未启用选区 AI。')
      if (!blockId) throw new Error('请在文档中选择要编辑的段落。')
      hostWorkspace.ask({ documentId: session.documentId, revision: preview.revision, collaborationEpoch: session.collaborationEpoch,
        target: await captureDocumentTransfer(editor) })
      return
    }
    if (ai) requestTask('请结合这处白板引用，继续编辑源文档。', blockId ? { blockId } : undefined, {
      targetVersion: session.collaborationEpoch === undefined ? undefined : { revision: preview.revision, collaborationEpoch: session.collaborationEpoch },
    })
  })
  useTransferNavigation(session, revision, !!editor && editorSynced && boundDocument.current === ydoc, async location => {
    if (!editor || location.kind === 'canvas') return
    if (historyActive) await returnToCurrent()
    setFocused(false)
    locateDocumentTransfer(editor, location)
    if (session.hostIntegration && editor.isEditable) editor.view.focus()
  })
  const prepareEdit = async () => {
        if (epochDraft) throw new Error('请先核对本地草稿。')
        if (session.hideNativeChat && hasSynced.current && localEdits.current === checkpointedEdits.current) return
        const version = localEdits.current
        const savedRevision = await collaborationCheckpoint(provider)
        if (version === localEdits.current) {
          checkpointedEdits.current = version
          rememberCheckpointSelection(savedRevision)
        }
      }
  useWorkflowPreparation(session, prepareEdit, !session.hideNativeChat || documentViewReady)
  const marginReview = !panelOpen && !focused && !historyActive && rightPanel === 'word-review' && session.format === 'docx'
  const dockedRightOpen = !focused && (panelOpen || !!rightPanel && !marginReview)
  const fileHeader = <EditorHeader session={session} revision={selectedRevision ?? revision} status={historyActive ? '历史只读' : status} onClose={onClose} onSearch={() => setSearchOpen(true)} focused={focused} onFocus={() => setFocused(value => !value)} beforeExport={historyActive ? async () => selectedRevision : save}
      presence={layout.showCollaborators && <details className="presence"><summary aria-label={`${localizeSource(locale, "在线协作者")} · ${presence.length}`}><span className="presence-avatars">{presence.slice(0, 3).map(user => <span key={user.id} className="avatar" title={user.name} style={{ background: user.color }}>{user.name.slice(0, 1)}</span>)}</span><span>{presence.length} <LocalText source={" 人在线"} /></span></summary><div className="presence-menu"><strong><LocalText source={"在线协作者"} /></strong>{presence.map(user => <div key={user.id} className="presence-person"><span className="avatar" style={{ background: user.color }}>{user.name.slice(0, 1)}</span><span>{user.name}{user.id === localUser.id ? localizeSource(locale, '（你）') : ''}</span>{user.connections > 1 && <small>{user.connections} <LocalText source={" 个窗口"} /></small>}</div>)}</div></details>} />
  return <div data-format={session.format} data-document-scope={session.scope} data-hcd-history={historyActive ? 'true' : undefined} className={`workspace semantic-workspace ${embedded ? 'embedded' : ''} ${layout.compact ? 'compact-header' : ''} ${layout.showOutline && !focused ? '' : 'outline-hidden'} ${dockedRightOpen ? '' : 'right-hidden'} ${focused ? 'focus-mode' : ''}`}>
    {!session.integratedToolbar && layout.showHeader && fileHeader}
    {session.integratedToolbar && focused && <button className="integrated-exit-focus" onClick={() => setFocused(false)}><LocalText source="退出专注模式" /></button>}
    <DocumentSearch open={searchOpen} onOpen={() => setSearchOpen(true)} onClose={() => setSearchOpen(false)} search={searchContent} onSelect={navigateSearch} onReplace={readOnly || historyActive ? undefined : replaceContent} refreshKey={`${searchVersion}:${selectedRevision ?? 'current'}:${historyLoading}`} />
    {wordPicture && !historyActive && <WordPictureLayoutDialog target={wordPicture}
      onClose={() => setWordPicture(null)} onSave={layout => savePictureLayout(wordPicture, layout)} />}
    <div className="layout editor-layout">
      {!session.integratedToolbar && <DocumentPanelTools session={session} leftOpen={layout.showOutline && !focused} focused={focused} onExitFocus={() => setFocused(false)} onToggleLeft={() => { setFocused(false); setLayoutOption('showOutline', !layout.showOutline || focused) }} />}
      <WorkspaceDrawers leftOpen={layout.showOutline && !focused} rightOpen={dockedRightOpen} onCloseLeft={() => setLayoutOption('showOutline', false)} onCloseRight={() => { setPanelOpen(false); setRightPanel(null) }} />
      <LeftPanelShell session={session} hidden={!layout.showOutline || focused} label="文档目录" onClose={() => setLayoutOption('showOutline', false)} onSearch={() => setSearchOpen(true)} onWorkspace={onClose} onSettings={() => showRightPanel('settings')}><div className="panel-head"><h2><LocalText source="文档大纲" /></h2></div>{visibleOutline.length ? <nav>{visibleOutline.map(item => <button key={item.key} className={`outline-level-${item.level}`} onClick={() => navigateOutline(item)} onContextMenu={event => explainOutline(event, item)}>{item.text}</button>)}</nav> : <p><LocalText source={historyActive ? historyLoading ? "正在加载历史版本…" : "此版本暂无标题" : "暂无标题。将段落设为标题后会显示在这里。"} /></p>}</LeftPanelShell>
      <section className="content-shell" aria-label={localizeSource(locale, '文档内容')}>
        <DraftRecovery protection={draftProtection} currentText={editor?.getText() || ''} onError={setError} />
        {epochDraft && <section className="epoch-draft-conflict" role="alert" aria-label={localizeSource(locale, '协同版本变化，草稿已保留')}>
          <strong><LocalText source="协同版本变化，草稿已保留" /></strong><p><LocalText source="当前有未确认保存的本地修改。请先下载或复制草稿，再与最新版本核对。" /></p>
          <div><label><LocalText source="本地草稿" /><textarea aria-label={localizeSource(locale, '本地草稿')} readOnly value={editor?.getText() || ''} /></label><label><LocalText source="最新文档" /><textarea aria-label={localizeSource(locale, '最新文档')} readOnly value={epochDraft.current?.blocks.filter(block => block.region === 'body').map(block => block.content.inlines.map(inline => inline.text).join('')).join('\n\n') || ''} /></label></div>
          <button onClick={() => {
            if (!editor) return
            const url = URL.createObjectURL(new Blob([JSON.stringify({ documentId: session.documentId, format: session.format, baseRevision: revision, collaborationEpoch: session.collaborationEpoch, blocks: jsonToSnapshot(editor.getJSON()) }, null, 2)], { type: 'application/json' }))
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${session.documentId}-local-draft.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
          }}><LocalText source="下载本地草稿" /></button><button onClick={() => { if (window.confirm(localizeSource(locale, '切换后将关闭这份本地草稿。请确认已下载或复制。'))) onEpochChange?.(epochDraft.epoch) }}><LocalText source="切换到最新版本" /></button>
        </section>}
        {!focused && <ContentToolbar fileMenu={session.integratedToolbar ? fileHeader : undefined} onSearch={() => setSearchOpen(true)} activeTab={activeTab} onTab={tab => {
          setActiveTab(tab)
          if (session.integratedToolbar && !layout.showToolbar) setLayoutOption('showToolbar', true)
          if (tab === 'revisions') showRightPanel('revisions')
          if (tab === 'review') setRightPanel('word-review')
        }} expanded={layout.showToolbar} onToggle={() => setLayoutOption('showToolbar', !layout.showToolbar)} readOnly={readOnly || historyActive} format={session.format} />}
    {layout.showToolbar && !focused && (session.scope === 'write' && !epochDraft && !historyActive || session.integratedToolbar && activeTab === 'view') && <DocumentRibbon key={activeTab} adaptive={!!session.integratedToolbar} label={localizeSource(locale, "编辑工具栏")}>
      {!['txt', 'docx'].includes(session.format) && activeTab === 'home' && <><div className="tool-group"><button onClick={() => editor?.commands.undo()} disabled={readOnly || !editor?.can().undo()}><LocalText source={"↶ 撤销"} /></button><button onClick={() => editor?.commands.redo()} disabled={readOnly || !editor?.can().redo()}><LocalText source={"↷ 重做"} /></button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().setParagraph().run()} disabled={readOnly || tableTextFocused}><LocalText source={"正文"} /></button><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={readOnly || tableTextFocused}><LocalText source={"标题"} /></button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().toggleBold().run()} disabled={readOnly || tableTextFocused}><LocalText source={"𝐁 加粗"} /></button><button onClick={() => editor?.chain().focus().toggleItalic().run()} disabled={readOnly || tableTextFocused}><LocalText source={"𝑰 斜体"} /></button><button onClick={openLink} disabled={readOnly || tableTextFocused}><LocalText source={"链接"} /></button></div><div className="tool-group"><button onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={readOnly || tableTextFocused}><LocalText source={"项目符号"} /></button><button onClick={() => editor?.chain().focus().toggleOrderedList().run()} disabled={readOnly || tableTextFocused}><LocalText source={"编号"} /></button></div></>}
      {session.format === 'docx' && activeTab === 'home' && <>
        <div className="tool-group"><button onClick={() => editor?.commands.undo()} disabled={readOnly || !editor?.can().undo()}><LocalText source="撤销" /></button><button onClick={() => editor?.commands.redo()} disabled={readOnly || !editor?.can().redo()}><LocalText source="重做" /></button></div>
        <RibbonGroup label="字体" priority={0}><WordFormatTools editor={editor} readOnly={readOnly || tableTextFocused || historyActive}/></RibbonGroup>
        <RibbonGroup label="段落" priority={0}><WordFormatTools section="paragraph" editor={editor} readOnly={readOnly || tableTextFocused || historyActive}/></RibbonGroup>
        <div className="tool-group"><button onClick={() => editor?.chain().focus().setParagraph().run()} disabled={readOnly || tableTextFocused}><LocalText source="正文"/></button><button onClick={() => editor?.chain().focus().toggleHeading({level: 2}).run()} disabled={readOnly || tableTextFocused}><LocalText source="标题"/></button><button onClick={openLink} disabled={readOnly || tableTextFocused}><LocalText source="链接"/></button></div>
      </>}
      {!['txt', 'md'].includes(session.format) && activeTab === 'home' && <RibbonGroup label="主题字体" priority={3}><BlockFontPicker editor={editor} faces={themeFaces} disabled={readOnly || tableTextFocused || historical !== null} /></RibbonGroup>}
      {session.format !== 'txt' && (activeTab === 'home' || activeTab === 'layout') && <div className="tool-group"><button onClick={() => moveBlock(-1)} disabled={readOnly || tableTextFocused}><LocalText source={"段落上移"} /></button><button onClick={() => moveBlock(1)} disabled={readOnly || tableTextFocused}><LocalText source={"段落下移"} /></button></div>}
      {session.format !== 'txt' && activeTab === 'insert' && <><div className="tool-group"><button disabled={readOnly || !editor?.can().undo()} onClick={() => editor?.commands.undo()}><LocalText source="↶ 撤销" /></button><button disabled={readOnly || !editor?.can().redo()} onClick={() => editor?.commands.redo()}><LocalText source="↷ 重做" /></button></div><div className="tool-group"><button onClick={insertEmptyParagraph} disabled={readOnly}><LocalText source={"＋ 新增段落"} /></button><InsertTable disabled={readOnly} onPrepare={() => { insertionBlock.current = selectedBlock() }} onInsert={(rows, columns) => void mutateTable({ rows, columns })} /><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={readOnly || tableTextFocused}><LocalText source={"插入标题"} /></button><button onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={readOnly || tableTextFocused}><LocalText source={"插入列表"} /></button></div><div className="tool-group"><button onClick={openLink} disabled={readOnly || tableTextFocused}><LocalText source={"插入链接"} /></button><button onClick={deleteCurrentBlock} disabled={readOnly || tableTextFocused}><LocalText source={"删除段落"} /></button></div></>}
      {activeTab === 'view' && <><label className="mode"><input className="left-sidebar-toggle" type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} /><LocalText source={"显示大纲"} /></label><button className="right-sidebar-toggle" aria-pressed={rightPanel==='settings'} onClick={() => rightPanel==='settings' ? setRightPanel(null) : showRightPanel('settings')}><LocalText source={"界面设置"} /></button></>}
      {session.format === 'docx' && ['layout', 'references'].includes(activeTab) && <RibbonGroup label={activeTab === 'layout' ? '页面设置' : '目录与脚注'} priority={0}><OfficeFeatureTools session={session} mode={activeTab === 'layout' ? 'layout' : 'references'} disabled={readOnly || historyActive} beforeEdit={save} afterEdit={setRevision} editor={editor}/></RibbonGroup>}
      {activeTab === 'layout' && session.format === 'docx' && <RibbonGroup label="段落布局" priority={0}><WordFormatTools section="paragraph" editor={editor} readOnly={readOnly || tableTextFocused || historyActive}/></RibbonGroup>}
      {activeTab === 'references' && <RibbonGroup label="链接与跨文件引用" priority={0}>
        <button disabled={readOnly || tableTextFocused} onClick={openLink}><LocalText source="插入链接"/></button>
        {canTransfer && <button disabled={explainOnCanvas.disabled} onClick={explainOnCanvas.action}><LocalText source="在白板讲解"/></button>}
        {hostWorkspace && <button disabled={!editor || historyActive} onClick={() => actions.find(action => action.label === '引用段落到白板')?.action()}><LocalText source="引用段落到白板"/></button>}
      </RibbonGroup>}
      {activeTab === 'review' && session.format === 'docx' && <div className="tool-group"><button aria-pressed={rightPanel === 'word-review'} onClick={() => setRightPanel(rightPanel === 'word-review' ? null : 'word-review')}><LocalText source="批注与修订窗格"/></button><button onClick={() => void beginWordComment()} disabled={readOnly || historyActive}><MessageSquarePlus size={15} /><LocalText source="新建批注" /></button></div>}
      {activeTab === 'revisions' && <><button onClick={() => void save()} disabled={readOnly}><LocalText source={"创建保存点"} /></button><button onClick={() => showRightPanel('revisions')}><LocalText source={"查看修订历史"} /></button><span className="ribbon-note"><LocalText source={"当前版本 r"} />{revision ?? '…'}</span></>}
      {session.format === 'txt' && <div className="tool-group"><button disabled={readOnly || !editor?.can().undo()} onClick={() => editor?.commands.undo()}><LocalText source="↶ 撤销" /></button><button disabled={readOnly || !editor?.can().redo()} onClick={() => editor?.commands.redo()}><LocalText source="↷ 重做" /></button><button aria-pressed={wrapText} onClick={() => setWrapText(value => !value)}><LocalText source="自动换行" /></button><span className="ribbon-note"><LocalText source="纯文本 · 等宽显示" /></span></div>}
      {activeTab !== 'revisions' && session.scope === 'write' && !historyActive && <button className="primary save-trigger" onClick={() => void save()} disabled={readOnly}><LocalText source={"保存点"} /></button>}
    </DocumentRibbon>}
      <CanvasViewport hidden={historyActive} scrollStateKey={documentViewReady ? tabStateKey(session, 'document-scroll') : null}>
      <div className="word-document-layout" data-review-open={marginReview}><div className="word-document-page"><main hidden={wordPreview && revision !== null} className={`document ${session.format === 'txt' && !wrapText ? 'text-no-wrap' : ''}`} onClickCapture={event => {
        const link = (event.target instanceof HTMLElement ? event.target.closest('a') : null)?.getAttribute('href')
        if (!link || !decodeTransferLink(link) || !transfers) return
        event.preventDefault(); event.stopPropagation()
        void transfers.openSource(session, link).catch(cause => setError(String(cause)))
      }} onContextMenu={event => {
        event.preventDefault()
        const selection = window.getSelection()
        const selectedAtPoint = selection && selection.rangeCount > 0 && Array.from(selection.getRangeAt(0).getClientRects()).some(rect =>
          event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)
        const selectedText = selectedAtPoint ? selection?.toString() || '' : ''
        let span: { from: number; to: number } | undefined
        if (editor) {
          const point = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
          if (point && !selectedText) editor.commands.setTextSelection(point.pos)
          if (selectedText && selection) {
            const range = selection.getRangeAt(0)
            if (editor.view.dom.contains(range.startContainer) && editor.view.dom.contains(range.endContainer)) {
              const from = editor.view.posAtDOM(range.startContainer, range.startOffset)
              const to = editor.view.posAtDOM(range.endContainer, range.endOffset)
              if (from >= 0 && to > from) span = { from, to }
            }
          }
        }
        setMenu({ x: event.clientX, y: event.clientY, selectedText, span })
      }}>{themeCss && <style>{themeCss}</style>}{session.format === 'docx' && editor && <WordRunningMargin editor={editor} session={session} kind="header" />}{session.format === 'docx' && editor && <WordOfficeView editor={editor} session={session} revision={selectedRevision ?? revision} placement="before"/>}<EditorContent editor={editor} />{session.format === 'docx' && editor && <WordOfficeView editor={editor} session={session} revision={selectedRevision ?? revision} placement="after"/>}{session.format === 'docx' && editor && <WordRunningMargin editor={editor} session={session} kind="footer" />}{editor && <BubbleMenu editor={editor} shouldShow={({ view, element, state }) => session.format !== 'txt' && !historyActive && !readOnly && !searchOpen && !state.selection.empty && (view.hasFocus() || element.contains(element.ownerDocument.activeElement))} className="selection-menu"><button onClick={() => editor.chain().focus().toggleBold().run()} aria-label={localizeSource(locale, "加粗")}>𝐁</button><button onClick={() => editor.chain().focus().toggleItalic().run()} aria-label={localizeSource(locale, "斜体")}>𝑰</button><button onClick={openLink} aria-label={localizeSource(locale, "设置链接")}>🔗</button></BubbleMenu>}</main>{wordPreview && editor && revision !== null && <WordPagePreview session={session} revision={revision} editor={editor} />}</div>
        {marginReview && <aside className="word-review-margin" aria-label={localizeSource(locale, 'Word 审阅')}>
          <WordReviewPanel session={session} revision={revision} historical={null} writable={!readOnly} draft={commentDraft} editor={editor} margin
            onClose={() => setRightPanel(null)} onCancelDraft={() => setCommentDraft(null)} onLocate={locateWordComment} onWrite={writeWordReview} />
        </aside>}
      </div></CanvasViewport>
      {historyActive && <RevisionWorkspace session={session} selected={selectedRevision} historical={historical} current={comparisonCurrent} comparing={comparing} loading={historyLoading || (comparing && !editorSynced)} error={historyError} metadata={revisionMetadata} canRestore={session.scope === 'write' && selectedRevision < (revision ?? 0)} restoring={restoring} onCompare={setComparing} onReturn={returnToCurrent} onRetry={() => void showRevision(selectedRevision)} onRestore={() => void restoreHistorical()} />}
      </section>
      {!session.hideNativeChat && <AgentPanel beforeRun={prepareEdit} registerPreparation={false} />}
      {historyActive && !panelOpen && !focused && rightPanel === 'word-review' && session.format === 'docx' && <WorkspacePanel side="right" className="workspace-sidebar" aria-label={localizeSource(locale, 'Word 审阅')}>
        <WordReviewPanel session={session} revision={revision} historical={selectedRevision} writable={!readOnly && !historyActive} draft={commentDraft}
          onClose={() => setRightPanel(null)} onCancelDraft={() => setCommentDraft(null)} onLocate={locateWordComment} onWrite={writeWordReview} />
      </WorkspacePanel>}
      {!panelOpen && !focused && (rightPanel === 'settings' || rightPanel === 'revisions') && <WorkspacePanel side="right" className="workspace-sidebar" aria-label={localizeSource(locale, rightPanel === 'settings' ? '界面设置' : '修订历史')}>{rightPanel === 'settings' && <section className="appearance-panel"><div className="panel-head"><h2><LocalText source={"界面设置"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "隐藏右侧栏")} onClick={() => setRightPanel(null)}><CollapseSidebarIcon /></button></div><LocaleSelect /><AppearanceSelect />{!session.integratedToolbar && <label><LocalText source={"显示顶部栏"} /><input type="checkbox" checked={layout.showHeader} onChange={event => setLayoutOption('showHeader', event.target.checked)} /></label>}<label><LocalText source={"显示操作栏"} /><input type="checkbox" checked={layout.showToolbar} onChange={event => setLayoutOption('showToolbar', event.target.checked)} /></label><label><LocalText source={"显示协作者"} /><input type="checkbox" checked={layout.showCollaborators} onChange={event => setLayoutOption('showCollaborators', event.target.checked)} /></label><label><LocalText source={"显示文档目录"} /><input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} /></label><fieldset><legend><LocalText source={"头部布局"} /></legend><label><input type="radio" name="header-density" checked={layout.compact} onChange={() => setLayoutOption('compact', true)} /><LocalText source={"紧凑"} /></label><label><input type="radio" name="header-density" checked={!layout.compact} onChange={() => setLayoutOption('compact', false)} /><LocalText source={"标准"} /></label></fieldset>{permits(session, 'history.view') && <button className="open-revisions" onClick={() => showRightPanel('revisions')}><LocalText source={"查看修订历史"} /></button>}</section>}
        {rightPanel === 'revisions' && <section className="revision-panel"><div className="panel-head"><h2><LocalText source={"◷ 修订历史"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "隐藏右侧栏")} onClick={() => setRightPanel(null)}><CollapseSidebarIcon /></button></div><p><LocalText source="点击版本，在中央预览或与当前内容对比。" /></p>
        <div className="history">{history.slice().reverse().map(item => <button key={item.revision} data-revision={item.revision} aria-pressed={selectedRevision === item.revision} onClick={() => void showRevision(item.revision)} title={item.patchId}><span className="revision-avatar" title={item.authorName || (localizeSource(locale, item.revision === 0 ? '导入' : '作者未记录'))} style={item.authorId ? { background: presenceColor(item.authorId) } : undefined}>{item.authorName?.slice(0, 1) || (item.revision === 0 ? localizeSource(locale, '导入').slice(0, 1) : '?')}</span><span className="revision-detail"><strong>r{item.revision} <small>{item.createdAtEpochMs ? new Date(item.createdAtEpochMs).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</small></strong><small>{item.authorName || (localizeSource(locale, item.revision === 0 ? '初始导入' : '作者未记录'))} · {localizeSource(locale, item.revision === 0 ? '导入' : item.patchId?.startsWith('restore-') ? '恢复版本' : item.patchId === 'editor-projection' ? '编辑投影' : '内容更新')}</small><span><LocalText source={"查看版本"} /></span></span></button>)}
          {nextBefore !== null && nextBefore !== undefined && <button onClick={() => void loadOlderRevisions()}><LocalText source={"加载更早的修订"} /></button>}
        </div>
        {historyActive && <button className="return-current" onClick={returnToCurrent}><LocalText source="返回当前" /></button>}
        </section>}</WorkspacePanel>}
    </div>
    <EditorStatusbar mode={localizeSource(locale, session.format === 'docx' && readOnly && !historyActive ? "分页预览" : "连续视图")} format={session.format} revision={selectedRevision ?? revision} readOnly={readOnly || historyActive} status={historyActive ? '历史只读' : status} draftProtection={session.scope === 'write' ? draftProtection.state.document === ydoc ? draftProtection.state.status : 'loading' : undefined} />
    {menu && <ContextMenu title="文档选区" x={menu.x} y={menu.y} actions={menu.section ? [explainOnCanvas] : actions} onClose={() => setMenu(null)} />}
    {command && <CommandMenu x={command.x} y={command.y} actions={commandActions} onClose={() => { setCommand(null); editor?.commands.focus() }} />}
    {linkOpen && <div className="hcd-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setLinkOpen(false) }}><div className="hcd-dialog" role="dialog" aria-modal="true" aria-label={localizeSource(locale, "设置链接")}><h2><LocalText source={"设置链接"} /></h2><label><LocalText source={"链接地址"} /><input autoFocus type="url" value={linkHref} onChange={event => setLinkHref(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') applyLink(); if (event.key === 'Escape') setLinkOpen(false) }} placeholder="https://example.com" /></label><div className="hcd-dialog-actions"><button onClick={() => setLinkOpen(false)}><LocalText source={"取消"} /></button><button className="primary" onClick={applyLink}><LocalText source={"应用链接"} /></button></div></div></div>}
    {error && <ErrorToast message={error} onClose={() => setError('')} />}
  </div>
}
