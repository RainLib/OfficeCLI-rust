import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { checkpointContents, checkpointDigest } from './checkpointSnapshot.ts'
import { selectionTypography } from './selectionTypography.ts'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { LocalDraftBootstrap, type LocalDraftCopy } from './LocalDraftBootstrap.tsx'
import type {LocalDraftJournal} from './localDrafts.ts'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { clearPastedBlockIds, jsonToSnapshot, schemaExtensions, type Projection } from './schema.ts'
import { ContextMenu, type MenuAction } from './ContextMenu.tsx'
import { api, type Session } from './api.ts'
import { FixedViewer } from './FixedViewer.tsx'
import { ExportControl } from './ExportControl.tsx'
import { ReviewPanel } from './ReviewPanel.tsx'
import { PanelResizeHandle } from './PanelResizeHandle.tsx'
import { EditorIcon } from './EditorIcon.tsx'
import { FontSizeControl } from './FontSizeControl.tsx'
import { ImagePanel } from './ImagePanel.tsx'
import { CollaborativeImageDraftStore, imageDraftDigest } from './collaborativeImages.ts'
import { requestCoordinatedSave } from './semanticSaveClient.ts'
import type { SaveState } from './semanticSaveCoordinator.ts'
import { SemanticRecoveryPanel } from './SemanticRecoveryPanel.tsx'
import { I18nProvider, LocaleSelect, standaloneLocale, useI18n, type MessageKey, type EditorLocale } from './i18n.tsx'
import './style.css'

const UniverViewer = lazy(() => import('./UniverViewer.tsx').then(module => ({ default: module.UniverViewer })))

const palette = ['#d84a54', '#3478c0', '#9a5abb', '#13866a', '#d17d20', '#7b65d8']
type LayoutPreferences = { showHeader: boolean; showToolbar: boolean; showCollaborators: boolean; showOutline: boolean; compact: boolean }
type RevisionItem = { revision: number; patchId?: string; authorId?: string; authorName?: string; createdAtEpochMs?: number }
const defaultLayout: LayoutPreferences = { showHeader: true, showToolbar: true, showCollaborators: true, showOutline: false, compact: true }
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
  return <I18nProvider initialLocale={standaloneLocale()} persist><StandaloneApp /></I18nProvider>
}

function StandaloneApp() {
  const { locale, t } = useI18n()
  const [documentId, setDocumentId] = useState(sessionStorage.getItem('hcd-document') || '')
  const [token, setToken] = useState(sessionStorage.getItem('hcd-token') || '')
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { document.documentElement.lang = locale; document.title = t('appTitle') }, [locale, t])
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
  if (session) return <div className="hcd-surface" lang={locale}><Workspace key={`${session.documentId}:${session.collaborationEpoch ?? 0}`} session={session} onClose={() => setSession(null)} onEpochChange={epoch => setSession(previous => previous && ({ ...previous, collaborationEpoch: epoch }))} /></div>
  return <div className="hcd-surface" lang={locale}><main className="login"><div className="login-card"><div className="login-language"><LocaleSelect /></div><div className="eyebrow">OfficeCLI / HCD</div><h1>{t('workspaceTitle')}</h1><p>{t('loginHelp')}</p><label>{t('documentId')}<input value={documentId} onChange={event => setDocumentId(event.target.value)} placeholder="doc-…" /></label><label>{t('accessToken')}<textarea rows={4} value={token} onChange={event => setToken(event.target.value)} placeholder={t('tokenPlaceholder')} /></label><button onClick={() => void open()} disabled={!documentId || !token}>{t('openDocument')}</button>{error && <p className="error">{error}</p>}</div></main></div>
}

export function Workspace({ session, onClose, onEpochChange, embedded = false }: { session: Session; onClose: () => void; onEpochChange?: (epoch: number) => void; embedded?: boolean }) {
  const { t } = useI18n()
  const semantic = ['docx', 'html', 'md', 'txt'].includes(session.format)
  const [windowed, setWindowed] = useState<boolean | null>(semantic ? null : false)
  const [epoch, setEpoch] = useState(session.collaborationEpoch ?? 0)
  const [loadingError, setLoadingError] = useState('')
  useEffect(() => {
    if (!semantic) return
    let live = true
    void api(session, '').then(response => response.json()).then((manifest: { chunkCount: number }) => {
      if (live) setWindowed(manifest.chunkCount >= 4)
    }).catch(cause => { if (live) setLoadingError(String(cause)) })
    return () => { live = false }
  }, [session, semantic])
  const fullEditor = () => {
    void api(session, '/auth').then(response => response.json()).then((access: { collaborationEpoch: number }) => { setEpoch(access.collaborationEpoch); setWindowed(false) }).catch(cause => setLoadingError(String(cause)))
  }
  if (semantic && windowed === null) return <div className="embedded-loading">{loadingError || t('openingDocument')}</div>
  if (semantic && windowed) return <FixedViewer session={session} onClose={onClose} embedded={embedded} onFullEditor={fullEditor} />
  if (semantic) return <SemanticEditor key={epoch} session={{ ...session, collaborationEpoch: epoch }} onClose={onClose} onEpochChange={next => { setEpoch(next) }} embedded={embedded} onWindowed={() => setWindowed(true)} />
  if (session.format === 'xlsx') return <Suspense fallback={<div className="embedded-loading">{t('loadingWorkbook')}</div>}><UniverViewer session={session} onClose={onClose} embedded={embedded} /></Suspense>
  return <FixedViewer session={session} onClose={onClose} embedded={embedded} />
}

