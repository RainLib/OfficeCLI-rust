import {useSemanticImageTasks} from './useSemanticImageTasks.ts'
import {SemanticImageTasksPanel} from './SemanticImageTasksPanel.tsx'
import {readInlineContainerPayload} from './inlineContainerPayload.ts'
import {wordRegionVersion} from './wordRegions.ts'
import {applyCustomMark,unavailableCustomMark,selectedCustomMarkTypes} from './customMarks.ts'
import {useReferenceEdits} from './useReferenceEdits.ts'
import {documentReferences} from './referenceEdits.ts'
import {businessDraftProblem} from './businessDrafts.ts'
import {keepSavedReference,type SavedReferenceChoice} from './referenceSaved.ts'
import {canEditReference,retargetReference,chooseReferenceCandidate} from './referenceCommands.ts'
import {useAiAutocomplete,type AiAutocompleteService} from './ai/useAutocomplete.tsx'
import {AiExtensionsProvider,useAiConfiguration} from './ai/react.tsx'
import {AiSuggestionController} from './ai/core.ts'
import {AiPanel} from './ai/Panel.tsx'
import {AiComposer,type AiComposerEntry} from './ai/Composer.tsx'
import {aiSpaceEntry} from './ai/entry.ts'
import {canAiSelection,createSemanticAiAdapter} from './ai/semantic.ts'
import type {AiExtensions,AiSnapshot} from './ai/types.ts'
import {useExtensionEdits,useInlineContainerEdits} from './useExtensionEdits.ts'
import {resolveExtensionEdits,extensionEditIndex} from './extensionEdits.ts'
import {readExtensionNode,extensionNodes} from './extensionNode.ts'
import {prepareExtensionHistoryGuard} from './extensionHistory.ts'
import {NodeConflictPanel} from './NodeConflictPanel.tsx'
import {semanticBlockOrigin} from './semanticBlockStore.ts'
import {SemanticOutlineNavigation} from './SemanticOutlineNavigation.tsx'
import {semanticOutline,semanticOutlinePosition,type SemanticOutlineEntry} from './semanticOutline.ts'
import {watchSemanticOutline} from './semanticOutlineWatch.ts'
import {wordOutlineSnapshotTransaction} from './wordOutline.ts'
import {locateWordField} from './wordFieldLocation.ts'
import {WordSourceRecovery} from './WordSourceRecovery.tsx'
import {NodeExtensionsProvider,useNodeExtensions} from './NodeExtensions.tsx'
import {InlineContainerExtensionsProvider,useInlineContainerExtensions} from './InlineContainerExtensions.tsx'
import type {InlineContainerExtensions} from './inlineContainerRegistry.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {prepareInlineContainerHistoryGuard} from './inlineContainerPreservation.ts'
import {inlineContainerEditIndex,resolveInlineContainerEdits} from './inlineContainerEdits.ts'
import {editorNodes,selectedEditorNode,editorNodeCodec} from './editorNodes.ts'
import type {ResourceNodePayload} from './nodeResourceModel.ts'
import {prepareInlineContainerTransaction,selectedInlineContainer} from './inlineContainerCommands.ts'
import type {NodeExtensions} from './extensionTypes.ts'
import {ExtensionProperties,InlineContainerProperties} from './ExtensionProperties.tsx'
import {WordNodeResourcePanel} from './WordNodeResourcePanel.tsx'
import {useEditorNodeResources} from './useSemanticNodeResources.ts'
import type {WordNodeResourceDraft} from './wordNodeResources.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
import {stableExtension} from './extensionRegistry.ts'
import {selectedExtension,canInsertExtension,prepareNodeTransaction} from './extensionCommands.ts'
import {ReferencePanel,type HistoricalReferenceNavigation} from './ReferencePanel.tsx'
import {useMentionInspector} from './MentionInspector.tsx'
import {useMentionMenu} from './MentionMenu.tsx'
import {canMentionAt,insertMention,startMentionTransaction,type MentionCandidate,type MentionMatch} from './mentionSuggestion.ts'
import {useBlockControls} from './commands/BlockControls.tsx'
import {blockTarget,blockOperations,blockActionStates,prepareBlockTransaction,type BlockTarget} from './commands/blocks.ts'
import {useSlashMenu} from './commands/SlashMenu.tsx'
import {prepareSlashTransaction} from './commands/slashTransaction.ts'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { checkpointContents, checkpointDigest } from './checkpointSnapshot.ts'
import { selectionTypography } from './selectionTypography.ts'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import {Extension,getSchema} from '@tiptap/core'
import type {EditorState} from '@tiptap/pm/state'
import {SemanticStructureCollaboration} from './semanticStructureCollaboration.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {DeletionReviewPanel,useDeletionReviews} from './DeletionReviewPanel.tsx'
import {resolveDeletionReview,canConfirmDeletion,type DeletionReview} from './deletionReview.ts'
import {restoreInlineDeletion,negotiateSession} from './protocolClient.ts'
import {RestoreRevisionDialog} from './RestoreRevisionDialog.tsx'
import {installRestoreHandoff,waitRestoreSync,restoreHandoffReady,followCommittedRestore,submitRestore,RestoreClientError,type RestoreSubmission} from './restoreClient.ts'
import {RevisionReview,type RevisionSelection} from './RevisionReview.tsx'
import {SemanticActivity} from './SemanticActivity.tsx'
import {ProtocolUpgrade} from './ProtocolUpgrade.tsx'
import {inlineCollaborationUrl,nodeEditCollaborationUrl,nodeEditWireVersion,legacyProtocol,structuralProtocol,wordRegionalProtocol,wordLayoutProtocol,inlineProtocol,requireCollaborationSession,type CollaborationSession} from './collaborationProtocol.ts'
import { LocalDraftBootstrap, type LocalDraftCopy } from './LocalDraftBootstrap.tsx'
import type {LocalDraftJournal} from './localDrafts.ts'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { clearPastedBlockIds, jsonToSnapshot, schemaExtensions, type Projection } from './schema.ts'
import { ContextMenu } from './ContextMenu.tsx'
import { api, ApiError, type Session } from './api.ts'
import { writeAllowed,accessDenied } from './accessPolicy.ts'
import { FixedViewer } from './FixedViewer.tsx'
import { ExportControl } from './ExportControl.tsx'
import {semanticExportHead} from './semanticExportGuard.ts'
import { ReviewPanel } from './ReviewPanel.tsx'
import { PanelResizeHandle } from './PanelResizeHandle.tsx'
import { EditorIcon } from './EditorIcon.tsx'
import { FontSizeControl } from './FontSizeControl.tsx'
import {applyFontSizeCommand} from './fontSize.ts'
import { ImagePanel } from './ImagePanel.tsx'
import { CollaborativeImageDraftStore, imageDraftDigest } from './collaborativeImages.ts'
import { SemanticHistory } from './semanticHistory.ts'
import { requestCoordinatedSave } from './semanticSaveClient.ts'
import type { SaveState } from './semanticSaveCoordinator.ts'
import { SemanticRecoveryPanel } from './SemanticRecoveryPanel.tsx'
import { I18nProvider, LocaleSelect, standaloneLocale, useI18n, type MessageKey, type EditorLocale } from './i18n.tsx'
import {retainDocument} from './documentLifetime.ts'
import {commandKeyScope,displayShortcut} from './commands/keymap.ts'
import {toggleInput,zoomInput,revisionInput,panelTarget} from './commands/workspace.ts'
import {CommandExtensionsProvider,CommandAction,CommandRibbon,CommandBubble,CommandPalette,useCommands,commandMessage} from './commands/react.tsx'
import {semanticSelection,semanticActionStates} from './commands/semantic.ts'
import type {CommandExtensions} from './commands/types.ts'
import type {CommandRegistry} from './commands/registry.ts'
import './style.css'

const RecoveryArchivePanel=lazy(()=>import('./RecoveryArchivePanel.tsx'))
const RegionalWordEditor=lazy(()=>import('./RegionalWordEditor.tsx').then(module=>({default:module.RegionalWordEditor})))
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
  const stored=(key:string)=>{try{return sessionStorage.getItem(key)||''}catch{return''}}
  const [documentId, setDocumentId] = useState(()=>stored('hcd-document'))
  const [token, setToken] = useState(()=>stored('hcd-token'))
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<DocumentProblem|null>(null),[compatibility,setCompatibility]=useState<WordCompatibilityError|null>(null),[opening,setOpening]=useState(false)
  const openingRequest=useRef<AbortController|null>(null)
  useEffect(()=>()=>{openingRequest.current?.abort();openingRequest.current=null},[])
  useEffect(() => { document.documentElement.lang = locale; document.title = t('appTitle') }, [locale, t])
  async function open() {
    openingRequest.current?.abort();const controller=new AbortController();openingRequest.current=controller;setError(null);setCompatibility(null);setOpening(true)
    try {
      const draft: Session = { documentId: documentId.trim(), token: token.trim(), scope: 'read', format: '' }
      const next=await readDocumentSession(draft,controller.signal)
      if(controller.signal.aborted)return
      try{sessionStorage.setItem('hcd-document', draft.documentId);sessionStorage.setItem('hcd-token', draft.token)}catch{/* Opening can continue without remembered form values. */}
      setSession(next)
    } catch (cause) { if(!controller.signal.aborted){setError(classifyDocumentProblem(cause));if(cause instanceof WordCompatibilityError)setCompatibility(cause)} }
    finally{if(openingRequest.current===controller)setOpening(false)}
  }
  if (session) return <div className="hcd-surface" lang={locale}><Workspace key={`${session.documentId}:${session.collaborationEpoch ?? 0}`} session={session} onClose={() => setSession(null)} onEpochChange={epoch => setSession(previous => previous && ({ ...previous, collaborationEpoch: epoch }))} /></div>
  return <div className="hcd-surface" lang={locale}><main className="login"><div className="login-card"><div className="login-language"><LocaleSelect /></div><div className="eyebrow">OfficeCLI / HCD</div><h1>{t('workspaceTitle')}</h1><p>{t('loginHelp')}</p><label>{t('documentId')}<input value={documentId} onChange={event => {setDocumentId(event.target.value);setCompatibility(null)}} placeholder="doc-…" /></label><label>{t('accessToken')}<textarea rows={4} value={token} onChange={event => {setToken(event.target.value);setCompatibility(null)}} placeholder={t('tokenPlaceholder')} /></label><button onClick={() => void open()} disabled={opening||!documentId || !token}>{t(opening?'openingDocument':'openDocument')}</button>{error && (compatibility?<WordCompatibilityProblem compact problem={error} session={compatibility.recoverySession} checkpointSession={compatibility.checkpointSession} onRetry={()=>void open()} busy={opening}/>:<DocumentProblemView compact problem={error} onRetry={()=>void open()} busy={opening}/>)}</div></main></div>
}

type WorkspaceProps={session:Session;onClose:()=>void;allowClose?:boolean;onError?:(error:Error)=>void;onEpochChange?:(epoch:number)=>void;embedded?:boolean;commandExtensions?:CommandExtensions;nodeExtensions?:NodeExtensions;inlineContainerExtensions?:InlineContainerExtensions;aiExtensions?:AiExtensions}
export function Workspace(props:WorkspaceProps){return <DocumentErrorBoundary documentId={props.session.documentId} onClose={props.allowClose===false?undefined:props.onClose} onError={props.onError}><AiExtensionsProvider value={props.aiExtensions}><InlineContainerExtensionsProvider value={props.inlineContainerExtensions}><CommandExtensionsProvider value={props.commandExtensions}>{(props.session.collaborationProtocol===wordRegionalProtocol||props.session.collaborationProtocol===wordLayoutProtocol)?<Suspense fallback={<DocumentLoading documentId={props.session.documentId}/>}><NodeExtensionsProvider value={props.nodeExtensions} session={props.session}><RegionalWordEditor {...props}/></NodeExtensionsProvider></Suspense>:<WorkspaceContent {...props}/>}</CommandExtensionsProvider></InlineContainerExtensionsProvider></AiExtensionsProvider></DocumentErrorBoundary>}
function WorkspaceContent({ session, onClose, onEpochChange, embedded = false,allowClose=true,nodeExtensions }: WorkspaceProps) {
  const { t } = useI18n()
  const semantic = ['docx', 'html', 'md', 'txt'].includes(session.format)
  const [windowed, setWindowed] = useState<boolean | null>(semantic ? null : false)
  const [inlineModel,setInlineModel]=useState(false)
  const [epoch, setEpoch] = useState(session.collaborationEpoch ?? 0)
  const [loadingError, setLoadingError] = useState<DocumentProblem|null>(null),[loadRetry,setLoadRetry]=useState(0)
  useEffect(() => {
    if (!semantic) return
    let live = true;const controller=new AbortController();setLoadingError(null)
    void api(session, '',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45_000)])}).then(response => response.json()).then((manifest: { chunkCount: number;capabilities?:{extensionNodes?:number} }) => {
      if(!Number.isSafeInteger(manifest?.chunkCount)||manifest.chunkCount<0)throw new EditorDocumentError(documentProblem('HCD-DOC-3001','content'))
      if(live){setInlineModel(manifest.capabilities?.extensionNodes===3);setWindowed(manifest.capabilities?.extensionNodes===3?false:wordRegionVersion(manifest)!==undefined||manifest.chunkCount>=4)}
    }).catch(cause => { if (live) setLoadingError(classifyDocumentProblem(cause,'content')) })
    return () => { live = false;controller.abort() }
  }, [session, semantic,loadRetry])
  const modeRequest=useRef<AbortController|null>(null)
  useEffect(()=>()=>{modeRequest.current?.abort()},[session])
  const fullEditor = () => {
    modeRequest.current?.abort();const controller=new AbortController();modeRequest.current=controller
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(45_000)])
    setLoadingError(null)
    void api(session, '/auth',{signal}).then(response => response.json()).then(access => {
      const authority=requireCollaborationSession(access)
      if(!controller.signal.aborted){setEpoch(authority.collaborationEpoch);setWindowed(false)}
    }).catch(cause => {if(!controller.signal.aborted)setLoadingError(classifyDocumentProblem(signal.aborted?signal.reason:cause,'collaboration'))})
  }
  if (semantic && windowed === null) return loadingError?<DocumentProblemView problem={loadingError} documentId={session.documentId} onRetry={()=>setLoadRetry(value=>value+1)} onClose={allowClose?onClose:undefined}/>:<DocumentLoading documentId={session.documentId} onClose={allowClose?onClose:undefined}/>
  if (semantic && windowed) return <div className="hcd-document-boundary">{loadingError&&<DocumentProblemView compact problem={loadingError} onRetry={fullEditor}/>}<NodeExtensionsProvider value={nodeExtensions} session={session}><FixedViewer session={session} onClose={onClose} allowClose={allowClose} embedded={embedded} onFullEditor={session.flowLayoutVersion===undefined?fullEditor:undefined} /></NodeExtensionsProvider></div>
  if (semantic) return <SemanticEditor key={epoch} nodeExtensions={nodeExtensions} inlineContainers={inlineModel?true:undefined} session={{ ...session, collaborationEpoch: epoch }} onClose={onClose} allowClose={allowClose} onEpochChange={next => { setEpoch(next) }} embedded={embedded} onWindowed={() => setWindowed(true)} />
  if (session.format === 'xlsx') return <Suspense fallback={<div className="embedded-loading">{t('loadingWorkbook')}</div>}><NodeExtensionsProvider value={nodeExtensions} session={session}><UniverViewer session={session} onClose={onClose} allowClose={allowClose} embedded={embedded} /></NodeExtensionsProvider></Suspense>
  return <NodeExtensionsProvider value={nodeExtensions} session={session}><FixedViewer session={session} onClose={onClose} allowClose={allowClose} embedded={embedded} /></NodeExtensionsProvider>
}