const emptySubscribe=()=>()=>{}
const noLocalDraft=()=> 'idle' as const
type SemanticEditorProps={session:Session;onClose:()=>void;onEpochChange?:(epoch:number)=>void;embedded:boolean;onWindowed:()=>void}
function SemanticEditor(props:SemanticEditorProps){
  const userId=props.session.userId||browserUserId()
  return <LocalDraftBootstrap session={props.session} userId={userId} onEpochChange={props.onEpochChange}>{binding=><LiveSemanticEditor {...props} ydoc={binding.document} localJournal={binding.journal} localCopies={binding.copies} localUnavailable={binding.unavailable} claimDocument={binding.claim} />}</LocalDraftBootstrap>
}
function LiveSemanticEditor({session,onClose,onEpochChange,embedded,onWindowed,ydoc,localJournal,localCopies,localUnavailable,claimDocument}:SemanticEditorProps&{ydoc:Y.Doc;localJournal:LocalDraftJournal|null;localCopies:LocalDraftCopy[];localUnavailable:boolean;claimDocument:()=>void}) {
  const { locale, t } = useI18n()
  const localDraftState=useSyncExternalStore(localJournal?.subscribe??emptySubscribe,localJournal?.snapshot??noLocalDraft)
  const imageUploadGate=useRef(false)
  const imageDrafts = useMemo(() => new CollaborativeImageDraftStore(ydoc), [ydoc])
  useSyncExternalStore(imageDrafts.subscribe, imageDrafts.snapshot)
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (session.scope==='read') return; if (imageDrafts.size || imageDrafts.saving) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [imageDrafts, session.scope])
  const [scopeReadOnly, setReadOnly] = useState(session.scope === 'read')
  const [hasDocument, setHasDocument] = useState(false)
  const [canonicalReady, setCanonicalReady] = useState(false)
  const [saveConflict, setSaveConflict] = useState<SaveState | null>(null)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const saveConflictRef = useRef(saveConflict)
  saveConflictRef.current = saveConflict
  const acceptedReceipt = useRef<{ revision: number; digest: string; imageDigest: string; pending: boolean } | null>(null)
  const semanticDirty = useRef(false)
  const semanticGeneration = useRef(0)
  const saveInFlight = useRef<Promise<number | null> | null>(null)
  const readOnly = scopeReadOnly || !hasDocument || !canonicalReady || !!saveConflict
  const [status, setStatus] = useState<MessageKey>('connecting')
  const [revision, setRevision] = useState<number | null>(null)
  const [viewRevision, setViewRevision] = useState<number | null>(null)
  const [history, setHistory] = useState<RevisionItem[]>([])
  const [nextBefore, setNextBefore] = useState<number | null | undefined>(undefined)
  const [historical, setHistorical] = useState<Projection | null>(null)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkHref, setLinkHref] = useState('')
  const [presence, setPresence] = useState<Array<{ id: string; name: string; color: string; connections: number }>>([])
  const [layout, setLayout] = useState<LayoutPreferences>(readLayout)
  const [rightPanel, setRightPanel] = useState<'settings' | 'revisions' | 'properties' | 'images' | null>(null)
  const [activeTab, setActiveTab] = useState<'home' | 'insert' | 'view' | 'revisions' | 'export'>('home')
  const [documentZoom, setDocumentZoom] = useState(100)
  const [outlineWidth, setOutlineWidth] = useState(190)
  const [sidebarWidth, setSidebarWidth] = useState(270)
  const [outline, setOutline] = useState<Array<{ pos: number; level: number; text: string }>>([])
  const lastOutline = useRef('')
  const lastSemantic = useRef<string | null>(null)
  useEffect(() => { localStorage.setItem(layoutKey, JSON.stringify(layout)) }, [layout])
  function setLayoutOption(key: keyof LayoutPreferences, value: boolean) {
    setLayout(previous => ({ ...previous, [key]: value }))
  }
  const localUser = useMemo(() => {
    const id = session.userId || browserUserId()
    return { id, clientId: ydoc.clientID, name: session.displayName?.trim() || `User ${id.slice(0, 4)}`, color: presenceColor(id) }
  }, [session.userId, session.displayName, ydoc])
  const provider = useMemo(() => new HocuspocusProvider({
    url: session.collabUrl || import.meta.env.VITE_HCD_COLLAB_URL || 'ws://127.0.0.1:8768',
    name: `${session.documentId}:${session.collaborationEpoch ?? 0}:typography2:save4`,
    document: ydoc,
    token: session.token,
  }), [session.documentId, session.collaborationEpoch, session.token, ydoc])
  const saveAbort = useMemo(() => new AbortController(), [provider])
  useEffect(() => {
    const disconnect=imageDrafts.connect()
    const unsubscribe=imageDrafts.subscribe(()=> {
      semanticGeneration.current++
      if(provider.isSynced && provider.configuration.websocketProvider.status==='connected') provider.sendStateless(JSON.stringify({type:'hcd-save-state'}))
    })
    return ()=>{unsubscribe();disconnect()}
  },[imageDrafts,provider])
  const editor = useEditor({
    extensions: [...schemaExtensions, Collaboration.configure({ document: ydoc }),
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
    editorProps: { attributes: { class: 'hcd-editor-body' }, transformPasted: (slice, view) => clearPastedBlockIds(slice, (view.state.storedMarks || view.state.selection.$from.marks()).find(mark => mark.type.name === 'hcdSource')?.attrs.nodeId) },
    onUpdate: ({ editor: changedEditor }) => {
      const semantic = checkpointContents(jsonToSnapshot(changedEditor.getJSON()))
      if (lastSemantic.current !== null && semantic !== lastSemantic.current) { semanticGeneration.current++; semanticDirty.current = true; if (!scopeReadOnly) setStatus('editing') }
      lastSemantic.current = semantic
      const headings: Array<{ pos: number; level: number; text: string }> = []
      changedEditor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') headings.push({ pos, level: node.attrs.level || 1, text: node.textContent || '' })
      })
      const serialized = JSON.stringify(headings)
      if (serialized !== lastOutline.current) { lastOutline.current = serialized; setOutline(headings) }
    },
  }, [ydoc])
  const editorRef = useRef(editor)
  editorRef.current = editor
  const selectedFont = useEditorState({ editor, selector: ({ editor: current }) => current ? selectionTypography(current.state) : null })
  useEffect(() => {
    if (!editor) return
    const storage = editor.storage as unknown as { hcdIdentity: { locale: EditorLocale } }
    storage.hcdIdentity.locale = locale
    editor.view.dispatch(editor.state.tr.setMeta('hcd-ui-locale', locale))
  }, [editor, locale])
  useEffect(() => {
    editor?.setEditable(!readOnly)
  }, [editor, readOnly])
  useEffect(() => {
    const connection = ({ status: next }: { status: string }) => { setStatus(saveConflictRef.current ? 'saveConflict' : next === 'connected' ? 'connected' : 'connecting'); refreshPresence() }
    const synced = ({ state }: { state: boolean }) => { if (state) { setHasDocument(true); setStatus(saveConflictRef.current ? 'saveConflict' : 'synced'); provider.sendStateless(JSON.stringify({ type: 'hcd-save-state' })); refreshPresence(); setError(previous => previous === '__collab_not_ready__' ? '' : previous) } }
    const authenticationFailed = () => setError('__collab_not_ready__')
    const saveState = ({ payload }: { payload: string }) => {
      let message: SaveState
      try { message = JSON.parse(payload) } catch { return }
      if (message.type !== 'hcd-save-status') return
      if (message.revision !== undefined && acceptedReceipt.current && message.revision < acceptedReceipt.current.revision) return
      if (Number.isSafeInteger(message.revision) && /^[a-f0-9]{64}$/.test(message.digest ?? '') && /^[a-f0-9]{64}$/.test(message.imageDigest ?? '')) {
        acceptedReceipt.current = { revision: message.revision!, digest: message.digest!, imageDigest: message.imageDigest!, pending: !!message.pending }
        setCanonicalReady(true)
        setViewRevision(message.revision!)
        setRevision(previous => Math.max(previous ?? 0, message.revision!))
        // A restarted coordinator may authenticate and recover the same room
        // while newer edits remain pending. Its valid baseline clears only the
        // cached client conflict; the pending snapshot still needs a save ack.
        if(message.status!=='conflict' && !message.conflict) {saveConflictRef.current=null;setSaveConflict(null)}
      }
      if (message.status === 'conflict') { setSaveConflict(message); setStatus('saveConflict'); return }
      if (message.status === 'editing' || message.pending) { semanticDirty.current = true; setStatus('editing') }
      if (message.status === 'saving') setStatus('saving')
      if (message.status === 'failed') { setStatus('saveFailed'); setError(message.problem==='image-drafts-not-ready'?'__image_geometry_invalid__':message.problem==='image-drafts-conflict'?'__image_collaboration_conflict__':'__autosave_retry__');if(message.problem?.startsWith('image-drafts-'))setRightPanel('images') }
      const currentEditor = editorRef.current
      if (message.status === 'saved' && currentEditor) {
        const generation = semanticGeneration.current
        void Promise.all([checkpointDigest(jsonToSnapshot(currentEditor.getJSON())),imageDraftDigest(ydoc)]).then(([digest,imagesDigest]) => {
          if (saveAbort.signal.aborted || generation !== semanticGeneration.current) return
          const covered = digest === message.digest && imagesDigest===message.imageDigest && !message.pending && !imageDrafts.size && !imageDrafts.uploading
          semanticDirty.current = !covered
          setStatus(covered ? 'saved' : 'editing')
          if (covered) { saveConflictRef.current = null; setSaveConflict(null); setError(previous => previous === '__autosave_retry__' || previous.startsWith('__image_') ? '' : previous) }
        }).catch(()=>{if(!saveAbort.signal.aborted){semanticDirty.current=true;setStatus('saveFailed')}})
      }
    }
    const refreshPresence = () => {
      if (!provider.isSynced || provider.configuration.websocketProvider.status !== 'connected') { setPresence([]); return }
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
    provider.on('synced', synced)
    provider.on('authenticationFailed', authenticationFailed)
    if (provider.isSynced) synced({ state: true })
    provider.on('stateless', saveState)
    provider.awareness?.on('change', refreshPresence)
    refreshPresence()
    return () => { provider.off('status', connection); provider.off('synced', synced); provider.off('authenticationFailed', authenticationFailed); provider.off('stateless', saveState); provider.awareness?.off('change', refreshPresence); saveAbort.abort(); provider.destroy() }
  }, [provider, ydoc, localUser, saveAbort, imageDrafts])
  useEffect(() => {claimDocument();return()=>ydoc.destroy()}, [ydoc,claimDocument])
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const [revisionResponse, authResponse] = await Promise.all([api(session, '/revisions'), api(session, '/auth')])
        const access = await authResponse.json() as { collaborationEpoch: number }
        if (access.collaborationEpoch !== (session.collaborationEpoch ?? 0)) {
          if (alive) { setSaveConflict({ type: 'hcd-save-status', status: 'conflict', conflict: 'epoch-changed' }); setStatus('saveConflict') }
          return
        }
        const result = await revisionResponse.json() as { headRevision: number; revisions: RevisionItem[]; nextBefore: number | null }
        if (!alive) return
        setRevision(previous => Math.max(previous ?? 0, result.headRevision))
        if (acceptedReceipt.current && result.headRevision > acceptedReceipt.current.revision && provider.configuration.websocketProvider.status === 'connected') provider.sendStateless(JSON.stringify({ type: 'hcd-save-state' }))
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
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if(session.scope==='read') return
      if (semanticDirty.current || imageDrafts.size || imageDrafts.saving || saveInFlight.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [imageDrafts, session.scope])
  async function performSave(): Promise<number | null> {
    if (!editor || revision === null) return null
    if(imageDrafts.uploading){setError('__image_upload_pending__');return null}
    if (saveConflict) { setError('__save_conflict__'); return null }
    if (!hasDocument || !canonicalReady || !provider.isSynced || provider.hasUnsyncedChanges || provider.configuration.websocketProvider.status !== 'connected') {
      setError('__collab_not_ready__'); return null
    }
    setStatus('saving'); setError('')
    try {
      const [digest,imagesDigest] = await Promise.all([checkpointDigest(jsonToSnapshot(editor.getJSON())),imageDraftDigest(ydoc)])
      if (scopeReadOnly) {
        const receipt = acceptedReceipt.current
        if (!receipt || receipt.pending || receipt.digest !== digest || receipt.imageDigest!==imagesDigest) { setError('__newer_changes__'); return null }
        return receipt.revision
      }
      const reply = await requestCoordinatedSave(provider, digest, saveAbort.signal,45_000,imagesDigest)
      if (reply.type !== 'hcd-save-status') throw new Error('coordinatorUnavailable')
      if (reply.status === 'conflict') { setSaveConflict(reply); setStatus('saveConflict'); return null }
      if(reply.problem==='image-drafts-not-ready' || reply.problem==='image-drafts-conflict') {setRightPanel('images');setStatus('saveFailed');setError(reply.problem==='image-drafts-not-ready'?'__image_geometry_invalid__':'__image_collaboration_conflict__');return null}
      if (reply.status === 'failed' || !Number.isSafeInteger(reply.revision)) throw new Error('coordinatorUnavailable')
      const generation=semanticGeneration.current
      const [current,currentImages] = await Promise.all([checkpointDigest(jsonToSnapshot(editor.getJSON())),imageDraftDigest(ydoc)])
      const covered = generation===semanticGeneration.current && !reply.pending && current === reply.digest && currentImages===reply.imageDigest && !imageDrafts.size && !imageDrafts.uploading
      setRevision(previous => Math.max(previous ?? 0, reply.revision!))
      semanticDirty.current = !covered
      if (!covered) { setStatus('editing'); setError('__newer_changes__'); return null }
      setStatus('saved'); return reply.revision!
    } catch { setStatus('saveFailed'); setError('__coordinator_unavailable__'); return null }
  }
  function save(): Promise<number | null> {
    if (saveInFlight.current) return saveInFlight.current
    const work = performSave().then(async saved=>{
      if(saved===null)return null
      const generation=semanticGeneration.current
      try{await localJournal?.flush()}catch{/* Canonical receipt still authorizes the saved document; local failure remains visible. */}
      if(generation!==semanticGeneration.current || semanticDirty.current || imageDrafts.size || imageDrafts.uploading){setError('__newer_changes__');return null}
      return saved
    }).finally(() => { if (saveInFlight.current === work) saveInFlight.current = null })
    saveInFlight.current = work
    return work
  }
  async function useLatest() {
    if(imageDrafts.uploading)throw new Error(t('imageUploadPending'))
    imageUploadGate.current=true
    try {
    if (!editor) throw new Error(t('collaborationSaveNotReady'))
    const captured=Array.from(Y.encodeStateVector(ydoc)).join(',')
    // This backup includes offline edits even when the old room cannot be
    // authenticated or its sidecar is unavailable. Never require that stale
    // WebSocket to reconnect in order to keep the user's local CRDT.
    await api(session, '/collaboration/recovery', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-HCD-Collaboration-Epoch': String(session.collaborationEpoch ?? 0) }, body: new Blob([new Uint8Array(Y.encodeStateAsUpdate(ydoc)).buffer]) })
    const access = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
    let epoch = access.collaborationEpoch
    if (epoch === (session.collaborationEpoch ?? 0)) {
      try {
        const reset = await (await api(session, '/collaboration/reset', { method: 'POST', headers: { 'X-HCD-Collaboration-Epoch': String(epoch) } })).json() as { collaborationEpoch: number }
        epoch = reset.collaborationEpoch
      } catch (cause) {
        const current = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
        if (current.collaborationEpoch <= epoch) throw cause
        epoch = current.collaborationEpoch
      }
    }
    if (!Number.isSafeInteger(epoch) || epoch <= (session.collaborationEpoch ?? 0)) throw new Error(t('collaborationSaveNotReady'))
    if (Array.from(Y.encodeStateVector(ydoc)).join(',')!==captured) throw new Error(t('newerChangesRemain'))
    semanticDirty.current = false
    onEpochChange?.(epoch)
    } finally { imageUploadGate.current=false }
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
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || value.length > 2048) throw new Error(t('linkInvalid'))
      editor.chain().focus().extendMarkRange('link').setLink({ href: url.href }).run()
      setLinkOpen(false)
      setError('')
    } catch (cause) { setError(cause instanceof TypeError ? t('linkIncomplete') : String(cause)) }
  }
  const actions: MenuAction[] = [
    { label: t('copySelection'), action: () => { if (editor) void navigator.clipboard.writeText(menu?.selectedText || editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, '\n')).catch(cause => setError(String(cause))) } },
    { label: t('pasteText'), disabled: readOnly, action: () => { if (editor) void navigator.clipboard.readText().then(text => editor.chain().focus().insertContent(text).run()).catch(cause => setError(String(cause))) } },
    { label: t('addParagraph'), disabled: readOnly, separated: true, action: () => editor?.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'text', text: t('newParagraphText') }] }).run() },
    { label: t('deleteParagraph'), disabled: readOnly, action: deleteCurrentBlock },
    { label: t('setHeading'), disabled: readOnly, action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: t('setList'), disabled: readOnly, action: () => editor?.chain().focus().toggleBulletList().run() },
    { label: t('bold'), disabled: readOnly, separated: true, action: () => editor?.chain().focus().toggleBold().run() },
    { label: t('italic'), disabled: readOnly, action: () => editor?.chain().focus().toggleItalic().run() },
    { label: t('setLink'), disabled: readOnly, action: openLink },
    { label: t('removeLink'), disabled: readOnly || !editor?.isActive('link'), action: () => editor?.chain().focus().extendMarkRange('link').unsetLink().run() },
    { label: t('moveParagraphUp'), disabled: readOnly, separated: true, action: () => moveBlock(-1) },
    { label: t('moveParagraphDown'), disabled: readOnly, action: () => moveBlock(1) },
    { label: t('undo'), disabled: readOnly || !editor?.can().undo(), separated: true, action: () => editor?.chain().focus().undo().run() },
    { label: t('redo'), disabled: readOnly || !editor?.can().redo(), action: () => editor?.chain().focus().redo().run() },
  ]
  return <div className={`workspace semantic-workspace ${embedded ? 'embedded' : ''} ${layout.compact ? 'compact-header' : ''} ${layout.showOutline ? '' : 'outline-hidden'} ${rightPanel ? '' : 'right-hidden'}`} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() } }}>
    {layout.showHeader && <header className="editor-header">
      <div className="document-identity"><span className="word-file-icon">{session.format === 'docx' ? 'W' : 'D'}</span><div className="document-title"><strong title={session.documentId}>{session.documentId}</strong><small role="status">{imageDrafts.size ? t('unsavedImageCount', { count: imageDrafts.size }) : t(status)} · r{viewRevision ?? revision ?? '…'}</small></div></div>
      <div className="header-actions">
        {layout.showCollaborators && <details className="presence"><summary aria-label={t('onlineCount', { count: presence.length })}><span className="presence-avatars">{presence.slice(0, 3).map(user => <span key={user.id} className="avatar" title={user.name} style={{ background: user.color }}>{user.name.slice(0, 1)}</span>)}</span><span>{t('onlineCount', { count: presence.length })}</span></summary><div className="presence-menu"><strong>{t('onlineCollaborators')}</strong>{presence.map(user => <div key={user.id} className="presence-person"><span className="avatar" style={{ background: user.color }}>{user.name.slice(0, 1)}</span><span>{user.name}{user.id === localUser.id ? ` ${t('you')}` : ''}</span>{user.connections > 1 && <small>{t('connectionCount', { count: user.connections })}</small>}</div>)}</div></details>}
        <LocaleSelect /><button className="settings-trigger word-icon-button" aria-label={t('properties')} aria-expanded={rightPanel === 'properties' || rightPanel==='images'} onClick={() => setRightPanel(previous => previous === 'properties' || previous==='images' ? null : 'properties')}><EditorIcon name="panel" /></button><button className="word-icon-button" aria-label={t('close')} onClick={() => { if (session.scope==='read') onClose(); else if (saveConflict || semanticDirty.current || imageDrafts.size || imageDrafts.saving || saveInFlight.current) void save().then(saved => { if (saved !== null) onClose() }); else if (readOnly || !editor || revision === null) onClose(); else void save().then(saved => { if (saved !== null) onClose() }) }}><EditorIcon name="close" /></button>
      </div>
    </header>}
    {layout.showHeader && <nav className="presentation-tabs semantic-tabs" aria-label={t('editorFeatures')}>{(['home', 'insert', 'view', 'revisions', 'export'] as const).map(tab => <button key={tab} aria-pressed={activeTab === tab} onClick={() => { setActiveTab(tab); if (tab === 'revisions') setRightPanel('revisions') }}>{t(tab)}</button>)}<span className="presentation-mode">{readOnly ? t('readOnly') : t('editable')}</span></nav>}
    {!layout.showHeader && <button className="floating-settings" aria-label={t('settings')} aria-expanded={rightPanel === 'settings'} onClick={() => setRightPanel(previous => previous === 'settings' ? null : 'settings')}>⚙ {t('settings')}</button>}
    {layout.showToolbar && <nav className="toolbar ribbon" aria-label={t('toolbar')}>
      <div className="presentation-tool-group presentation-file-actions"><button className="presentation-ribbon-tool" onClick={() => void save()} disabled={readOnly || status === 'saving'}><EditorIcon name="save" /><span>{status === 'saving' ? t('saving') : t('saveAllText')}</span></button><button className="presentation-ribbon-tool" aria-pressed={activeTab === 'export'} onClick={() => setActiveTab('export')}><EditorIcon name="export" /><span>{t('export')}</span></button><span className="presentation-tool-caption">{t('document')}</span></div>
      {activeTab === 'home' && <>
        <div className="word-tool-group word-stacked-tools"><button aria-label={t('undo')} title={t('undo')} onClick={() => editor?.chain().focus().undo().run()} disabled={readOnly || !editor?.can().undo()}>↶ {t('undo')}</button><button aria-label={t('redo')} title={t('redo')} onClick={() => editor?.chain().focus().redo().run()} disabled={readOnly || !editor?.can().redo()}>↷ {t('redo')}</button><span className="word-tool-caption">{t('editHistory')}</span></div>
        <div className="word-tool-group word-stacked-tools"><button onClick={() => editor?.chain().focus().setParagraph().run()} disabled={readOnly} aria-pressed={editor?.isActive('paragraph')}>{t('bodyText')}</button><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={readOnly} aria-pressed={editor?.isActive('heading')}>{t('heading')}</button><span className="word-tool-caption">{t('styles')}</span></div>
        <div className="word-tool-group word-format-tools"><div>{([{ name: 'bold', symbol: 'B' }, { name: 'italic', symbol: 'I' }, { name: 'underline', symbol: 'U' }, { name: 'strike', symbol: 'S' }] as const).map(mark => <button key={mark.name} className={`word-mark-${mark.name}`} aria-label={t(mark.name)} title={t(mark.name)} aria-pressed={editor?.isActive(mark.name)} onClick={() => editor?.chain().focus().toggleMark(mark.name).run()} disabled={readOnly}>{mark.symbol}</button>)}<button onClick={openLink} disabled={readOnly}>{t('link')}</button></div><div><label className="word-color-picker" title={t('textColor')}><span>A</span><input type="color" aria-label={t('textColor')} defaultValue="#1f2328" disabled={readOnly} onChange={event => editor?.chain().focus().setMark('textColor', { color: event.target.value }).run()} /></label><button className="word-clear-color" title={t('clearTextColor')} aria-label={t('clearTextColor')} disabled={readOnly} onClick={() => editor?.chain().focus().unsetMark('textColor').run()}>A×</button><label className="word-color-picker word-highlight-picker" title={t('highlight')}><span>A</span><input type="color" aria-label={t('highlight')} defaultValue="#fff2a8" disabled={readOnly} onChange={event => editor?.chain().focus().setMark('textBackground', { color: event.target.value }).run()} /></label><button className="word-clear-color" title={t('clearHighlight')} aria-label={t('clearHighlight')} disabled={readOnly} onClick={() => editor?.chain().focus().unsetMark('textBackground').run()}>▱×</button><button disabled={readOnly} onClick={() => editor?.chain().focus().setMark('textBorder', { color: '#1f2328', widthPt: 1, style: 'solid' }).run()}>{t('border')}</button><button disabled={readOnly} title={t('clearBorder')} aria-label={t('clearBorder')} onClick={() => editor?.chain().focus().unsetMark('textBorder').run()}>▧×</button></div><span className="word-tool-caption">{t('formatting')}</span></div>
        <div className="word-tool-group word-stacked-tools"><button onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={readOnly} aria-pressed={editor?.isActive('bulletList')}>• {t('bullets')}</button><button onClick={() => editor?.chain().focus().toggleOrderedList().run()} disabled={readOnly} aria-pressed={editor?.isActive('orderedList')}>1. {t('numbering')}</button><span className="word-tool-caption">{t('paragraph')}</span></div>
        <div className="word-tool-group word-stacked-tools"><button onClick={() => moveBlock(-1)} disabled={readOnly}>↑ {t('moveParagraphUp')}</button><button onClick={() => moveBlock(1)} disabled={readOnly}>↓ {t('moveParagraphDown')}</button><span className="word-tool-caption">{t('arrange')}</span></div>
      </>}
      {activeTab === 'insert' && <><div className="tool-group"><button onClick={() => editor?.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'text', text: t('newParagraphText') }] }).run()} disabled={readOnly}>＋ {t('addParagraph')}</button><button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={readOnly}>{t('insertHeading')}</button><button onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={readOnly}>{t('insertList')}</button></div><div className="tool-group"><button onClick={openLink} disabled={readOnly}>{t('insertLink')}</button><button onClick={deleteCurrentBlock} disabled={readOnly}>{t('deleteParagraph')}</button></div><div className="word-tool-group"><button className="presentation-ribbon-tool" aria-label={t('imageOptions')} aria-pressed={rightPanel==='images'} onClick={()=>setRightPanel('images')}><EditorIcon name="image" /><span>{t('imageOptions')}</span></button></div></>}
      {activeTab === 'view' && <><button onClick={() => { if (saveConflict || semanticDirty.current || imageDrafts.size || imageDrafts.saving) void save().then(saved => { if (saved !== null) onWindowed() }); else if (readOnly) onWindowed(); else void save().then(saved => { if (saved !== null) onWindowed() }) }}>{t('windowedEditing')}</button><label className="mode"><input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} />{t('showOutline')}</label><label className="mode"><input type="checkbox" checked={readOnly} disabled={session.scope === 'read'} onChange={event => setReadOnly(event.target.checked)} />{t('readOnlyMode')}</label><button onClick={() => setRightPanel('settings')}>{t('settings')}</button></>}
      {activeTab === 'revisions' && <><button onClick={() => void save()} disabled={readOnly}>{t('createCheckpoint')}</button><button onClick={() => setRightPanel('revisions')}>{t('viewHistory')}</button><button onClick={() => setRecoveryOpen(value => !value)}>{t('recoveryCopies')}</button><span className="ribbon-note">{t('currentRevision', { revision: revision ?? '…' })}</span></>}
      {activeTab === 'export' && <div className="word-export-options"><ExportControl session={session} revision={revision} beforeExport={save} /><p>{t('semanticExportWarning')}</p></div>}
    </nav>}
    <div className="layout editor-layout" style={{ gridTemplateColumns: `${layout.showOutline ? `${outlineWidth}px 5px ` : ''}minmax(0,1fr)${rightPanel ? ` 5px ${sidebarWidth}px` : ''}` }}>
      {layout.showOutline && <aside className="outline-panel" aria-label={t('outline')}><div className="panel-head"><h2>☷ {t('outline')}</h2><button className="panel-close" aria-label={t('hideOutline')} onClick={() => setLayoutOption('showOutline', false)}>×</button></div>{outline.length ? <nav>{outline.map(item => <button key={item.pos} className={`outline-level-${item.level}`} onClick={() => { editor?.commands.focus(); editor?.commands.setTextSelection(item.pos + 1); editor?.view.domAtPos(item.pos + 1).node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }}>{item.text || t('untitledHeading')}</button>)}</nav> : <p>{t('noOutline')}</p>}</aside>}
      {layout.showOutline && <PanelResizeHandle side="left" width={outlineWidth} onResize={setOutlineWidth} label={t('resizeNavigation')} />}
      <div className="document-scroll"><main className="document" style={{ zoom: documentZoom / 100 }} onContextMenu={event => {
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
      }}><EditorContent editor={editor} />{editor && <BubbleMenu editor={editor} shouldShow={({ state }) => !readOnly && !state.selection.empty} className="selection-menu"><button onClick={() => editor.chain().focus().toggleBold().run()} aria-label={t('bold')}>𝐁</button><button onClick={() => editor.chain().focus().toggleItalic().run()} aria-label={t('italic')}>𝑰</button><button onClick={openLink} aria-label={t('setLink')}>🔗</button></BubbleMenu>}</main></div>
      {rightPanel && <PanelResizeHandle side="right" width={sidebarWidth} onResize={setSidebarWidth} label={t('resizeProperties')} />}
      {rightPanel && <aside className="workspace-sidebar" aria-label={rightPanel === 'images' ? t('imageOptions') : rightPanel === 'properties' ? t('properties') : rightPanel === 'settings' ? t('settings') : t('revisionHistory')}>{rightPanel==='images' && <section className="word-image-properties"><div className="panel-head"><h2>{t('imageOptions')}</h2><button className="panel-close" aria-label={t('hidePanel')} onClick={()=>setRightPanel(null)}>×</button></div><ImagePanel drafts={imageDrafts} prepareReplacement={(image,at,page)=>{if(imageUploadGate.current)throw new Error(t('collaborationSaveNotReady'));return imageDrafts.prepareReplacement(image,at,page)}} session={session} revision={revision} disabled={readOnly} saveGeometryLabel={t('saveAllText')} onSaveGeometry={async () => { if(await save()===null) throw new Error(t('newerChangesRemain')) }} onRevised={next => setRevision(previous => Math.max(previous ?? 0, next))} /></section>}{rightPanel === 'properties' && <section className="word-selection-properties"><div className="panel-head"><h2>{t('textOptions')}</h2><button className="panel-close" aria-label={t('hidePanel')} onClick={() => setRightPanel(null)}>×</button></div><section className="inspector-property-group"><h3>{t('selectedTextObject')}</h3><p className="word-selection-preview">{editor ? [...(editor.state.selection.empty ? editor.state.selection.$from.parent.textContent : editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' '))].slice(0, 180).join('') || t('emptyTextObject') : ''}</p></section><section className="inspector-property-group source-text-style"><h3>{t('textStyle')}</h3><dl><dt>{t('fontFamily')}</dt><dd title={selectedFont?.family || undefined}>{selectedFont?.mixedFamily ? t('mixedStyles') : selectedFont?.family || t('inheritedStyle')}</dd><dt>{t('fontSize')}</dt><dd><FontSizeControl editor={editor} readOnly={readOnly} /></dd></dl></section><section className="inspector-property-group"><h3>{t('formatting')}</h3><div className="word-property-mark-buttons">{(['bold', 'italic', 'underline', 'strike'] as const).map(mark => <button key={mark} aria-label={t(mark)} title={t(mark)} aria-pressed={editor?.isActive(mark)} disabled={readOnly} onClick={() => editor?.chain().focus().toggleMark(mark).run()}>{t(mark)}</button>)}</div><label className="inspector-option">{t('textColor')}<input type="color" aria-label={t('textColor')} defaultValue="#1f2328" disabled={readOnly} onChange={event => editor?.chain().focus().setMark('textColor', { color: event.target.value }).run()} /></label><label className="inspector-option">{t('highlight')}<input type="color" aria-label={t('highlight')} defaultValue="#fff2a8" disabled={readOnly} onChange={event => editor?.chain().focus().setMark('textBackground', { color: event.target.value }).run()} /></label></section><section className="inspector-property-group"><h3>{t('paragraph')}</h3><div className="word-property-paragraph-buttons"><button disabled={readOnly} aria-pressed={editor?.isActive('paragraph')} onClick={() => editor?.chain().focus().setParagraph().run()}>{t('bodyText')}</button><button disabled={readOnly} aria-pressed={editor?.isActive('heading')} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>{t('heading')}</button><button disabled={readOnly} aria-pressed={editor?.isActive('bulletList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}>{t('bullets')}</button><button disabled={readOnly} aria-pressed={editor?.isActive('orderedList')} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>{t('numbering')}</button></div></section></section>}
        {rightPanel === 'settings' && <section className="appearance-panel"><div className="panel-head"><h2>{t('appearance')}</h2><button className="panel-close" aria-label={t('hidePanel')} onClick={() => setRightPanel(null)}>×</button></div><LocaleSelect /><label>{t('showHeader')}<input type="checkbox" checked={layout.showHeader} onChange={event => setLayoutOption('showHeader', event.target.checked)} /></label><label>{t('showToolbar')}<input type="checkbox" checked={layout.showToolbar} onChange={event => setLayoutOption('showToolbar', event.target.checked)} /></label><label>{t('showCollaborators')}<input type="checkbox" checked={layout.showCollaborators} onChange={event => setLayoutOption('showCollaborators', event.target.checked)} /></label><label>{t('showDocumentOutline')}<input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} /></label><fieldset><legend>{t('headerDensity')}</legend><label><input type="radio" name="header-density" checked={layout.compact} onChange={() => setLayoutOption('compact', true)} />{t('compact')}</label><label><input type="radio" name="header-density" checked={!layout.compact} onChange={() => setLayoutOption('compact', false)} />{t('standard')}</label></fieldset><button className="open-revisions" onClick={() => setRightPanel('revisions')}>{t('viewHistory')}</button><button onClick={() => setRecoveryOpen(value => !value)}>{t('recoveryCopies')}</button></section>}
        {rightPanel === 'revisions' && <section className="revision-panel"><div className="panel-head"><h2>◷ {t('revisionHistory')}</h2><button className="panel-close" aria-label={t('hidePanel')} onClick={() => setRightPanel(null)}>×</button></div><ReviewPanel session={session} revision={revision} readOnly={readOnly} onRevised={setRevision} /><p>{t('semanticExportWarning')}</p>
        <div className="history">{history.slice().reverse().map(item => <button key={item.revision} onClick={() => void showRevision(item.revision)} title={/^hcdsave[1234]:/.test(item.patchId || '') ? t('contentUpdated') : item.patchId}><span className="revision-avatar" title={item.authorName || (item.revision === 0 ? t('imported') : t('unknownAuthor'))} style={item.authorId ? { background: presenceColor(item.authorId) } : undefined}>{item.authorName?.slice(0, 1) || (item.revision === 0 ? 'I' : '?')}</span><span className="revision-detail"><strong>r{item.revision} <small>{item.createdAtEpochMs ? new Date(item.createdAtEpochMs).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</small></strong><small>{item.authorName || (item.revision === 0 ? t('initialImport') : t('unknownAuthor'))} · {item.revision === 0 ? t('imported') : item.patchId?.startsWith('restore-') ? t('restoredRevision') : item.patchId === 'editor-projection' ? t('editorProjection') : t('contentUpdated')}</small><span>{t('viewRevision')}</span></span></button>)}
          {nextBefore !== null && nextBefore !== undefined && <button onClick={() => void loadOlderRevisions()}>{t('loadOlder')}</button>}
        </div>
        {historical && <section className="revision-view"><div className="panel-head"><strong>{t('revisionContent', { revision: historical.revision })}</strong><button onClick={() => setHistorical(null)}>{t('close')}</button></div><div>{historical.blocks.filter(block => block.region === 'body').map(block => <p key={block.blockId}>{block.content.inlines.map(item => item.text).join('')}</p>)}</div><button disabled={readOnly || historical.revision >= (revision ?? 0)} onClick={() => void restoreHistorical()}>{t('restoreRevision')}</button></section>}
        </section>}</aside>}
    </div>
    {(localUnavailable || localDraftState==='failed') && <div className="local-draft-warning" role="alert">{t('localDraftUnavailable')}<button type="button" onClick={()=>setRecoveryOpen(true)}>{t('downloadDraft')}</button></div>}
    {!localUnavailable && localDraftState!=='idle' && <div className="local-draft-status" role="status">{t(localDraftState==='writing'?'localDraftWriting':localDraftState==='stored'?'localDraftStored':'localDraftUnavailable')}</div>}
    {(saveConflict || recoveryOpen) && <SemanticRecoveryPanel session={session} localCopies={localCopies} document={ydoc} conflict={saveConflict} onUseLatest={useLatest} readOnly={scopeReadOnly} onClose={() => setRecoveryOpen(false)} />}
    <footer className="editor-statusbar"><div><button className="word-icon-button" aria-label={t('showOutline')} aria-pressed={layout.showOutline} onClick={() => setLayoutOption('showOutline', !layout.showOutline)}><EditorIcon name="slides" /></button><span>{t('continuousView')} · {session.format.toUpperCase()}</span><span>{t(status)}</span></div><div><button className="word-icon-button" aria-label={t('properties')} aria-pressed={rightPanel === 'properties' || rightPanel==='images'} onClick={() => setRightPanel(previous => previous === 'properties' || previous==='images' ? null : 'properties')}><EditorIcon name="panel" /></button><button className="word-icon-button" aria-label={t('actualSize')} onClick={() => setDocumentZoom(100)}><EditorIcon name="fit" /></button><input type="range" aria-label={t('zoom')} min="70" max="150" step="5" value={documentZoom} onChange={event => setDocumentZoom(Number(event.target.value))} /><span>{documentZoom}%</span></div></footer>
    {menu && <ContextMenu x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} />}
    {linkOpen && <div className="hcd-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setLinkOpen(false) }}><div className="hcd-dialog" role="dialog" aria-modal="true" aria-label={t('setLink')}><h2>{t('setLink')}</h2><label>{t('linkAddress')}<input autoFocus type="url" value={linkHref} onChange={event => setLinkHref(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') applyLink(); if (event.key === 'Escape') setLinkOpen(false) }} placeholder="https://example.com" /></label><div className="hcd-dialog-actions"><button onClick={() => setLinkOpen(false)}>{t('cancel')}</button><button className="primary" onClick={applyLink}>{t('applyLink')}</button></div></div></div>}
    {error && <div className="toast error">{error === '__save_conflict__' ? t('saveConflictHint') : error === '__coordinator_unavailable__' ? t('coordinatorUnavailable') : error === '__image_upload_pending__' ? t('imageUploadPending') : error === '__image_geometry_invalid__' ? t('imageGeometryInvalid') : error === '__image_collaboration_conflict__' ? t('imageCollaborationConflict') : error === '__image_drafts__' ? t('saveImageDraftsFirst') : error === '__autosave_retry__' ? t('autoSaveRetry') : error === '__newer_changes__' ? t('newerChangesRemain') : error === '__collab_not_ready__' ? t('collaborationSaveNotReady') : error}</div>}
  </div>
}