const structureSchema=getSchema([...schemaExtensions,SemanticStructureIdentity])
const inlineStructureSchema=getSchema([...schemaExtensions,SemanticStructureIdentity,SemanticInlineContainerNode])
const inlineModels={inlineContainers:true} as const,ordinaryModels={}
const modelsFor=(session:Session):{inlineContainers?:true}=>session.collaborationProtocol===inlineProtocol?inlineModels:ordinaryModels
const emptySubscribe=()=>()=>{}
const noLocalDraft=()=> 'idle' as const
const idleAi:AiSnapshot=Object.freeze({phase:'idle',requestId:null,output:'',source:''})
const noAi=()=>idleAi
type SemanticEditorProps={session:Session;onClose:()=>void;allowClose?:boolean;onEpochChange?:(epoch:number)=>void;embedded:boolean;onWindowed:()=>void;nodeExtensions?:NodeExtensions;inlineContainers?:true}
function SemanticEditor(props:SemanticEditorProps){
  const source=props.session
  const [selected,setSelected]=useState<{session:Session;admitted:boolean}|null>(null),[problem,setProblem]=useState<DocumentProblem|null>(null),[retry,setRetry]=useState(0)
  useEffect(()=>{
    const controller=new AbortController();setSelected(null);setProblem(null)
    void api(source,'/auth',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45_000)])}).then(response=>response.json()).then(async access=>{
      const authority=requireCollaborationSession({...access,collaborationProtocol:access.collaborationProtocol??legacyProtocol})
      if(props.inlineContainers||authority.collaborationProtocol===inlineProtocol){const negotiated=await negotiateSession({...source,...authority},controller.signal,{inlineContainers:true});if(!controller.signal.aborted)setSelected({session:{...source,...negotiated,scope:access.scope,userId:access.userId??source.userId,displayName:access.displayName??source.displayName},admitted:true});return}
      if(!controller.signal.aborted)setSelected({session:{...source,...authority,scope:access.scope,userId:access.userId??source.userId,displayName:access.displayName??source.displayName},admitted:false})
    }).catch(cause=>{if(!controller.signal.aborted)setProblem(classifyDocumentProblem(cause,'collaboration'))})
    return()=>controller.abort()
  },[source.documentId,source.token,source.apiUrl,source.collabUrl,source.collaborationEpoch,source.collaborationProtocol,props.inlineContainers,retry])
  const ready=useCallback((authority:CollaborationSession)=>setSelected(previous=>{
    if(!previous)return previous
    const same=authority.collaborationEpoch===previous.session.collaborationEpoch&&authority.collaborationProtocol===previous.session.collaborationProtocol
    return{session:same?previous.session:{...previous.session,...authority},admitted:same&&authority.collaborationProtocol===structuralProtocol}
  }),[])
  const refresh=useCallback(()=>setRetry(value=>value+1),[])
  if(!selected)return problem?<DocumentProblemView problem={problem} documentId={source.documentId} onRetry={refresh} onClose={props.allowClose===false?undefined:props.onClose}/>:<DocumentLoading documentId={source.documentId} onClose={props.allowClose===false?undefined:props.onClose}/>
  const session=selected.session,userId=session.userId||browserUserId()
  return <NodeExtensionsProvider value={props.nodeExtensions} session={session}><LocalDraftBootstrap key={`${session.collaborationEpoch}:${session.collaborationProtocol}`} session={session} userId={userId} onEpochChange={refresh} onClose={props.allowClose===false?undefined:props.onClose}>{binding=>selected.admitted?<LiveSemanticEditor {...props} session={session} onEpochChange={refresh} ydoc={binding.document} localJournal={binding.journal} localCopies={binding.copies} localUnavailable={binding.unavailable} claimDocument={binding.claim} />:<ProtocolUpgrade session={session} binding={binding} onReady={ready} onClose={props.allowClose===false?undefined:props.onClose}/>}</LocalDraftBootstrap></NodeExtensionsProvider>
}
type LiveSemanticProps=SemanticEditorProps&{ydoc:Y.Doc;localJournal:LocalDraftJournal|null;localCopies:LocalDraftCopy[];localUnavailable:boolean;claimDocument:()=>void}
/** Connections are effect-owned: an abandoned render never opens a socket. */
function LiveSemanticEditor(props:LiveSemanticProps){
  const {session,ydoc,claimDocument}=props,{t}=useI18n(),models=modelsFor(session),liveSchema=session.collaborationProtocol===inlineProtocol?inlineStructureSchema:structureSchema
  const inline=useInlineContainerExtensions(),inlineHistory=useRef(inline);inlineHistory.current=inline
  const nodeRegistry=useNodeExtensions(),historyRegistry=useRef(nodeRegistry);historyRegistry.current=nodeRegistry
  const [connection,setConnection]=useState<{document:Y.Doc;provider:HocuspocusProvider;saveAbort:AbortController;undoManager:Y.UndoManager}|null>(null)
  useEffect(()=>{
    claimDocument()
    const release=retainDocument(ydoc),saveAbort=new AbortController()
    const provider=new HocuspocusProvider({url:(session.collaborationProtocol===inlineProtocol?inlineCollaborationUrl:nodeEditCollaborationUrl)(session.collabUrl||import.meta.env.VITE_HCD_COLLAB_URL||'ws://127.0.0.1:8768'),name:`${session.documentId}:${session.collaborationEpoch??0}:${session.collaborationProtocol===inlineProtocol?'inlinecontainers1':'structure3'}:save4`,document:ydoc,token:session.token})
    const undoManager=new SemanticBlockStore(ydoc,liveSchema,undefined,models).undoManager(true,before=>{const ordinary=prepareExtensionHistoryGuard(before,historyRegistry.current),inline=models.inlineContainers?prepareInlineContainerHistoryGuard(before,inlineHistory.current.resolve):undefined;return ordinary||inline?after=>{ordinary?.(after);inline?.(after)}:undefined})
    setConnection({document:ydoc,provider,saveAbort,undoManager})
    return()=>{saveAbort.abort();provider.destroy();undoManager.destroy();release()}
  },[ydoc,claimDocument,session.documentId,session.collaborationEpoch,session.token,session.collabUrl,session.collaborationProtocol,liveSchema,models])
  if(!connection||connection.document!==ydoc||connection.saveAbort.signal.aborted)return <div className="embedded-loading">{t('openingDocument')}</div>
  return <ConnectedSemanticEditor {...props} provider={connection.provider} saveAbort={connection.saveAbort} undoManager={connection.undoManager}/>
}
function ConnectedSemanticEditor({session,onClose,onEpochChange,embedded,onWindowed,ydoc,localJournal,localCopies,localUnavailable,provider,saveAbort,undoManager}:LiveSemanticProps&{provider:HocuspocusProvider;saveAbort:AbortController;undoManager:Y.UndoManager}) {
  const { locale, t } = useI18n()
  const aiConfiguration=useAiConfiguration()
  const inlineRegistry=useInlineContainerExtensions(),inlineRegistryRef=useRef(inlineRegistry);inlineRegistryRef.current=inlineRegistry
  const models=modelsFor(session),liveSchema=session.collaborationProtocol===inlineProtocol?inlineStructureSchema:structureSchema
  const nodeRegistry=useNodeExtensions(),nodeRegistryVersion=nodeRegistry.snapshot(),nodeRegistryRef=useRef(nodeRegistry);nodeRegistryRef.current=nodeRegistry
  const deletionStore=useMemo(()=>new SemanticBlockStore(ydoc,liveSchema,undefined,models),[ydoc,liveSchema,models]),deletionConflicts=useDeletionReviews(deletionStore)
  const localDraftState=useSyncExternalStore(localJournal?.subscribe??emptySubscribe,localJournal?.snapshot??noLocalDraft)
  const nodeFileReady=useRef<()=>boolean>(()=>false),imageFileReadyAfterApply=useRef<()=>boolean>(()=>false)
  const nodeFiles=useEditorNodeResources({session,userId:session.userId||browserUserId(),localJournal,registry:nodeRegistry,ready:()=>nodeFileReady.current()})
  useEffect(()=>{
    if(nodeResourcePendingRef.current()){setStatus(previous=>previous==='saved'?'editing':previous);return}
    setError(previous=>previous==='__node_resource_pending__'?'':previous)
    if(provider.isSynced&&provider.configuration.websocketProvider.status==='connected')provider.sendStateless(JSON.stringify({type:'hcd-save-state'}))
  },[nodeRegistryVersion,nodeFiles.version,provider])
  const imageUploadGate=useRef(false)
  const imageDrafts = useMemo(() => new CollaborativeImageDraftStore(ydoc), [ydoc])
  const imageTasks=useSemanticImageTasks({session,userId:session.userId||browserUserId(),localJournal,document:ydoc,images:imageDrafts,ready:()=>nodeFileReady.current(),readyAfterApply:()=>imageFileReadyAfterApply.current(),synchronize:signal=>waitRestoreSync(provider,signal)})
  const nodeResourcePendingRef=useRef<()=>boolean>(()=>false);nodeResourcePendingRef.current=()=>nodeRegistryRef.current.resourceStatus().pending>0||nodeFiles.pending()||imageTasks.pending()
  async function nodeResourcesBlocked(){const client=nodeFiles.client;if(client&&await client.checkPending())return true;if(await imageTasks.checkPending())return true;return nodeResourcePendingRef.current()}
  const historyScope = useRef(session.scope)
  const historySession=useRef(session);historySession.current=session
  const wordHistory = useMemo(() => new SemanticHistory(imageDrafts, undoManager, () => historyScope.current !== 'write' || imageDrafts.saving || (imageDrafts.uploading||nodeResourcePendingRef.current()),async(id,signal)=>(await api(historySession.current,`/images/${encodeURIComponent(id)}`,{signal})).json(),Date.now,()=>historyScope.current==='write'), [ydoc, imageDrafts,undoManager])
  useSyncExternalStore(imageDrafts.subscribe, imageDrafts.snapshot)
  useSyncExternalStore(wordHistory.subscribe, wordHistory.snapshot)
  useEffect(() => wordHistory.connect(), [wordHistory])
  const [historyReview,setHistoryReview]=useState<{direction:'undo'|'redo';version:number}|null>(null)
  async function runHistory(direction: 'undo' | 'redo') {
    try { await wordHistory.step(direction);setHistoryReview(null);setError('') }
    catch (cause) {
      const key = cause instanceof ApiError&&cause.status===404?'historyDeleted':cause instanceof Error ? cause.message : ''
      if(['historyConflict','historyDeleted','historyPeerChanges','historyGuardUnavailable','historyExtensionUnavailable'].includes(key))setHistoryReview({direction,version:wordHistory.snapshot()})
      setError(['historyBusy', 'historyConflict', 'historyChanged', 'historyDeleted', 'historyInvalid', 'historyEmpty','historyPeerChanges','historyGuardUnavailable','historyExtensionUnavailable'].includes(key) ? t(key as MessageKey) : String(cause))
    }
  }
  const runHistoryRef=useRef(runHistory);runHistoryRef.current=runHistory
  const commandRegistryRef=useRef<CommandRegistry|null>(null)
  const blockTargetRef=useRef<BlockTarget|null>(null)
  const blockMenuRef=useRef<(()=>void)|null>(null)
  const [paletteOpen,setPaletteOpen]=useState(false)
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (session.scope==='read') return; if (imageDrafts.size || imageDrafts.saving||nodeResourcePendingRef.current()) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [imageDrafts, session.scope])
  const [scopeReadOnly, setReadOnly] = useState(session.scope === 'read')
  const [accessLocked, setAccessLocked] = useState(false)
  const accessLockedRef=useRef(accessLocked);accessLockedRef.current=accessLocked
  const [hasDocument, setHasDocument] = useState(false)
  const [canonicalReady, setCanonicalReady] = useState(false)
  const [saveConflict, setSaveConflict] = useState<SaveState | null>(null)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const saveConflictRef = useRef(saveConflict)
  saveConflictRef.current = saveConflict
  const acceptedReceipt = useRef<{ revision: number; digest: string; imageDigest: string; pending: boolean } | null>(null)
  const semanticDirty = useRef(false)
  const semanticGeneration = useRef(0)
  const exportGeneration=useRef(0)
  useEffect(()=>{const changed=()=>{exportGeneration.current++};ydoc.on('update',changed);return()=>ydoc.off('update',changed)},[ydoc])
  const semanticExportAnchor=useRef<{revision:number;sourceSha256:string;generation:number}|null>(null)
  const saveInFlight = useRef<Promise<number | null> | null>(null)
  const [historical, setHistorical] = useState<Projection | null>(null)
  const [restoreConfirmation,setRestoreConfirmation]=useState(false)
  const [restoreLocked,setRestoreLocked]=useState(false),restoreLockedRef=useRef(false)
  const [restoreSupported,setRestoreSupported]=useState(false),[restoreUncertain,setRestoreUncertain]=useState(false)
  const pendingRestore=useRef<RestoreSubmission|null>(null)
  const [revisionSelection,setRevisionSelection]=useState<RevisionSelection|null>(null)
  const [historyLoading,setHistoryLoading]=useState(false)
  const historyRequest=useRef<AbortController|null>(null)
  const liveScroll=useRef(0),documentScroll=useRef<HTMLDivElement>(null)
  const readOnly = restoreLocked || !!historical || historyLoading || accessLocked || scopeReadOnly || !hasDocument || !canonicalReady || !!saveConflict
  const nodeEdits=useExtensionEdits(ydoc,nodeRegistry,!readOnly),inlineEdits=useInlineContainerEdits(ydoc,inlineRegistry,!readOnly&&!!models.inlineContainers),codec=editorNodeCodec(nodeRegistry,inlineRegistry)
  historyScope.current=(readOnly||restoreLockedRef.current)?'read':session.scope
  const [status, setStatus] = useState<MessageKey>('connecting')
  const [revision, setRevision] = useState<number | null>(null)
  const [viewRevision, setViewRevision] = useState<number | null>(null)
  const [history, setHistory] = useState<RevisionItem[]>([])
  const [nextBefore, setNextBefore] = useState<number | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [protectedWordBlock,setProtectedWordBlock]=useState<string|null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkHref, setLinkHref] = useState('')
  const [presence, setPresence] = useState<Array<{ id: string; name: string; color: string; connections: number }>>([])
  const [layout, setLayout] = useState<LayoutPreferences>(readLayout)
  const [rightPanel, setRightPanel] = useState<'settings' | 'revisions' | 'properties' | 'images' | 'collaboration' | 'references' | 'node-conflicts' | 'deletions' | 'ai' | null>(null)
  const [referenceFocus,setReferenceFocus]=useState<{mentionId:string;requestId:string}|null>(null)
  const [historicalReference,setHistoricalReference]=useState<HistoricalReferenceNavigation|undefined>(undefined)
  const historicalReferenceRef=useRef(historicalReference);historicalReferenceRef.current=historicalReference
  const [historicalReferenceStatus,setHistoricalReferenceStatus]=useState<'pending'|'found'|'missing'|undefined>(undefined)
  useEffect(()=>{setHistoricalReference(undefined);setHistoricalReferenceStatus(undefined)},[historical?.revision])
  const [collaborationHost,setCollaborationHost]=useState<HTMLDivElement|null>(null)
  const [activeTab, setActiveTab] = useState<'home' | 'insert' | 'view' | 'revisions' | 'export'>('home')
  const [documentZoom, setDocumentZoom] = useState(100)
  const [outlineWidth, setOutlineWidth] = useState(190)
  const [sidebarWidth, setSidebarWidth] = useState(270)
  const [outline, setOutline] = useState<SemanticOutlineEntry[]>([])
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
  useEffect(()=>{if(accessLocked){provider.disconnect();setError('')}},[accessLocked,provider])
  useEffect(() => {
    const disconnect=imageDrafts.connect()
    const unsubscribe=imageDrafts.subscribe(()=> {
      semanticGeneration.current++
      if(provider.isSynced && provider.configuration.websocketProvider.status==='connected') provider.sendStateless(JSON.stringify({type:'hcd-save-state'}))
    })
    return ()=>{unsubscribe();disconnect()}
  },[imageDrafts,provider])
  const editor = useEditor({
    immediatelyRender:false,
    extensions: [...(models.inlineContainers?[SemanticInlineContainerNode.configure({registry:()=>inlineRegistryRef.current,onError:cause=>setError(String(cause))})]:[]),...schemaExtensions.map(extension=>extension.name==='hcdCustomMark'?extension.configure({registry:()=>nodeRegistryRef.current.marks,onUnsupportedPaste:()=>setError('__extension_paste_rejected__'),enabled:()=>session.collaborationProtocol===structuralProtocol||session.collaborationProtocol===inlineProtocol}):extension.name==='hcdExtensionPreservation'?extension.configure({onUnsupportedPaste:()=>setError('__extension_paste_rejected__'),registry:()=>nodeRegistryRef.current}):['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(extension.name)?extension.configure({registry:()=>nodeRegistryRef.current}):extension), Extension.create({name:'hcdUnifiedHistory',addCommands(){return{
      undo:()=>({tr,dispatch})=>{tr.setMeta('preventDispatch',true);if(!wordHistory.canUndo)return false;if(dispatch)void commandRegistryRef.current?.execute('edit.undo').catch(cause=>setError(t(commandMessage(cause)??'commandUnavailable')));return true},
      redo:()=>({tr,dispatch})=>{tr.setMeta('preventDispatch',true);if(!wordHistory.canRedo)return false;if(dispatch)void commandRegistryRef.current?.execute('edit.redo').catch(cause=>setError(t(commandMessage(cause)??'commandUnavailable')));return true},
    }},addKeyboardShortcuts(){return{'Mod-z':()=>{this.editor.commands.undo();return true},'Mod-y':()=>{this.editor.commands.redo();return true},'Shift-Mod-z':()=>{this.editor.commands.redo();return true}}}}), SemanticStructureCollaboration.configure({...models,document:ydoc,awareness:provider.awareness,user:localUser,canWrite:()=>historyScope.current==='write',onError:cause=>{if(cause instanceof Error&&cause.message==='semanticTextEditsLimit'){setError(t('textEditLimit'));return}if(cause instanceof Error&&cause.message==='deletion-review-limit'){setError(t('deletionReviewLimit'));return}if(cause instanceof Error&&cause.message==='node-edit-limit'){setError(t('nodeEditLimit'));return}setSaveConflict({type:'hcd-save-status',status:'conflict',conflict:'invalid-structure'});setStatus('saveConflict')}})],
    editable: !readOnly,
    editorProps: { attributes: { class: 'hcd-editor-body',role:'textbox','aria-multiline':'true','aria-label':t('documentContent') }, transformPasted: (slice, view) => clearPastedBlockIds(slice, (view.state.storedMarks || view.state.selection.$from.marks()).find(mark => mark.type.name === 'hcdSource')?.attrs.nodeId) },
    onUpdate: ({ editor: changedEditor }) => {
      const semantic = checkpointContents(jsonToSnapshot(changedEditor.getJSON(),models))
      if (lastSemantic.current !== null && semantic !== lastSemantic.current) { semanticGeneration.current++; semanticDirty.current = true; if (!scopeReadOnly) setStatus('editing') }
      lastSemantic.current = semantic
    },
  }, [ydoc,provider,wordHistory])
  useEffect(()=>{
    if(!editor||editor.isDestroyed||!layout.showOutline||historical)return
    return watchSemanticOutline(editor,()=>{if(editor.isDestroyed)return;const headings=semanticOutline(editor.state.doc),serialized=JSON.stringify(headings);if(serialized!==lastOutline.current){lastOutline.current=serialized;setOutline(headings)}})
  },[editor,layout.showOutline,historical])
  nodeFileReady.current=()=>!!localJournal&&localDraftState!=='failed'&&!readOnly&&!restoreLockedRef.current&&!imageUploadGate.current&&!accessLockedRef.current&&!wordHistory.busy&&!!editor&&!editor.isDestroyed&&provider.isSynced&&!provider.hasUnsyncedChanges&&provider.configuration.websocketProvider.status==='connected'
  imageFileReadyAfterApply.current=()=>!!localJournal&&localDraftState!=='failed'&&!readOnly&&!restoreLockedRef.current&&!imageUploadGate.current&&!accessLockedRef.current&&!!editor&&!editor.isDestroyed&&provider.configuration.websocketProvider.status==='connected'
  const editorRef = useRef(editor)
  editorRef.current = editor
  const businessProblem=(current:NonNullable<typeof editor>)=>businessDraftProblem(ydoc,current.state.doc,(current.storage as unknown as {hcdSemanticStructureCollaboration?:{store:SemanticBlockStore}}).hcdSemanticStructureCollaboration?.store??new SemanticBlockStore(ydoc,current.schema,undefined,models))
  const handoffRef=useRef({ready:async()=>false,committed:(_epoch:number)=>{}})
  const followingRestore=useRef(false)
  handoffRef.current={ready:()=>restoreHandoffReady({blocked:()=>imageDrafts.uploading||nodeResourcePendingRef.current()||wordHistory.busy||accessLockedRef.current,devicePending:nodeResourcesBlocked,drain:async()=>{await saveInFlight.current;await localJournal?.flush()},sync:()=>waitRestoreSync(provider,saveAbort.signal)}),committed:epoch=>{
    if(followingRestore.current)return;followingRestore.current=true
    const preserve=()=>{if(saveAbort.signal.aborted)return;setSaveConflict({type:'hcd-save-status',status:'conflict',conflict:'epoch-changed'});setStatus('saveConflict');setRecoveryOpen(true)}
    void followCommittedRestore({flush:async()=>{await localJournal?.flush()},devicePending:nodeResourcesBlocked,blocked:()=>imageDrafts.uploading||imageDrafts.saving||imageDrafts.size>0||nodeResourcePendingRef.current(),alive:()=>!saveAbort.signal.aborted,commit:()=>{semanticDirty.current=false;onEpochChange?.(epoch)}}).then(ok=>{if(!ok)preserve()},preserve).finally(()=>{followingRestore.current=false})
  }}
  useEffect(()=>installRestoreHandoff(provider,{
    freeze:()=>{restoreLockedRef.current=true;imageUploadGate.current=true;historyScope.current='read';editorRef.current?.setEditable(false);setRestoreLocked(true)},
    ready:()=>handoffRef.current.ready(),
    release:()=>{restoreLockedRef.current=false;imageUploadGate.current=false;setRestoreLocked(false)},
    committed:epoch=>handoffRef.current.committed(epoch),
  }),[provider])
  // ProseMirror documents are immutable. Selection, panel and presence updates
  // can re-render this component without changing the document, so avoid
  // repeatedly scanning its entire tree in those cases.
  const editorDoc=editor?.state.doc
  const referenceEdits=useReferenceEdits(ydoc),activeReferences=useMemo(()=>editorDoc?documentReferences(editorDoc):new Map(),[editorDoc]),referenceConflicts=[...referenceEdits.values()].filter(group=>activeReferences.has(group.root.mentionId)&&group.conflicted)
  useEffect(()=>{if(!referenceConflicts.length)setError(previous=>previous==='__reference_drafts_conflict__'?'':previous)},[referenceConflicts.length,error])
  useEffect(()=>{if(deletionConflicts.length){semanticDirty.current=true;setRightPanel('deletions');if(!scopeReadOnly)setStatus('editing')}else setError(previous=>previous==='__deletion_drafts_conflict__'?'':previous)},[deletionConflicts.length,scopeReadOnly])
  const selectedNode=useEditorState({editor,selector:({editor:current})=>current?selectedEditorNode(current.state):null})
  const activeNodeIds=useMemo(()=>editorDoc?editorNodes(editorDoc):new Map(),[editorDoc]),nodeProblems=[...nodeEdits.values(),...inlineEdits.values()].filter(group=>activeNodeIds.has(group.root.instanceId)&&(!group.ready||Object.keys(group.conflicts).length)),selectedNodeEdits=selectedNode?(selectedNode.value.schemaVersion==='hcd.extension/3'?inlineEdits.get(selectedNode.value.instanceId):nodeEdits.get(selectedNode.value.instanceId)):undefined
  useEffect(()=>{if(!scopeReadOnly&&(referenceConflicts.length||nodeProblems.length)){semanticDirty.current=true;setStatus('editing')}},[scopeReadOnly,referenceConflicts.length,nodeProblems.length])
  useEffect(()=>{if(editor&&!editor.isDestroyed)editor.view.dispatch(editor.state.tr.setMeta('hcd-node-registry',nodeRegistryVersion))},[editor,nodeRegistry,nodeRegistryVersion])
  const selectedFont = useEditorState({ editor, selector: ({ editor: current }) => current ? selectionTypography(current.state) : null })
  const aiLatest=useRef({revision,locale,readOnly});aiLatest.current={revision,locale,readOnly}
  const autoService=useRef<AiAutocompleteService|null>(null)
  const [autoEnabled,setAutoEnabled]=useState(aiConfiguration.autocomplete.enabled)
  const aiAdapter=(requireCaret=false)=>createSemanticAiAdapter({session,requireCaret,editor:()=>editorRef.current,store:()=>((editorRef.current?.storage as unknown as {hcdSemanticStructureCollaboration?:{store:SemanticBlockStore}})?.hcdSemanticStructureCollaboration?.store),canWrite:()=>!aiLatest.current.readOnly&&historyScope.current==='write'&&!wordHistory.busy&&!saveAbort.signal.aborted&&(!requireCaret||autoService.current?.eligible()===true),revision:()=>aiLatest.current.revision,locale:()=>aiLatest.current.locale,history:wordHistory})
  const aiController=useMemo(()=>aiConfiguration.provider&&editor?new AiSuggestionController(aiConfiguration.provider,aiAdapter(),aiConfiguration.options):null,[editor,aiConfiguration,session,wordHistory,saveAbort])
  const autoController=useMemo(()=>aiConfiguration.provider&&aiConfiguration.autocomplete.available&&editor?new AiSuggestionController(aiConfiguration.provider,aiAdapter(true),{...aiConfiguration.options,limits:{timeoutMs:Math.min(aiConfiguration.options.limits?.timeoutMs??120000,15000),maxOutput:Math.min(aiConfiguration.options.limits?.maxOutput??16000,aiConfiguration.autocomplete.maxOutput),maxEvents:Math.min(aiConfiguration.options.limits?.maxEvents??20000,2048)}}):null,[editor,aiConfiguration,session,wordHistory,saveAbort])
  const autoState=useSyncExternalStore(autoController?.subscribe??emptySubscribe,autoController?.snapshot??noAi,noAi)
  useEffect(()=>{setAutoEnabled(aiConfiguration.autocomplete.enabled);autoController?.dismiss()},[aiConfiguration.autocomplete.enabled,autoController])
  const aiState=useSyncExternalStore(aiController?.subscribe??emptySubscribe,aiController?.snapshot??noAi,noAi)
  const [aiComposer,setAiComposer]=useState<AiComposerEntry|null>(null)
  const openAiComposer=()=>{if(editor&&!editor.isDestroyed){autoService.current?.dismiss();setAiComposer({id:crypto.randomUUID(),bookmark:editor.state.selection.getBookmark()})}}
  const closeAiComposer=()=>{aiController?.cancel();setAiComposer(null)}
  useEffect(()=>{setAiComposer(null)},[editor,aiController])
  useEffect(()=>aiController?.connect(),[aiController])
  useEffect(()=>{
    if(!editor||!aiController)return
    const changed=()=>aiController.invalidate();editor.on('transaction',changed)
    return()=>{editor.off('transaction',changed)}
  },[editor,aiController])
  useEffect(()=>{if(readOnly){aiController?.invalidate();setAiComposer(null)}},[readOnly,aiController])
  useEffect(()=>{if(!aiComposer&&rightPanel!=='ai'&&['requesting','streaming','applying'].includes(aiController?.snapshot().phase??''))aiController?.cancel()},[rightPanel,aiComposer,aiController])
  const aiCan=(mode:'replace'|'insert')=>{const store=(editor?.storage as unknown as {hcdSemanticStructureCollaboration?:{store:SemanticBlockStore}})?.hcdSemanticStructureCollaboration?.store;return !!aiController&&!readOnly&&!!editor&&!!store&&store.initialized&&canAiSelection(editor.state,mode)}

  useEffect(() => {
    if (!editor) return
    const storage = editor.storage as unknown as { hcdIdentity: { locale: EditorLocale } }
    storage.hcdIdentity.locale = locale
    editor.view.dom.setAttribute('aria-label',t('documentContent'))
    editor.view.dispatch(editor.state.tr.setMeta('hcd-ui-locale', locale))
  }, [editor, locale])
  useEffect(() => {
    editor?.setEditable(!readOnly)
    if(editor&&!editor.isDestroyed)editor.view.dom.setAttribute('aria-readonly',String(readOnly))
  }, [editor, readOnly])
  useEffect(() => {
    const connection = ({ status: next }: { status: string }) => { setStatus(saveConflictRef.current ? 'saveConflict' : next === 'connected' ? 'connected' : 'connecting'); refreshPresence() }
    const synced = ({ state }: { state: boolean }) => { if (state) { setHasDocument(true); setStatus(saveConflictRef.current ? 'saveConflict' : 'synced'); provider.sendStateless(JSON.stringify({ type: 'hcd-save-state' })); refreshPresence(); setError(previous => previous === '__collab_not_ready__' ? '' : previous) } }
    const authenticationFailed = () => {if(!accessLockedRef.current)setError('__collab_not_ready__')}
    const saveState = ({ payload }: { payload: string }) => {
      let message: SaveState
      try { message = JSON.parse(payload) } catch { return }
      if (message.type !== 'hcd-save-status') return
      if(message.nodeEditVersion!==nodeEditWireVersion||message.inlineContainers!==(models.inlineContainers?1:undefined)){setCanonicalReady(false);setError('__node_model_upgrade__');return}
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
      if(message.problem==='deletion-drafts-conflict'){setRightPanel('deletions');setError('__deletion_drafts_conflict__');setStatus('saveFailed')}
      if(message.problem==='reference-drafts-conflict'){setRightPanel('references');setError('__reference_drafts_conflict__');setStatus('saveFailed')}
      if(message.problem==='word-field-read-only')setProtectedWordBlock(/^n_[a-f0-9]{32}$/.test(message.protectedBlockId??'')?message.protectedBlockId!:null)
      if(message.problem?.startsWith('node-drafts-')){setRightPanel('node-conflicts');setError(message.problem==='node-drafts-conflict'?'__node_drafts_conflict__':'__node_drafts_pending__')}
      if (message.status === 'failed'&&message.problem!=='deletion-drafts-conflict'&&message.problem!=='reference-drafts-conflict'&&!message.problem?.startsWith('node-drafts-')) { setStatus('saveFailed'); setError(message.problem==='word-field-read-only'?'__word_field_read_only__':message.problem==='word-source-required'?'__word_source_required__':message.problem==='image-drafts-not-ready'?'__image_geometry_invalid__':message.problem==='image-drafts-conflict'?'__image_collaboration_conflict__':'__autosave_retry__');if(message.problem?.startsWith('image-drafts-'))setRightPanel('images') }
      const currentEditor = editorRef.current
      if (message.status === 'saved' && currentEditor) {
        const generation = semanticGeneration.current
        void Promise.all([checkpointDigest(jsonToSnapshot(currentEditor.getJSON(),models)),imageDraftDigest(ydoc)]).then(([digest,imagesDigest]) => {
          if (saveAbort.signal.aborted || generation !== semanticGeneration.current) return
          const covered = digest === message.digest && imagesDigest===message.imageDigest && !message.pending && !imageDrafts.size && !(imageDrafts.uploading||nodeResourcePendingRef.current()) && !businessProblem(currentEditor)
          semanticDirty.current = !covered
          setStatus(covered ? 'saved' : 'editing')
          if (covered) { saveConflictRef.current = null; setSaveConflict(null); setProtectedWordBlock(null); setError(previous => previous === '__autosave_retry__' || previous === '__word_field_read_only__' || previous === '__word_source_required__' || previous === '__word_field_location_missing__' || previous === '__collab_not_ready__' && provider.isSynced && provider.configuration.websocketProvider.status === 'connected' || previous.startsWith('__image_') || previous.startsWith('__node_drafts_') ? '' : previous) }
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
    return () => { provider.off('status', connection); provider.off('synced', synced); provider.off('authenticationFailed', authenticationFailed); provider.off('stateless', saveState); provider.awareness?.off('change', refreshPresence) }
  }, [provider, ydoc, localUser, saveAbort, imageDrafts])
  useEffect(() => {
    let alive = true
    const controller=new AbortController()
    let interval:ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const [revisionResponse, authResponse] = await Promise.all([api(session, '/revisions',{signal:controller.signal}), api(session, '/auth',{signal:controller.signal})])
        const access = await authResponse.json() as { collaborationEpoch: number; collaborationProtocol?:string; scope?: string; access?: string;coordinatedRestore?:boolean }
        if(alive)setRestoreSupported(access.coordinatedRestore===true)
        if (session.scope === 'write' && !writeAllowed(access)) {
          if (alive) { setAccessLocked(true); setStatus('accessRevoked') }
          return
        }
        if (access.collaborationEpoch !== (session.collaborationEpoch ?? 0) || access.collaborationProtocol !== session.collaborationProtocol) {
          // The authority fence can close an old socket before its final
          // stateless commit notice arrives. A prepared window must also follow
          // the verified HTTP authority into the new epoch.
          if(alive&&restoreLockedRef.current){handoffRef.current.committed(access.collaborationEpoch);return}
          if (alive) { setSaveConflict({ type: 'hcd-save-status', status: 'conflict', conflict: 'epoch-changed' }); setStatus('saveConflict') }
          return
        }
        const result = await revisionResponse.json() as { headRevision: number; revisions: RevisionItem[]; nextBefore: number | null }
        if (!alive) return
        setRevision(previous => Math.max(previous ?? 0, result.headRevision))
        if (acceptedReceipt.current && result.headRevision > acceptedReceipt.current.revision && provider.configuration.websocketProvider.status === 'connected') provider.sendStateless(JSON.stringify({ type: 'hcd-save-state' }))
        setHistory(previous => Array.from(new Map([...previous, ...result.revisions].map(item => [item.revision, item])).values()).sort((a, b) => a.revision - b.revision))
        setNextBefore(previous => previous === undefined ? result.nextBefore : previous)
      } catch (cause) {
        if (!alive) return
        if (accessDenied(cause)) { setAccessLocked(true); setStatus('accessRevoked'); return }
        setError(String(cause))
      } finally {if(alive&&!accessLockedRef.current)interval=setTimeout(()=>void refresh(),5000)}
    }
    void refresh()
    return () => { alive = false; controller.abort();clearTimeout(interval) }
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
      if (semanticDirty.current || imageDrafts.size || imageDrafts.saving || nodeResourcePendingRef.current() || saveInFlight.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [imageDrafts, session.scope])
  async function performSave(): Promise<number | null> {
    if (!editor || revision === null) return null
    if(accessLockedRef.current){setStatus('accessRevoked');setRecoveryOpen(true);return null}
    if(wordHistory.busy){setError(t('historyBusy'));return null}
    if(nodeResourcePendingRef.current()){setError(imageTasks.pending()?'__image_upload_pending__':'__node_resource_pending__');return null}
    if(await nodeResourcesBlocked()){setError(imageTasks.pending()?'__image_upload_pending__':'__node_resource_pending__');return null}
    if(imageDrafts.uploading){setError('__image_upload_pending__');return null}
    if (saveConflict) { setError('__save_conflict__'); return null }
    if (!hasDocument || !canonicalReady || !provider.isSynced || provider.hasUnsyncedChanges || provider.configuration.websocketProvider.status !== 'connected') {
      setError('__collab_not_ready__'); return null
    }
    setStatus('saving'); setError('')
    try {
      const [digest,imagesDigest] = await Promise.all([checkpointDigest(jsonToSnapshot(editor.getJSON(),models)),imageDraftDigest(ydoc)])
      if (scopeReadOnly) {
        const receipt = acceptedReceipt.current
        if (!receipt || receipt.pending || receipt.digest !== digest || receipt.imageDigest!==imagesDigest || businessProblem(editor)) { setError('__newer_changes__'); return null }
        return receipt.revision
      }
      if(await nodeResourcesBlocked()){setError(imageTasks.pending()?'__image_upload_pending__':'__node_resource_pending__');setStatus('editing');return null}
      const reply = await requestCoordinatedSave(provider, digest, saveAbort.signal,45_000,imagesDigest)
      if(reply.inlineContainers!==(models.inlineContainers?1:undefined))throw new Error('coordinatorUnavailable')
      if (reply.type !== 'hcd-save-status') throw new Error('coordinatorUnavailable')
      if (reply.status === 'conflict') { setSaveConflict(reply); setStatus('saveConflict'); return null }
      if(reply.problem==='deletion-drafts-conflict'){setRightPanel('deletions');setStatus('saveFailed');setError('__deletion_drafts_conflict__');return null}
      if(reply.problem==='reference-drafts-conflict'){setRightPanel('references');setStatus('saveFailed');setError('__reference_drafts_conflict__');return null}
      if(reply.problem==='word-source-required'){setStatus('saveFailed');setError('__word_source_required__');return null}
      if(reply.problem==='word-field-read-only'){setProtectedWordBlock(/^n_[a-f0-9]{32}$/.test(reply.protectedBlockId??'')?reply.protectedBlockId!:null);setStatus('saveFailed');setError('__word_field_read_only__');return null}
      if(reply.problem?.startsWith('node-drafts-')){setRightPanel('node-conflicts');setStatus('saveFailed');setError(reply.problem==='node-drafts-conflict'?'__node_drafts_conflict__':'__node_drafts_pending__');return null}
      if(reply.problem==='image-drafts-not-ready' || reply.problem==='image-drafts-conflict') {setRightPanel('images');setStatus('saveFailed');setError(reply.problem==='image-drafts-not-ready'?'__image_geometry_invalid__':'__image_collaboration_conflict__');return null}
      if (reply.status === 'failed' || !Number.isSafeInteger(reply.revision)) throw new Error('coordinatorUnavailable')
      const generation=semanticGeneration.current
      const [current,currentImages] = await Promise.all([checkpointDigest(jsonToSnapshot(editor.getJSON(),models)),imageDraftDigest(ydoc)])
      const covered = generation===semanticGeneration.current && !reply.pending && current === reply.digest && currentImages===reply.imageDigest && !imageDrafts.size && !(imageDrafts.uploading||nodeResourcePendingRef.current()) && !businessProblem(editor)
      setRevision(previous => Math.max(previous ?? 0, reply.revision!))
      semanticDirty.current = !covered
      if (!covered) { setStatus('editing'); setError('__newer_changes__'); return null }
      setStatus('saved'); return reply.revision!
    } catch { if(accessLockedRef.current){setStatus('accessRevoked');return null}setStatus('saveFailed'); setError('__coordinator_unavailable__'); return null }
  }
  function saveUnlocked(): Promise<number | null> {
    if (saveInFlight.current) return saveInFlight.current
    const work = performSave().then(async saved=>{
      if(saved===null)return null
      const generation=semanticGeneration.current
      try{await localJournal?.flush()}catch{/* Canonical receipt still authorizes the saved document; local failure remains visible. */}
      if(await nodeResourcesBlocked()){setStatus('editing');setError(imageTasks.pending()?'__image_upload_pending__':'__node_resource_pending__');return null}
      if(generation!==semanticGeneration.current || semanticDirty.current || imageDrafts.size || (imageDrafts.uploading||nodeResourcePendingRef.current()) || !editor || businessProblem(editor)){setError('__newer_changes__');return null}
      return saved
    }).finally(() => { if (saveInFlight.current === work) saveInFlight.current = null })
    saveInFlight.current = work
    return work
  }
  function save(): Promise<number | null> { return nodeFiles.withFileLock(saveUnlocked) }
  const semanticExportBlocked=(at:number)=>saveAbort.signal.aborted||accessLockedRef.current||restoreLockedRef.current||!!saveConflictRef.current||semanticDirty.current||imageDrafts.size>0||imageDrafts.saving||imageDrafts.uploading||wordHistory.busy||nodeResourcePendingRef.current()||!editor||editor.isDestroyed||!!businessProblem(editor)||!provider.isSynced||provider.hasUnsyncedChanges||provider.configuration.websocketProvider.status!=='connected'||!!acceptedReceipt.current&&(acceptedReceipt.current.pending||acceptedReceipt.current.revision>at)
  const beforeSemanticExport=async()=>{semanticExportAnchor.current=null;const at=await saveUnlocked();if(at===null)return null;const generation=exportGeneration.current;try{semanticExportAnchor.current=await semanticExportHead(session,at,generation,()=>exportGeneration.current,()=>semanticExportBlocked(at),nodeResourcesBlocked,AbortSignal.any([saveAbort.signal,AbortSignal.timeout(30000)]));return at}catch{setError('__newer_changes__');return null}}
  const beforeSemanticDownload=async(at:number,signal:AbortSignal)=>{try{const anchor=semanticExportAnchor.current;if(!anchor||anchor.revision!==at)throw new Error('semantic-export-changed');await semanticExportHead(session,at,anchor.generation,()=>exportGeneration.current,()=>semanticExportBlocked(at),nodeResourcesBlocked,signal,anchor)}catch{throw new Error(t('fixedExportChanged'))}}
  async function useLatest() {
    if((imageDrafts.uploading||nodeResourcePendingRef.current()))throw new Error(t(nodeResourcePendingRef.current()?'nodeResourcePending':'imageUploadPending'))
    imageUploadGate.current=true
    try {
    if(await nodeResourcesBlocked())throw new Error(t('nodeResourcePending'))
    if (!editor) throw new Error(t('collaborationSaveNotReady'))
    const captured=Array.from(Y.encodeStateVector(ydoc)).join(',')
    // This backup includes offline edits even when the old room cannot be
    // authenticated or its sidecar is unavailable. Never require that stale
    // WebSocket to reconnect in order to keep the user's local CRDT.
    await api(session, '/collaboration/recovery', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-HCD-Collaboration-Epoch': String(session.collaborationEpoch ?? 0) }, body: new Blob([new Uint8Array(Y.encodeStateAsUpdate(ydoc)).buffer]) })
    const access = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
    let epoch = access.collaborationEpoch
    if(await nodeResourcesBlocked())throw new Error(t('nodeResourcePending'))
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
    if(await nodeResourcesBlocked())throw new Error(t('nodeResourcePending'))
    if (Array.from(Y.encodeStateVector(ydoc)).join(',')!==captured) throw new Error(t('newerChangesRemain'))
    semanticDirty.current = false
    onEpochChange?.(epoch)
    } finally { imageUploadGate.current=restoreLockedRef.current }
  }
  useEffect(()=>()=>historyRequest.current?.abort(),[])
  async function showRevision(number:number){
    historyRequest.current?.abort();const controller=new AbortController();historyRequest.current=controller
    setHistoryLoading(true);setError('')
    try{
      const head=revision??(await(await api(session,'/revisions?limit=1',{signal:controller.signal})).json()).headRevision
      const [before,after]=await Promise.all([api(session,`/editor?revision=${number}`,{signal:controller.signal}).then(response=>response.json()),api(session,`/editor?revision=${head}`,{signal:controller.signal}).then(response=>response.json())]) as [Projection,Projection]
      if(before.revision!==number||after.revision!==head)throw new Error(t('revisionPreviewUnavailable'))
      if(controller.signal.aborted)return
      if(!historical)liveScroll.current=documentScroll.current?.scrollTop??0
      const item=history.find(item=>item.revision===number)
      setHistorical(before);setRevisionSelection({before,after,author:item?.authorName||(number===0?t('initialImport'):undefined),createdAt:item?.createdAtEpochMs});setRightPanel('revisions');setMenu(null);setPaletteOpen(false);setLinkOpen(false)
      requestAnimationFrame(()=>{if(!controller.signal.aborted)documentScroll.current?.scrollTo({top:0})})
    }catch(cause){if(!controller.signal.aborted)setError(String(cause))}
    finally{if(!controller.signal.aborted)setHistoryLoading(false)}
  }
  function closeHistorical(){historyRequest.current?.abort();setHistoryLoading(false);setHistorical(null);setRevisionSelection(null);requestAnimationFrame(()=>documentScroll.current?.scrollTo({top:liveScroll.current}))}

  async function restoreHistorical() {
    if (!historical || !revisionSelection || accessLocked || scopeReadOnly || session.scope!=='write') throw new Error(t('readOnlyMode'))
    if(!pendingRestore.current){
      const head=await save()
      if(head===null)throw new Error(t('restoreCouldNotConfirm'))
      if(head!==revisionSelection.after.revision)throw new Error(t('restoreComparisonChanged'))
      pendingRestore.current={requestId:crypto.randomUUID().replaceAll('-',''),target:historical.revision,expectedRevision:head,fromEpoch:session.collaborationEpoch??0}
    }
    try {
      const receipt=await submitRestore({...session,collabUrl:session.collabUrl||import.meta.env.VITE_HCD_COLLAB_URL},pendingRestore.current,saveAbort.signal)
      pendingRestore.current=null;restoreLockedRef.current=true;imageUploadGate.current=true;historyScope.current='read';editorRef.current?.setEditable(false);setRestoreLocked(true);handoffRef.current.committed(receipt.collaborationEpoch)
    } catch (cause) {
      if(cause instanceof RestoreClientError&&!cause.uncertain)pendingRestore.current=null
      setRestoreUncertain(cause instanceof RestoreClientError&&cause.uncertain)
      throw new Error(t(cause instanceof RestoreClientError&&cause.uncertain?'restoreOutcomeUnknown':cause instanceof RestoreClientError&&['restore-client-busy','restore-online-clients'].includes(cause.code)?'restoreOtherClientBusy':'restoreComparisonChanged'))
    }
  }
  function openLink() {
    if (!editor || readOnly) return
    setLinkHref(String(editor.getAttributes('link').href || ''))
    setLinkOpen(true)
  }
  const commands=useCommands(instanceId=>({
    instanceId,documentId:session.documentId,format:session.format,profile:'flow',locale,platform:/Mac|iPhone|iPad/.test(navigator.platform)?'mac':'other',ready:!!editor&&hasDocument&&canonicalReady&&!historical&&!historyLoading,readOnly,revision,historical:!!historical,
    selection:(()=>{const selection=semanticSelection(editor,semanticGeneration.current,models.inlineContainers?inlineRegistry:undefined),group=selection.nodeId?((models.inlineContainers?inlineContainerEditIndex(ydoc).get(selection.nodeId):undefined)??extensionEditIndex(ydoc).get(selection.nodeId)):undefined;return{...selection,customMarkTypes:editor?(editor.state.selection.empty?(editor.state.storedMarks??editor.state.selection.$from.marks()).filter(mark=>mark.type.name==='hcdCustomMark').map(mark=>mark.attrs.value.type):selectedCustomMarkTypes(editor.state.doc,editor.state.selection.from,editor.state.selection.to)):[],protected:selection.protected||!!editor&&unavailableCustomMark(editor.state.doc,editor.state.selection.from,editor.state.selection.to,nodeRegistry.marks),...(group?{nodeEdits:{ids:group.ids,conflicts:group.conflicts,ready:group.ready}}:{})}})(),capabilities:{outlineSnapshot:true,inlineContainers:!!models.inlineContainers,recoveryFiles:session.collaborationProtocol===structuralProtocol||session.collaborationProtocol===inlineProtocol,text:true,blocks:true,images:true,customMarks:(session.collaborationProtocol===structuralProtocol||session.collaborationProtocol===inlineProtocol)&&nodeRegistry.listMarks().length>0,customNodes:(session.collaborationProtocol===structuralProtocol||session.collaborationProtocol===inlineProtocol)&&(nodeRegistry.list().length>0||!!models.inlineContainers&&inlineRegistry.list().length>0),mentions:session.collaborationProtocol===structuralProtocol||session.collaborationProtocol===inlineProtocol,ai:!!aiController,aiAutocomplete:!!autoController},
    actions:{
      'outline.snapshot.insert':{enabled:!!editor&&editor.state.selection.empty&&!readOnly&&!wordHistory.busy},
      'view.properties':{enabled:true,active:rightPanel==='properties'||rightPanel==='images'},
      'view.collaboration':{enabled:true,active:rightPanel==='collaboration'},
      'view.navigation':{enabled:!historical,active:layout.showOutline&&!historical},
      'view.settings':{enabled:true,active:rightPanel==='settings'},
      'view.actualSize':{enabled:true,active:documentZoom===100},'view.zoom.set':{enabled:true},
      'view.readOnly':{enabled:session.scope==='write'&&!accessLocked&&!historical&&!historyLoading&&!restoreLocked,active:readOnly},
      'view.panel.close':{enabled:!!rightPanel},
      'revision.history':{enabled:true,active:rightPanel==='revisions'},
      'revision.save':{enabled:!readOnly&&status!=='saving'&&!wordHistory.busy&&!imageDrafts.uploading&&!nodeResourcePendingRef.current()},
      'file.recovery':{enabled:session.collaborationProtocol===structuralProtocol||session.collaborationProtocol===inlineProtocol,active:recoveryOpen},'revision.localCopies':{enabled:true,active:recoveryOpen},
      'revision.open':{enabled:revision!==null&&!restoreLocked&&!restoreUncertain},
      'revision.current':{enabled:(!!historical||historyLoading)&&!restoreLocked&&!restoreUncertain},
      'revision.restore.review':{enabled:!!historical&&!!revisionSelection&&restoreSupported&&session.scope==='write'&&!accessLocked&&!scopeReadOnly&&!restoreLocked&&!restoreUncertain&&!historyLoading},
      ...semanticActionStates(editor),'mark.apply':{enabled:!!editor&&editor.state.selection.$from.parent.inlineContent&&editor.state.selection.$from.parent.type.name!=='codeBlock'},'mark.toggle':{enabled:!!editor&&editor.state.selection.$from.parent.inlineContent&&editor.state.selection.$from.parent.type.name!=='codeBlock'},'mark.remove':{enabled:!!editor&&(editor.state.selection.empty?(editor.state.storedMarks??editor.state.selection.$from.marks()).some(mark=>mark.type.name==='hcdCustomMark'):editor.state.doc.rangeHasMark(editor.state.selection.from,editor.state.selection.to,editor.schema.marks.hcdCustomMark))},'ai.autocomplete.toggle':{enabled:!!autoController&&(!readOnly||autoEnabled),active:autoEnabled},'ai.autocomplete.accept':{enabled:autoState.phase==='ready'&&autoService.current?.ready()===true},'ai.autocomplete.dismiss':{enabled:!!autoState.requestId},'ai.open':{enabled:true,active:!!aiComposer||rightPanel==='ai'},'ai.compose':{enabled:aiCan('insert')},'ai.cancel':{enabled:['requesting','streaming','applying'].includes(aiState.phase)},'ai.dismiss':{enabled:!!aiState.requestId},'ai.locate':{enabled:!!aiState.requestId},'ai.replace':{enabled:aiCan('replace')},'ai.insert':{enabled:aiCan('insert')},'ai.request':{enabled:aiCan('replace')||aiCan('insert')},'ai.accept':{enabled:aiState.phase==='ready'},'node.insert':{enabled:!!editor&&(session.collaborationProtocol===structuralProtocol||session.collaborationProtocol===inlineProtocol)&&(canInsertExtension(editor.state)||!!blockTargetRef.current&&blockTargetRef.current.intent!=='operate'&&blockActionStates(editor.state,blockTargetRef.current)['text.insert']?.enabled===true)},'node.migrate':{enabled:!!selectedNode&&codec.migrationAvailable(selectedNode.value)&&(!selectedNodeEdits||selectedNodeEdits.ready&&!Object.keys(selectedNodeEdits.conflicts).length)},'node.resources':{enabled:!!selectedNode&&!!codec.resolve(selectedNode.value)&&!Object.keys(selectedNodeEdits?.conflicts??{}).length},'node.update':{enabled:!!selectedNode&&!!codec.resolve(selectedNode.value)&&!Object.keys(selectedNodeEdits?.conflicts??{}).length},'node.delete':{enabled:!!selectedNode&&!!codec.resolve(selectedNode.value)},'node.properties':{enabled:!!selectedNode},'deletion.review':{enabled:deletionConflicts.length>0},'deletion.restore':{enabled:deletionConflicts.length>0},'deletion.confirm':{enabled:deletionConflicts.length>0},'node.conflicts':{enabled:nodeProblems.length>0},'node.resolve':{enabled:!!selectedNodeEdits&&(!selectedNodeEdits.ready||Object.keys(selectedNodeEdits.conflicts).length>0)&&(!!selectedNodeEdits.conflicts['\u0000envelope']||!!codec.resolve(selectedNodeEdits.base))},'reference.retarget':{enabled:!!editor&&(session.collaborationProtocol===structuralProtocol||session.collaborationProtocol===inlineProtocol)},'reference.resolve':{enabled:!!editor&&referenceConflicts.length>0},'reference.keepSaved':{enabled:!!editor&&referenceConflicts.length>0},'reference.person':{enabled:!!editor&&(session.collaborationProtocol===structuralProtocol||session.collaborationProtocol===inlineProtocol)&&canMentionAt(editor.state)},'reference.person.insert':{enabled:!!editor&&(session.collaborationProtocol===structuralProtocol||session.collaborationProtocol===inlineProtocol)&&canMentionAt(editor.state)},'block.appendParagraph':{enabled:!!editor&&!readOnly},...(editor&&blockTargetRef.current?blockActionStates(editor.state,blockTargetRef.current):{}),'file.save':{enabled:!readOnly&&status!=='saving'&&!wordHistory.busy&&!(imageDrafts.uploading||nodeResourcePendingRef.current())},'file.export':{enabled:revision!==null,active:activeTab==='export'},'edit.undo':{enabled:!readOnly&&wordHistory.canUndo},'edit.redo':{enabled:!readOnly&&wordHistory.canRedo},'view.images':{enabled:!!editor,active:rightPanel==='images'},'view.references':{enabled:revision!==null&&!accessLocked,active:rightPanel==='references'},'editor.palette':{enabled:true,active:paletteOpen},'block.menu':{enabled:!!editor&&!readOnly&&blockActionStates(editor.state)['block.duplicate']?.enabled===true}},
  }),async(id,input,signal,insertion)=>{
    if(signal.aborted)return false
    if(id==='outline.snapshot.insert'){
      if(!editor||editor.isDestroyed||readOnly||wordHistory.busy)return false
      try{const transaction=wordOutlineSnapshotTransaction(editor.state,semanticOutline(editor.state.doc),t('untitledHeading'));if(!transaction){setError(t('wordOutlineSnapshotUnavailable'));return false}wordHistory.stopCapturing();try{editor.view.dispatch(transaction);editor.commands.focus()}finally{wordHistory.stopCapturing()}setError('');return true}catch{setError(t('wordOutlineSnapshotUnavailable'));return false}
    }
    if(insertion){
      if(!editor)return false
      const inline=(input as {model?:unknown})?.model==='inline'
      if(inline&&session.collaborationProtocol!==inlineProtocol)return false
      const request=id==='node.insert'?{extension:(inline?inlineRegistry:nodeRegistry).create((input as {type:string})?.type,(input as {data?:Record<string,unknown>})?.data)}:input
      const commit='kind'in insertion.target?prepareBlockTransaction(editor,id,request,insertion.target):prepareSlashTransaction(editor,id,request,insertion.target)
      if(!commit)return false
      insertion.stage(()=>{wordHistory.stopCapturing();try{const applied=commit();if(applied&&id==='ai.compose'){aiController?.dismiss();openAiComposer()}return applied}finally{wordHistory.stopCapturing()}})
      return true
    }
    if(id==='ai.autocomplete.toggle'){autoService.current?.dismiss();setAutoEnabled(value=>!value);return true}
    if(id==='ai.autocomplete.accept')return autoService.current?.accept((input as {requestId?:string})?.requestId??autoController?.snapshot().requestId??'')??false
    if(id==='ai.autocomplete.dismiss'){autoService.current?.dismiss();return true}
    if(id==='ai.open'){aiController?.dismiss();openAiComposer();return true}
    if(id==='ai.request'){
      const request=input as {actionId?:string;instruction?:string},action=aiConfiguration.actions.find(action=>action.id===request?.actionId)
      if(!aiController||!action)return false
      autoService.current?.dismiss();if(!aiComposer)openAiComposer();void aiController.start(action,request.instruction??'');return true
    }
    if(id==='ai.accept'){const applied=await aiController?.accept((input as {requestId?:string})?.requestId??'')??false;if(applied)setAiComposer(null);return applied}
    if(id==='ai.cancel'){aiController?.cancel();return true}
    if(id==='ai.dismiss'){aiController?.dismiss();return true}
    if(id==='ai.locate')return aiController?.locate()??false
    if(id==='view.properties'||id==='view.collaboration'||id==='view.settings'){
      const target=id==='view.properties'?'properties':id==='view.collaboration'?'collaboration':'settings'
      const desired=input===undefined?undefined:toggleInput(id,input,false)
      setRightPanel(current=>panelTarget(desired,current,target,target==='properties'?['images']:[]));return true
    }
    if(id==='view.navigation'){setLayoutOption('showOutline',toggleInput(id,input,layout.showOutline));return true}
    if(id==='view.readOnly'){setReadOnly(toggleInput(id,input,scopeReadOnly));return true}
    if(id==='view.actualSize'){setDocumentZoom(100);return true}
    if(id==='view.zoom.set'){setDocumentZoom(zoomInput(input,'flow'));return true}
    if(id==='view.panel.close'){if(rightPanel==='ai')aiController?.cancel();setRightPanel(null);return true}
    if(id==='revision.history'){setRightPanel('revisions');setActiveTab('revisions');return true}
    if(id==='revision.save')return commandRegistryRef.current!.execute('file.save')
    if(id==='file.recovery'){setActiveTab('export');setRecoveryOpen(true);return true}
    if(id==='revision.localCopies'){setRecoveryOpen(toggleInput(id,input,recoveryOpen));return true}
    // The request owns cancellation and last-target-wins loading. Do not hold the
    // registry lock until the network completes, or rapid version choices are lost.
    if(id==='revision.open'){void showRevision(revisionInput(input,revision));return true}
    if(id==='revision.current'){closeHistorical();return true}
    if(id==='revision.restore.review'){setRestoreConfirmation(true);return true}
    if(id==='file.save')return save()
    if(id==='file.export'){setActiveTab('export');return true}
    if(id==='edit.undo'||id==='edit.redo')return runHistoryRef.current(id==='edit.undo'?'undo':'redo')
    if(id==='editor.palette'){setPaletteOpen(value=>!value);return true}
    if(id==='block.menu'){blockMenuRef.current?.();return true}
    if(id==='deletion.review'){setRightPanel('deletions');return true}
    if(id==='node.conflicts'){setRightPanel('node-conflicts');return true}
    if(id==='node.properties'){setRightPanel('properties');return true}
    if(id==='view.images'){setRightPanel('images');return true}
    if(id==='view.references'){const mentionId=(input as {mentionId?:unknown})?.mentionId;if(typeof mentionId==='string'&&/^m_[a-f0-9]{32}$/.test(mentionId))setReferenceFocus({mentionId,requestId:crypto.randomUUID()});setRightPanel('references');return true}
    if(!editor||editor.isDestroyed)return false
    if(id==='edit.copy'){await navigator.clipboard.writeText(editor.state.doc.textBetween(editor.state.selection.from,editor.state.selection.to,'\n'));return true}
    if(id==='edit.paste'){
      const anchor=commandRegistryRef.current!.context().selection.anchor,text=await navigator.clipboard.readText()
      if(signal.aborted)return false
      // Execute through the registry again after the asynchronous clipboard read.
      if(commandRegistryRef.current!.context().selection.anchor!==anchor)throw new Error(t('commandSelectionChanged'))
      return commandRegistryRef.current!.execute('text.insert',{text})
    }
    wordHistory.stopCapturing()
    try{
      if(id==='text.fontSize.set')return applyFontSizeCommand(editor,input)
      if(id==='deletion.restore'||id==='deletion.confirm'){const group=input as DeletionReview;if(!group||typeof group.key!=='string'||typeof group.snapshot!=='string')throw new Error(t('deletionReviewChanged'));const current=deletionConflicts.find(item=>item.key===group.key);if(!current||id==='deletion.confirm'&&!canConfirmDeletion(deletionStore,current,nodeRegistry,inlineRegistry))throw new Error(t('deletionCodecRequired'));if(current.inline&&id==='deletion.restore')await restoreInlineDeletion(session,{key:group.key,receipt:group.receipt,snapshot:group.snapshot},signal);else resolveDeletionReview(deletionStore,group,id==='deletion.restore'?'restore':'delete');return true}
      if(id==='node.resolve'){const request=input as {instanceId:string;ids:string[];choices:Record<string,string>};if(!selectedNode||selectedNode.value.instanceId!==request?.instanceId)return false;return selectedNode.value.schemaVersion==='hcd.extension/3'?resolveInlineContainerEdits(ydoc,inlineRegistry,request.instanceId,request.ids,request.choices,semanticBlockOrigin):resolveExtensionEdits(ydoc,nodeRegistry,request.instanceId,request.ids,request.choices,semanticBlockOrigin)}
      if(id==='mark.apply'||id==='mark.remove'||id==='mark.toggle'){
       try{const request=input as {type?:unknown;data?:Record<string,unknown>};if(typeof request?.type!=='string')return false;const value=nodeRegistry.createMark(request.type,request.data),tr=editor.state.tr;if(!applyCustomMark(tr,value,id==='mark.remove'||id==='mark.toggle'&&commandRegistryRef.current!.context().selection.customMarkTypes?.includes(value.type)===true)||!nodeRegistry.marks.resolve(value))return false;const before=editor.state.doc;editor.view.dispatch(tr.scrollIntoView());editor.view.focus();return tr.storedMarksSet||editor.state.doc!==before}
       catch(cause){if(cause instanceof Error&&['customMarkLimit','customMarkUnavailable','customMarkInvalidData'].includes(cause.message))throw new Error(t(cause.message as MessageKey));throw cause}
      }
      if(['node.insert','node.update','node.delete','node.migrate','node.resources'].includes(id)){const inline=(input as {model?:unknown})?.model==='inline'||!!selectedInlineContainer(editor.state);if(inline&&session.collaborationProtocol!==inlineProtocol)return false;const prepared=inline?prepareInlineContainerTransaction(editor,inlineRegistry,id,input):prepareNodeTransaction(editor,nodeRegistry,id,input);if(!prepared?.commit())return false;return prepared.value??true}
      if(id==='reference.keepSaved'){
       const store=(editor.storage as unknown as {hcdSemanticStructureCollaboration?:{store:SemanticBlockStore}}).hcdSemanticStructureCollaboration?.store,anchor=commandRegistryRef.current!.context()
       if(!store?.initialized)return false
       return await keepSavedReference(editor,store,nodeRegistry,input as SavedReferenceChoice,{documentId:session.documentId,signal,inlineRegistry,stopCapturing:()=>wordHistory.stopCapturing(),ready:()=>{const current=commandRegistryRef.current!.context();return current.instanceId===anchor.instanceId&&current.documentId===anchor.documentId&&current.ready&&!current.readOnly&&!current.historical},read:async(route,cancellation)=>(await api(session,route,{signal:cancellation,cache:'no-store'})).json()})
      }
      if(id==='reference.retarget'||id==='reference.resolve'){
       const store=(editor.storage as unknown as {hcdSemanticStructureCollaboration?:{store:SemanticBlockStore}}).hcdSemanticStructureCollaboration?.store
       if(!store?.initialized)return false
       wordHistory.stopCapturing();try{if(id==='reference.retarget'){const request=input as {expected:unknown;candidate:MentionCandidate};return retargetReference(editor,store,nodeRegistry,request.expected,request.candidate,inlineRegistry)}return chooseReferenceCandidate(editor,store,nodeRegistry,input as {mentionId:string;ids:string[];candidateId:string},inlineRegistry)}finally{wordHistory.stopCapturing()}
      }
      if(id==='reference.person'){const tr=startMentionTransaction(editor.state);if(!tr)return false;editor.view.dispatch(tr);editor.view.focus();return true}
      if(id==='reference.person.insert'){const value=input as {match:MentionMatch;candidate:MentionCandidate};if(!value?.match||!value.candidate)return false;return insertMention(editor,value.match,value.candidate)}
      if(id==='block.appendParagraph')return editor.chain().insertContentAt(editor.state.doc.content.size,{type:'paragraph'}).focus('end').run()
      if(id==='text.insert'){
        const text=(input as {text?:unknown})?.text
        if(typeof text!=='string'||!text.length||text.length>1_000_000)throw new Error(t('commandUnavailable'))
        const content=text.replaceAll('\r\n','\n').split('\n').flatMap((line,index)=>[...(index?[{type:'hardBreak'}]:[]),...(line?[{type:'text',text:line}]:[])])
        return editor.chain().focus().insertContent(content).run()
      }
      if(['text.bold','text.italic','text.underline','text.strike'].includes(id))return editor.chain().focus().toggleMark(id.slice(5)).run()
      if(blockOperations.includes(id)){const target=blockTarget(editor.state);return target?prepareBlockTransaction(editor,id,input,target)?.()??false:false}
      if(id==='text.link.open'){openLink();return true}
      if(id==='text.link.clear')return editor.chain().focus().extendMarkRange('link').unsetLink().run()
      if(id==='text.link.set'){
        const href=(input as {href?:unknown})?.href
        if(typeof href!=='string'||href.length>2048)throw new Error(t('linkInvalid'))
        const url=new URL(href);if(!['http:','https:','mailto:'].includes(url.protocol))throw new Error(t('linkInvalid'))
        const applied=editor.chain().focus().extendMarkRange('link').setLink({href:url.href}).run();if(applied)setLinkOpen(false);return applied
      }
      if(id==='text.color'||id==='text.highlight'){
        const color=(input as {color?:unknown})?.color;if(typeof color!=='string'||!/^#[a-f0-9]{6}$/i.test(color))throw new Error(t('commandUnavailable'))
        return editor.chain().focus().setMark(id==='text.color'?'textColor':'textBackground',{color}).run()
      }
      if(id==='text.color.clear'||id==='text.highlight.clear')return editor.chain().focus().unsetMark(id==='text.color.clear'?'textColor':'textBackground').run()
      if(id==='text.border')return editor.chain().focus().setMark('textBorder',{color:'#1f2328',widthPt:1,style:'solid'}).run()
      if(id==='text.border.clear')return editor.chain().focus().unsetMark('textBorder').run()
      throw new Error(t('commandUnavailable'))
    }finally{wordHistory.stopCapturing()}
  },cause=>setError(commandMessage(cause)?t(commandMessage(cause)!):String(cause)))
  const blocks=useBlockControls(editor,commands.registry,commands.block,target=>{blockTargetRef.current=target;commands.registry.refresh()},readOnly||paletteOpen||!!menu||linkOpen||!!aiComposer)
  blockMenuRef.current=blocks.openSelected
  const slash=useSlashMenu(editor,commands.registry,commands.insert,readOnly||paletteOpen||!!menu||linkOpen||blocks.active||!!aiComposer)
  const mentions=useMentionMenu(editor,session,readOnly||(session.collaborationProtocol!==structuralProtocol&&session.collaborationProtocol!==inlineProtocol)||paletteOpen||!!menu||linkOpen||!!aiComposer||blocks.active||slash.active,(match,candidate)=>commands.registry.execute('reference.person.insert',{match,candidate}))
  const inspector=useMentionInspector(editor,session,accessLocked||historyLoading||!!historical||!canonicalReady||paletteOpen||!!menu||linkOpen||!!aiComposer||blocks.active||slash.active||mentions.active,mentionId=>{void commands.registry.execute('view.references',{mentionId}).catch(()=>{})})
  async function commitNodeResource(draft:WordNodeResourceDraft<ResourceNodePayload>,expected:ResourceNodePayload){
    const current=editorRef.current
    if(!current||current.isDestroyed||draft.regionId!=='body'||expected.instanceId!==draft.expected.instanceId||expected.type!==draft.expected.type||!editorNodeCodec(nodeRegistryRef.current,inlineRegistryRef.current).resolve(expected))throw new Error('word-node-resource-target-changed')
    const resources=expected.resources??[],same=resources.find(value=>value.key===draft.resource.key)
    if(same){const selected=selectedEditorNode(current.state);if(stableExtension(same)!==stableExtension(draft.resource)||!selected||stableExtension(selected.value)!==stableExtension(expected))throw new Error('word-node-resource-target-changed');return expected}
    const result=await commands.registry.execute('node.resources',{instanceId:expected.instanceId,expected,resources:[...resources,draft.resource]})
    if(!result||typeof result!=='object')throw new Error('word-node-resource-target-changed');return expected.schemaVersion==='hcd.extension/3'?readInlineContainerPayload(result):readExtensionNode(result)
  }
  async function archiveNodeFile(file:File,expected:ResourceNodePayload){
    if(!nodeFiles.client)throw new Error('word-node-resource-unavailable');let result:ResourceNodePayload|undefined
    await nodeFiles.client.start(file,expected,'body',async staged=>{result=await commitNodeResource(staged,expected);return result})
    if(!result)throw new Error('word-node-resource-target-changed');return result
  }
  async function attachNodeFile(draft:WordNodeResourceDraft<ResourceNodePayload>,expected:ResourceNodePayload){if(!nodeFiles.client)throw new Error('word-node-resource-unavailable');await nodeFiles.client.attach(draft.id,staged=>commitNodeResource(staged,expected))}
  commandRegistryRef.current=commands.registry
  const autocomplete=useAiAutocomplete({editor,controller:autoController,state:autoState,policy:aiConfiguration.autocomplete,enabled:autoEnabled,blocked:readOnly||!!aiComposer||paletteOpen||!!menu||linkOpen||blocks.active||slash.active||mentions.active||inspector.active||rightPanel==='ai'||recoveryOpen||!!historyReview||wordHistory.busy,online:provider.isSynced&&provider.configuration.websocketProvider.status==='connected',onAccept:requestId=>commands.run('ai.autocomplete.accept',{requestId})})
  autoService.current=autocomplete
  // Tiptap dispatches an options transaction when shouldShow changes. Keep the
  // predicate stable across transaction-driven UI renders to avoid a feedback loop.
  const showSelectionMenu=useCallback(({state}:{state:EditorState})=>!readOnly&&!aiComposer&&!blocks.active&&!slash.active&&!mentions.active&&!inspector.active&&!state.selection.empty&&commands.registry.list('bubble').some(item=>item.enabled),[readOnly,aiComposer,blocks.active,slash.active,mentions.active,inspector.active,commands.registry])
  useEffect(()=>{if(!editor)return;const refresh=()=>commands.registry.refresh();editor.on('transaction',refresh);return()=>{editor.off('transaction',refresh)}},[editor,commands.registry])
  const actions=commands.registry.list('context').map(item=>({id:item.id,label:item.label,disabled:!item.enabled,active:item.active,shortcut:item.shortcuts.map(key=>displayShortcut(key,commands.registry.context().platform)).join(' / '),action:()=>commands.run(item.id)}))
  return <div className={`workspace semantic-workspace ${blocks.active?'hcd-block-operation-active':''} ${embedded ? 'embedded' : ''} ${layout.compact ? 'compact-header' : ''} ${layout.showOutline&&!historical ? '' : 'outline-hidden'} ${rightPanel ? '' : 'right-hidden'}`} onKeyDownCapture={event=>{if(editor&&!aiComposer&&!paletteOpen&&!menu&&!linkOpen&&!blocks.active&&event.target instanceof Node&&editor.view.dom.contains(event.target)&&aiSpaceEntry(editor.state,event.nativeEvent,aiCan('insert'))){event.preventDefault();event.stopPropagation();commands.run('ai.open');return}if(mentions.handleKey(event.nativeEvent)||slash.handleKey(event.nativeEvent)){event.preventDefault();event.stopPropagation();return}if(commands.registry.handleKey(event.nativeEvent,commandKeyScope(event.target),id=>{if(id!=='ai.autocomplete.accept')autocomplete.dismiss()})){event.preventDefault();event.stopPropagation();return}if(autocomplete.handleKey(event.nativeEvent)){event.preventDefault();event.stopPropagation()}}}>
    {commands.error&&<div className="local-draft-warning" role="alert">{t('commandConfigurationError')}</div>}
    {layout.showHeader && <header className="editor-header">
      <div className="document-identity"><span className="word-file-icon">{session.format === 'docx' ? 'W' : 'D'}</span><div className="document-title"><strong title={session.documentId}>{session.documentId}</strong><small role="status">{imageTasks.pending() ? t('wordUploadPending') : nodeResourcePendingRef.current() ? t('wordNodeResourceTasks') : imageDrafts.size ? t('unsavedImageCount', { count: imageDrafts.size }) : t(accessLocked?'accessRevoked':status)} · r{viewRevision ?? revision ?? '…'}</small></div></div>
      <div className="header-actions">
        {layout.showCollaborators && <CommandAction registry={commands.registry} run={commands.run} id="view.collaboration" className="presence presence-trigger" disclosure><span className="presence-avatars">{presence.slice(0,3).map(user=><span key={user.id} className="avatar" title={user.name} style={{background:user.color}}>{Array.from(user.name)[0]}</span>)}</span><span>{t('onlineCount',{count:presence.length})}</span></CommandAction>}
        <LocaleSelect /><CommandAction registry={commands.registry} run={commands.run} id="view.properties" className="settings-trigger word-icon-button" iconOnly disclosure/><button className="word-icon-button" aria-label={t('close')} onClick={() => { void nodeFiles.withFileLock(async()=>{ if(await nodeResourcesBlocked()){setError(imageTasks.pending()?'__image_upload_pending__':'__node_resource_pending__');return} if(accessLocked){if(!localJournal||localUnavailable){setRecoveryOpen(true);return}try{await localJournal.flush();onClose()}catch{setRecoveryOpen(true)}return} if (session.scope==='read') {onClose();return} if(saveConflict||semanticDirty.current||imageDrafts.size||imageDrafts.saving||nodeResourcePendingRef.current()||saveInFlight.current){if(await saveUnlocked()!==null)onClose();return} if(readOnly||!editor||revision===null){onClose();return} if(await saveUnlocked()!==null)onClose() }) }}><EditorIcon name="close" /></button>
      </div>
    </header>}
    {layout.showHeader && <nav className="presentation-tabs semantic-tabs" aria-label={t('editorFeatures')}>{(['home', 'insert', 'view', 'revisions', 'export'] as const).map(tab => <button key={tab} aria-pressed={activeTab === tab} onClick={() => { if(tab==='revisions')commands.run('revision.history');else setActiveTab(tab) }}>{t(tab)}</button>)}<span className="presentation-mode">{readOnly ? t('readOnly') : t('editable')}</span></nav>}
    {!layout.showHeader && <CommandAction registry={commands.registry} run={commands.run} id="view.settings" className="floating-settings" disclosure/>}
    {layout.showToolbar && <nav className="toolbar ribbon" aria-label={t('toolbar')}>
      <CommandRibbon registry={commands.registry} run={commands.run} tab={activeTab}/>
      {activeTab === 'view' && !models.inlineContainers && <><button onClick={() => { void nodeFiles.withFileLock(async()=>{if(await nodeResourcesBlocked()){setError(imageTasks.pending()?'__image_upload_pending__':'__node_resource_pending__');return}if(saveConflict||semanticDirty.current||imageDrafts.size||imageDrafts.saving||nodeResourcePendingRef.current()){if(await saveUnlocked()!==null)onWindowed();return}if(readOnly){onWindowed();return}if(await saveUnlocked()!==null)onWindowed()}) }}>{t('windowedEditing')}</button></>}
      {activeTab === 'revisions' && <span className="ribbon-note">{t('currentRevision', { revision: revision ?? '…' })}</span>}
      {activeTab === 'export' && <div className="word-export-options"><ExportControl session={session} revision={historical?.revision??revision} beforeExport={historical?undefined:beforeSemanticExport} beforeDownload={historical?undefined:beforeSemanticDownload} runExport={historical?undefined:nodeFiles.withFileLock} hint="semanticExportWarning" /></div>}
    </nav>}
    {historyReview&&historyReview.version===wordHistory.snapshot()&&<section className="history-review" role="group" aria-label={t('editHistory')}><p role="alert">{error}</p><div className="history-review-actions"><button disabled={wordHistory.busy} onClick={()=>{setHistoryReview(null);setError('')}}>{t('cancel')}</button><button disabled={readOnly||wordHistory.busy} title={t('historySkipHint')} onClick={()=>{try{wordHistory.skip(historyReview.direction,historyReview.version);setHistoryReview(null);setError('')}catch(cause){setError(cause instanceof Error&&cause.message==='historyChanged'?t('historyChanged'):String(cause))}}}>{t('historySkip')}</button></div></section>}
    <div className="layout editor-layout" style={{ gridTemplateColumns: `${layout.showOutline&&!historical ? `${outlineWidth}px 5px ` : ''}minmax(0,1fr)${rightPanel ? ` 5px ${sidebarWidth}px` : ''}` }}>
      <SemanticActivity editor={historical?null:editor} awareness={provider.awareness} localId={localUser.id} rightInset={rightPanel?sidebarWidth+5:0} members={presence} panelHost={collaborationHost} onClose={()=>commands.run('view.panel.close')}/>
      {layout.showOutline&&!historical && <SemanticOutlineNavigation entries={outline} canInsert={commands.registry.item('outline.snapshot.insert')?.enabled===true} onInsert={()=>{void commands.run('outline.snapshot.insert')}} onClose={()=>commands.run('view.navigation',{enabled:false})} onLocate={item=>{if(!editor||editor.isDestroyed)return;const pos=semanticOutlinePosition(editor.state.doc,item);if(pos===null)return;editor.commands.focus();editor.commands.setTextSelection(pos+1);editor.view.domAtPos(pos+1).node.parentElement?.scrollIntoView({block:'center',behavior:'smooth'})}}/>}
      {layout.showOutline&&!historical && <PanelResizeHandle side="left" width={outlineWidth} onResize={setOutlineWidth} label={t('resizeNavigation')} />}
      <div ref={documentScroll} className="document-scroll">{restoreLocked&&<p className="hcd-revision-note" role="status">{t(restoreUncertain?'restoreOutcomeUnknown':'restoreInProgress')}</p>}{historyLoading&&<div className="hcd-revision-loading" role="status">{t('loadingRevision')}</div>}{revisionSelection&&<RevisionReview key={historical?.revision} session={session} selection={revisionSelection} latest={revision} canRestore={restoreSupported&&!accessLocked&&!scopeReadOnly&&session.scope==='write'} unsaved={semanticDirty.current||!!imageDrafts.size} onClose={()=>commands.run('revision.current')} onRefresh={()=>commands.run('revision.open',{revision:revisionSelection.before.revision})} onRestore={()=>commands.run('revision.restore.review')} referenceNavigation={historicalReference} onReferenceLocated={(requestId,found)=>{if(historicalReferenceRef.current?.requestId===requestId)setHistoricalReferenceStatus(found?'found':'missing')}}/>}<main hidden={!!historical} aria-hidden={!!historical}  className="document" style={{ zoom: documentZoom / 100 }} onContextMenu={event => {
        if(historical)return
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
      }}><EditorContent editor={editor} />{editor&&!readOnly&&<button type="button" className="hcd-append-paragraph" onClick={()=>commands.run('block.appendParagraph')}>＋ {t('appendParagraph')}</button>}{editor && <BubbleMenu editor={editor} shouldShow={showSelectionMenu} className="selection-menu"><CommandBubble registry={commands.registry} run={commands.run}/></BubbleMenu>}</main></div>
      {rightPanel && <PanelResizeHandle side="right" width={sidebarWidth} onResize={setSidebarWidth} label={t('resizeProperties')} />}
      {rightPanel && <aside className="workspace-sidebar" aria-label={rightPanel==='deletions'?t('deletionReviewTitle'):rightPanel==='ai'?t('aiAssistant'):rightPanel === 'images' ? t('imageOptions') : rightPanel === 'properties' ? t('properties') : rightPanel === 'settings' ? t('settings') : rightPanel==='collaboration'?t('onlineCollaborators'):rightPanel==='references'?t('documentReferences'):rightPanel==='node-conflicts'?t('nodeConflicts'):t('revisionHistory')}>{rightPanel==='deletions'&&<DeletionReviewPanel groups={deletionConflicts} readOnly={readOnly} canDelete={group=>canConfirmDeletion(deletionStore,group,nodeRegistry,inlineRegistry)} onClose={()=>commands.run('view.panel.close')} onChoose={(group,choice)=>commands.registry.execute(choice==='restore'?'deletion.restore':'deletion.confirm',{key:group.key,receipt:group.receipt,snapshot:group.snapshot})}/>}{rightPanel==='node-conflicts'&&<NodeConflictPanel<ResourceNodePayload> groups={nodeProblems} onClose={()=>commands.run('view.panel.close')} onSelect={id=>{if(!editor)return;const target=(editor.state.doc===editorDoc?activeNodeIds:editorNodes(editor.state.doc)).get(id);if(target){editor.commands.setNodeSelection(target.position);setRightPanel('properties');editor.commands.focus()}}}/>}{rightPanel==='images' && <section className="word-image-properties"><div className="panel-head"><h2>{t('imageOptions')}</h2><button className="panel-close" aria-label={t('hidePanel')} onClick={()=>setRightPanel(null)}>×</button></div><SemanticImageTasksPanel tasks={imageTasks} disabled={readOnly}/><ImagePanel drafts={imageDrafts} allowReplacement={!imageTasks.busy&&!imageTasks.pending()} onReplace={(file,image,at)=>imageTasks.choose(file,image,at)} session={session} revision={revision} disabled={readOnly} saveGeometryLabel={t('saveAllText')} onSaveGeometry={async () => { if(await save()===null) throw new Error(t('newerChangesRemain')) }} onRevised={next => setRevision(previous => Math.max(previous ?? 0, next))} /></section>}{rightPanel==='properties'&&nodeFiles.client&&<WordNodeResourcePanel client={nodeFiles.client} selected={selectedNode?.value??null} disabled={readOnly||wordHistory.busy} onLocate={id=>{if(!editor)return false;const target=(editor.state.doc===editorDoc?activeNodeIds:editorNodes(editor.state.doc)).get(id);if(!target)return false;editor.commands.setNodeSelection(target.position);editor.commands.focus();return true}} onApply={attachNodeFile}/>}{rightPanel === 'properties' && selectedNode&&<section className="word-selection-properties"><div className="panel-head"><h2>{t('extensionProperties')}</h2><button className="panel-close" aria-label={t('hidePanel')} onClick={()=>setRightPanel(null)}>×</button></div>{selectedNode.value.schemaVersion==='hcd.extension/3'?<InlineContainerProperties key={selectedNode.value.instanceId} node={selectedNode.value} edits={inlineEdits.get(selectedNode.value.instanceId)} registry={inlineRegistry} resources={nodeRegistry} commands={commands.registry} readOnly={readOnly} onArchive={async(file,node)=>readInlineContainerPayload(await archiveNodeFile(file,node))}/>:<ExtensionProperties key={selectedNode.value.instanceId} node={selectedNode.value} edits={nodeEdits.get(selectedNode.value.instanceId)} registry={nodeRegistry} commands={commands.registry} readOnly={readOnly} onArchive={async(file,node)=>readExtensionNode(await archiveNodeFile(file,node))}/>}</section>}{rightPanel === 'properties'&&!selectedNode && <section className="word-selection-properties"><div className="panel-head"><h2>{t('textOptions')}</h2><button className="panel-close" aria-label={t('hidePanel')} onClick={() => commands.run('view.panel.close')}>×</button></div><section className="inspector-property-group"><h3>{t('selectedTextObject')}</h3><p className="word-selection-preview">{editor ? [...(editor.state.selection.empty ? editor.state.selection.$from.parent.textContent : editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' '))].slice(0, 180).join('') || t('emptyTextObject') : ''}</p></section><section className="inspector-property-group source-text-style"><h3>{t('textStyle')}</h3><dl><dt>{t('fontFamily')}</dt><dd title={selectedFont?.family || undefined}>{selectedFont?.mixedFamily ? t('mixedStyles') : selectedFont?.family || t('inheritedStyle')}</dd><dt>{t('fontSize')}</dt><dd><FontSizeControl editor={editor} readOnly={readOnly} commands={commands.registry}/></dd></dl></section><section className="inspector-property-group"><h3>{t('formatting')}</h3><div className="word-property-mark-buttons">{(['bold', 'italic', 'underline', 'strike'] as const).map(mark => <button key={mark} aria-label={t(mark)} title={t(mark)} aria-pressed={editor?.isActive(mark)} disabled={readOnly} onClick={() => commands.run(`text.${mark}`)}>{t(mark)}</button>)}</div><label className="inspector-option">{t('textColor')}<input type="color" aria-label={t('textColor')} defaultValue="#1f2328" disabled={readOnly} onChange={event => commands.run('text.color',{color:event.target.value})} /></label><label className="inspector-option">{t('highlight')}<input type="color" aria-label={t('highlight')} defaultValue="#fff2a8" disabled={readOnly} onChange={event => commands.run('text.highlight',{color:event.target.value})} /></label></section><section className="inspector-property-group"><h3>{t('paragraph')}</h3><div className="word-property-paragraph-buttons"><button disabled={readOnly} aria-pressed={editor?.isActive('paragraph')} onClick={() => commands.run('block.paragraph')}>{t('bodyText')}</button><button disabled={readOnly} aria-pressed={editor?.isActive('heading')} onClick={() => commands.run('block.heading')}>{t('heading')}</button><button disabled={readOnly} aria-pressed={editor?.isActive('bulletList')} onClick={() => commands.run('block.bulletList')}>{t('bullets')}</button><button disabled={readOnly} aria-pressed={editor?.isActive('orderedList')} onClick={() => commands.run('block.orderedList')}>{t('numbering')}</button></div></section></section>}
        {rightPanel==='ai'&&<AiPanel autocomplete={{available:!!autoController,enabled:autoEnabled,canToggle:!!autoController&&(!readOnly||autoEnabled),toggle:()=>commands.run('ai.autocomplete.toggle')}} state={aiState} actions={aiConfiguration.actions} available={!!aiController} canReplace={aiCan('replace')} canInsert={aiCan('insert')} onStart={(actionId,instruction)=>commands.run('ai.request',{actionId,instruction})} onAccept={()=>commands.run('ai.accept',{requestId:aiState.requestId})} onCancel={()=>commands.run('ai.cancel')} onDismiss={()=>commands.run('ai.dismiss')} onLocate={()=>commands.run('ai.locate')} onClose={()=>{aiController?.cancel();setRightPanel(null)}}/>}
        {rightPanel==='collaboration'&&<div ref={setCollaborationHost}/>}
        {rightPanel==='references'&&<ReferencePanel canEdit={reference=>canEditReference(editor,nodeRegistry,reference.mentionId,inlineRegistry)} readOnly={readOnly} conflicts={referenceConflicts} onRetarget={(expected,candidate)=>commands.registry.execute('reference.retarget',{expected,candidate})} onResolve={(group,candidateId)=>commands.registry.execute('reference.resolve',{mentionId:group.root.mentionId,ids:group.ids,candidateId})} onKeepSaved={(group,at)=>commands.registry.execute('reference.keepSaved',{mentionId:group.root.mentionId,ids:group.ids,revision:at})} session={session} revision={historical?.revision??revision} editor={editor} historical={!!historical} focus={referenceFocus} allowed={!accessLocked} navigationStatus={historicalReferenceStatus} onClose={()=>commands.run('view.panel.close')} onInspect={inspector.open} onHistoricalLocate={(entry,at)=>{if(historical?.revision!==at||entry.chunkSequence===undefined||entry.indexPage===undefined)return;setHistoricalReference({revision:at,reference:entry.reference,chunkSequence:entry.chunkSequence,indexPage:entry.indexPage,requestId:crypto.randomUUID()});setHistoricalReferenceStatus('pending')}}/>}
        {rightPanel === 'settings' && <section className="appearance-panel"><div className="panel-head"><h2>{t('appearance')}</h2><button className="panel-close" aria-label={t('hidePanel')} onClick={() => commands.run('view.panel.close')}>×</button></div><LocaleSelect /><label>{t('showHeader')}<input type="checkbox" checked={layout.showHeader} onChange={event => setLayoutOption('showHeader', event.target.checked)} /></label><label>{t('showToolbar')}<input type="checkbox" checked={layout.showToolbar} onChange={event => setLayoutOption('showToolbar', event.target.checked)} /></label><label>{t('showCollaborators')}<input type="checkbox" checked={layout.showCollaborators} onChange={event => setLayoutOption('showCollaborators', event.target.checked)} /></label><label>{t('showDocumentOutline')}<input type="checkbox" checked={layout.showOutline} onChange={event => commands.run('view.navigation',{enabled:event.target.checked})} /></label><fieldset><legend>{t('headerDensity')}</legend><label><input type="radio" name="header-density" checked={layout.compact} onChange={() => setLayoutOption('compact', true)} />{t('compact')}</label><label><input type="radio" name="header-density" checked={!layout.compact} onChange={() => setLayoutOption('compact', false)} />{t('standard')}</label></fieldset><button className="open-revisions" onClick={() => commands.run('revision.history')}>{t('viewHistory')}</button><button onClick={() => commands.run('revision.localCopies')}>{t('recoveryCopies')}</button></section>}
        {rightPanel === 'revisions' && <section className="revision-panel"><div className="panel-head"><h2>◷ {t('revisionHistory')}</h2><button className="panel-close" aria-label={t('hidePanel')} onClick={() => commands.run('view.panel.close')}>×</button></div><ReviewPanel session={session} revision={revision} readOnly={readOnly} onRevised={setRevision} /><p>{t('semanticExportWarning')}</p>
        <div className="history">{history.slice().reverse().map(item => <button key={item.revision} onClick={() => commands.run('revision.open',{revision:item.revision})} aria-pressed={historical?.revision===item.revision} aria-busy={historyLoading} title={/^hcdsave[1234]:/.test(item.patchId || '') ? t('contentUpdated') : item.patchId}><span className="revision-avatar" title={item.authorName || (item.revision === 0 ? t('imported') : t('unknownAuthor'))} style={item.authorId ? { background: presenceColor(item.authorId) } : undefined}>{item.authorName?.slice(0, 1) || (item.revision === 0 ? 'I' : '?')}</span><span className="revision-detail"><strong>r{item.revision} <small>{item.createdAtEpochMs ? new Date(item.createdAtEpochMs).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</small></strong><small>{item.authorName || (item.revision === 0 ? t('initialImport') : t('unknownAuthor'))} · {item.revision === 0 ? t('imported') : item.patchId?.startsWith('restore-') ? t('restoredRevision') : item.patchId === 'editor-projection' ? t('editorProjection') : t('contentUpdated')}</small><span>{t('viewRevision')}</span></span></button>)}
          {nextBefore !== null && nextBefore !== undefined && <button onClick={() => void loadOlderRevisions()}>{t('loadOlder')}</button>}
        </div>

        </section>}</aside>}
    </div>
    {restoreConfirmation&&revisionSelection&&<RestoreRevisionDialog selection={revisionSelection} latest={revision} uploading={(imageDrafts.uploading||nodeResourcePendingRef.current())} allowed={!accessLocked&&!scopeReadOnly&&session.scope==='write'} supported={restoreSupported} uncertain={restoreUncertain} onCancel={()=>setRestoreConfirmation(false)} onConfirm={restoreHistorical}/>}
    {nodeFiles.problem&&<div className="local-draft-warning" role="alert">{t('wordNodeResourceStorage')}<button onClick={nodeFiles.retry}>{t('wordUploadRefresh')}</button></div>}
    {accessLocked&&<div className="local-draft-warning" role="alert">{t('accessRevoked')}<button type="button" onClick={()=>setRecoveryOpen(true)}>{t('downloadDraft')}</button></div>}
    {(localUnavailable || localDraftState==='failed') && <div className="local-draft-warning" role="alert">{t('localDraftUnavailable')}<button type="button" onClick={()=>setRecoveryOpen(true)}>{t('downloadDraft')}</button></div>}
    {!localUnavailable && localDraftState!=='idle' && <div className="local-draft-status" role="status">{t(localDraftState==='writing'?'localDraftWriting':localDraftState==='stored'?'localDraftStored':'localDraftUnavailable')}</div>}
    {(saveConflict || recoveryOpen) && <SemanticRecoveryPanel session={session} localCopies={localCopies} withFileLock={nodeFiles.withFileLock} nodeResources={async()=>{if(nodeFiles.problem||!nodeFiles.client)throw Error('word-node-resource-unavailable');try{return await nodeFiles.client.options.cache.pendingNodeResources()}catch{throw Error('word-node-resource-unavailable')}}} document={ydoc} conflict={saveConflict} onUseLatest={useLatest} readOnly={scopeReadOnly||accessLocked} onClose={() => setRecoveryOpen(false)}>{(session.collaborationProtocol===structuralProtocol||session.collaborationProtocol===inlineProtocol)&&<Suspense fallback={<p>{t('recoveryArchiveWorking')}</p>}><RecoveryArchivePanel repairFiles={async(items,guard)=>{const client=nodeFiles.client;if(!client)throw Error('recoveryArchiveReadOnly');return client.repairFiles(items,guard)}} session={session} userId={session.userId||browserUserId()} document={ydoc} schema={liveSchema} registry={nodeRegistry} inlineRegistry={inlineRegistry} history={undoManager} imageStore={imageDrafts} canImport={()=>!readOnly&&!accessLockedRef.current&&!saveConflict&&!wordHistory.busy&&provider.isSynced&&!provider.hasUnsyncedChanges&&!!nodeFiles.client&&!imageTasks.pending()} canImportAfterImages={()=>!readOnly&&!accessLockedRef.current&&!saveConflict&&!wordHistory.busy&&provider.isSynced&&!provider.hasUnsyncedChanges&&!!nodeFiles.client&&!imageTasks.isBusy()} importImages={imageTasks.importChoices} pendingFiles={async()=>{if(nodeFiles.problem||!nodeFiles.client)throw Error('recoveryArchiveReadOnly');return nodeFiles.client.options.cache.pendingNodeResources()}} pendingImages={imageTasks.capture} withFileLock={nodeFiles.withFileLock} captureBusy={()=>{const client=nodeFiles.client;return !client||client.state().loading||!!client.state().problem||client.state().busy||nodeRegistryRef.current.resourceStatus().pending>0||imageTasks.isBusy()}} importFiles={async files=>{const client=nodeFiles.client;if(!client)throw Error('recoveryArchiveReadOnly');return client.importFiles(files)}}/></Suspense>}</SemanticRecoveryPanel>}
    <footer className="editor-statusbar"><div><CommandAction registry={commands.registry} run={commands.run} id="view.navigation" className="word-icon-button" iconOnly/><span>{t('continuousView')} · {session.format.toUpperCase()}</span><span>{t(nodeResourcePendingRef.current()?'editing':accessLocked?'accessRevoked':status)}</span>{imageTasks.pending()&&<button type="button" onClick={()=>commands.run('view.images')}>{t('wordUploadTasks')}</button>}{(nodeRegistryRef.current.resourceStatus().pending>0||nodeFiles.pending())&&<button type="button" onClick={()=>commands.run('view.properties',{enabled:true})}>{t('wordNodeResourceTasks')}</button>}{autoController&&<button type="button" className="hcd-ai-auto-status" aria-label={t('aiAutoToggle')} aria-pressed={autoEnabled} disabled={readOnly&&!autoEnabled} title={`${t('aiAutoHint')} ${autoEnabled?t(`aiState_${autoState.phase}`):''}`} onClick={()=>commands.run('ai.autocomplete.toggle')}>{t(autoEnabled?'aiAutoOn':'aiAutoOff')}</button>}</div><div><CommandAction registry={commands.registry} run={commands.run} id="view.properties" className="word-icon-button" iconOnly/><CommandAction registry={commands.registry} run={commands.run} id="view.actualSize" className="word-icon-button" iconOnly/><input type="range" aria-label={t('zoom')} min="70" max="150" step="5" value={documentZoom} onChange={event => commands.run('view.zoom.set',{percent:Number(event.target.value)})} /><span>{documentZoom}%</span></div></footer>
    {blocks.controls}{blocks.drop}
    {editor&&aiComposer&&<AiComposer key={aiComposer.id} editor={editor} entry={aiComposer} state={aiState} actions={aiConfiguration.actions} available={!!aiController} canReplace={aiCan('replace')} canInsert={aiCan('insert')} onStart={(actionId,instruction)=>commands.run('ai.request',{actionId,instruction})} onAccept={()=>commands.run('ai.accept',{requestId:aiState.requestId})} onCancel={()=>commands.run('ai.cancel')} onDismiss={()=>commands.run('ai.dismiss')} onClose={closeAiComposer}/>}
    {slash.menu}
    {mentions.menu}
    {inspector.menu}
    {paletteOpen&&<CommandPalette registry={commands.registry} run={commands.run} onClose={()=>setPaletteOpen(false)}/>}
    {menu && <ContextMenu x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} />}
    {linkOpen && <div className="hcd-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setLinkOpen(false) }}><div className="hcd-dialog" role="dialog" aria-modal="true" aria-label={t('setLink')}><h2>{t('setLink')}</h2><label>{t('linkAddress')}<input autoFocus type="url" value={linkHref} onChange={event => setLinkHref(event.target.value)} onKeyDown={event => { if (event.key === 'Enter'&&!event.nativeEvent.isComposing) commands.run('text.link.set',{href:linkHref.trim()}); if (event.key === 'Escape') setLinkOpen(false) }} placeholder="https://example.com" /></label><div className="hcd-dialog-actions"><button onClick={() => setLinkOpen(false)}>{t('cancel')}</button><button className="primary" onClick={()=>commands.run('text.link.set',{href:linkHref.trim()})}>{t('applyLink')}</button></div></div></div>}
    <WordSourceRecovery session={session} revision={revision} canWrite={!readOnly} sourceRequired={error==='__word_source_required__'}/>
    <div className="hcd-ai-auto-announcement" role="status" aria-live="polite">{autoEnabled&&autoState.phase==='ready'?`${t('aiAutoReady')} ${autoState.output}`:autoEnabled&&autoState.phase==='failed'&&autoState.error?t(`aiError_${autoState.error}`):''}</div>
    {error && !(historyReview&&historyReview.version===wordHistory.snapshot()) && <div className="toast error">{error === '__word_source_required__'?t('wordSourceSaveBlocked'):error === '__word_field_location_missing__'?t('wordFieldLocationMissing'):error === '__word_field_read_only__'?t('wordFieldSaveBlocked'):error === '__deletion_drafts_conflict__'?t('deletionReviewHint'):error === '__reference_drafts_conflict__'?t('referenceConflictHint'):error === '__node_resource_pending__'?t('nodeResourcePending'):error === '__node_model_upgrade__'?t('nodeModelUpgrade'):error === '__node_drafts_conflict__'?t('nodeConflictHint'):error === '__node_drafts_pending__'?t('nodeMaterializationPending'):error === '__extension_paste_rejected__' ? t('extensionPasteRejected') : error === '__save_conflict__' ? t('saveConflictHint') : error === '__coordinator_unavailable__' ? t('coordinatorUnavailable') : error === '__image_upload_pending__' ? t('imageUploadPending') : error === '__image_geometry_invalid__' ? t('imageGeometryInvalid') : error === '__image_collaboration_conflict__' ? t('imageCollaborationConflict') : error === '__image_drafts__' ? t('saveImageDraftsFirst') : error === '__autosave_retry__' ? t('autoSaveRetry') : error === '__newer_changes__' ? t('newerChangesRemain') : error === '__collab_not_ready__' ? t('collaborationSaveNotReady') : error}{error==='__word_field_read_only__'&&protectedWordBlock&&<button type="button" onClick={()=>{if(!locateWordField(editor?.view.dom??null,protectedWordBlock))setError('__word_field_location_missing__')}}>{t('wordFieldLocate')}</button>}</div>}
  </div>
}
import {DocumentErrorBoundary,DocumentLoading,DocumentProblemView} from './DocumentProblem.tsx'
import {classifyDocumentProblem,documentProblem,EditorDocumentError,type DocumentProblem} from './documentProblems.ts'
import {readDocumentSession,WordCompatibilityError} from './documentSession.ts'
import {WordCompatibilityProblem} from './WordCompatibilityProblem.tsx'
