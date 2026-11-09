import {FontSizeControl} from './FontSizeControl.tsx'
import {applyFontSizeCommand} from './fontSize.ts'
import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react'
import {flushSync} from 'react-dom'
import {EditorContent,useEditor,type Editor} from '@tiptap/react'
import {BubbleMenu} from '@tiptap/react/menus'
import {useSemanticAi} from './ai/useSemanticAi.tsx'
import {useAiAutocomplete} from './ai/useAutocomplete.tsx'
import {AiComposer} from './ai/Composer.tsx'
import {aiSpaceEntry} from './ai/entry.ts'
import type {SemanticAiStore} from './ai/semantic.ts'
import * as Y from 'yjs'
import {HocuspocusProvider} from '@hocuspocus/provider'
import {api,type Session} from './api.ts'
import {WordRecoveryGate} from './WordRecoveryGate.tsx'
import {WordDeviceDraft,wordDeviceIdentity} from './wordDeviceDraft.ts'
import {WordDeviceDownloadButton} from './WordDeviceDownloadButton.tsx'
import {WordDeviceBackupReview} from './WordDeviceBackupReview.tsx'
import {WordUploadClient} from './wordUploadClient.ts'
import {WordNodeResourceClient,type WordNodeResourceDraft} from './wordNodeResources.ts'
import {WordNodeResourcePanel} from './WordNodeResourcePanel.tsx'
import type {ExtensionNodePayload} from './extensionTypes.ts'
import {WordUploadPanel} from './WordUploadPanel.tsx'
import {WordLiveSession,type WordLiveBinding} from './wordLiveSession.ts'
import type {WordBrowserState} from './wordBrowserState.ts'
import {wordBrowserConnection} from './wordBrowserProtocol.ts'
import {wordLayoutProtocol,wordRegionalProtocol} from './collaborationProtocol.ts'
import {WordCompatibilityProblem} from './WordCompatibilityProblem.tsx'
import {documentProblem} from './documentProblems.ts'
import {WordRegionCollaboration} from './wordRegionCollaboration.ts'
import {wordOpaqueView} from './wordOpaqueView.ts'
import {schemaExtensions,clearPastedBlockIds,HcdOpaque} from './schema.ts'
import {CollaborativeImageDraftStore} from './collaborativeImages.ts'
import {SemanticHistory} from './semanticHistory.ts'
import {prepareExtensionHistoryGuard} from './extensionHistory.ts'
import {wordPaperGeometry,wordPaperFormat,wordStoryForPage,wordPresenceLocation,wordRegionIsActive,wordPreviewVariant,wordStoryIsShared} from './wordPaper.ts'
import type {WordPageFlowBinding} from './WordPageSurface.tsx'
import {WordBookSurface,type WordBookHandle} from './WordBookSurface.tsx'
import {readWordPaperLocation,readWordBookProgress} from './wordBookPresence.ts'
import {WordPageFlow,type WordFlowLayout} from './wordPageFlow.ts'
import {WordPaperOverview} from './WordPaperOverview.tsx'
import {WordPageTransactions,useWordPageTransaction} from './WordPageTransactions.tsx'
import {WordStoryTransactions,useWordStoryTransaction,WordStoryReviewDialog} from './WordStoryTransactions.tsx'
import {WordLinkTransactions,useWordLinkTransaction,WordLinkReviewDialog} from './WordLinkTransactions.tsx'
import type {WordLinkReview} from './wordLinkTransaction.ts'
import type {WordStoryReview} from './wordStoryTransaction.ts'
import {WordPageSetupError} from './wordPageTransaction.ts'
import type {WordPageSetupSubmit} from './WordPageSetup.tsx'
import {useNodeExtensions} from './NodeExtensions.tsx'
import {useExtensionEdits} from './useExtensionEdits.ts'
import {selectedExtension,canInsertExtension,prepareNodeTransaction} from './extensionCommands.ts'
import {extensionNodeLocations,extensionNodes} from './extensionNode.ts'
import {waitForWordNode} from './wordNodeLocation.ts'
import {resolveExtensionEdits} from './extensionEdits.ts'
import {ExtensionProperties} from './ExtensionProperties.tsx'
import {NodeConflictPanel} from './NodeConflictPanel.tsx'
import {useCommands,CommandRibbon,CommandPalette,CommandBubble,commandMessage} from './commands/react.tsx'
import {wordWorkspaceActions,wordWorkspaceCommand,wordWorkspaceZoom,type WordWorkspacePanel} from './wordWorkspaceCommands.ts'
import {semanticActionStates,semanticSelection} from './commands/semantic.ts'
import {blockOperations,blockTarget,blockActionStates,prepareBlockTransaction,type BlockTarget} from './commands/blocks.ts'
import {prepareSlashTransaction} from './commands/slashTransaction.ts'
import {useSlashMenu} from './commands/SlashMenu.tsx'
import {useBlockControls} from './commands/BlockControls.tsx'
import type {CommandContext} from './commands/types.ts'
import type {CommandRegistry} from './commands/registry.ts'
import {ContextMenu} from './ContextMenu.tsx'
import {ImagePanel} from './ImagePanel.tsx'
import {ExportControl} from './ExportControl.tsx'
import {useI18n,LocaleSelect,type MessageKey} from './i18n.tsx'
import {DocumentLoading,DocumentProblemView} from './DocumentProblem.tsx'
import {classifyDocumentProblem,type DocumentProblem} from './documentProblems.ts'
import {retainDocument} from './documentLifetime.ts'
import {structureCursorField,type StructureUser} from './semanticStructureCarets.ts'
import {structureViewportField,readStructureViewport,viewportFollowCycle,selectViewportConnections,ViewportFollowIntent} from './collaborationViewport.ts'
import {canMentionAt,startMentionTransaction,insertMention,type MentionMatch,type MentionCandidate} from './mentionSuggestion.ts'
import {useMentionMenu} from './MentionMenu.tsx'
import {WordOutlineNavigation} from './WordOutlineNavigation.tsx'
import {wordOutline,wordOutlinePosition,wordOutlineTransaction,wordOutlineSnapshotTransaction,type WordOutlineEntry} from './wordOutline.ts'
import {regionalFileBoundary,withRegionalFileLock} from './regionalFileBoundary.ts'
import {DeletionReviewPanel,useDeletionReviews} from './DeletionReviewPanel.tsx'
import {canConfirmDeletion} from './deletionReview.ts'
import {resolveWordDeletionReview} from './wordDeletionReview.ts'
import {regionalExportHead} from './regionalExportGuard.ts'
import {EditorIcon} from './EditorIcon.tsx'
import {RevisionReview} from './RevisionReview.tsx'
import {readWordBrowserProjection,readWordStorySessionProjection} from './wordBrowserProjection.ts'
import {semanticRevisionSelection} from './revisionDiff.ts'
import type {RevisionSelection} from './revisionSelection.ts'
import {RestoreRevisionDialog} from './RestoreRevisionDialog.tsx'
import {submitRestore,RestoreClientError,type RestoreSubmission} from './restoreClient.ts'
const noPageSubscribe=(_listener:()=>void)=>()=>{},noPageSnapshot=()=>0

type Props={session:Session;onClose:()=>void;allowClose?:boolean;embedded?:boolean;openRecovery?:()=>void;onEditorPresence?:(value:boolean)=>void;onEpochChange?:(epoch:number)=>void}
type OwnHistory={images:CollaborativeImageDraftStore;history:SemanticHistory;manager:Y.UndoManager;dispose:()=>void}
type WordViewState={section:number;variant:'first'|'default'|'even';stories:boolean;tab:string;panel:WordWorkspacePanel|null;navigation:boolean;zoom:number;scrollTop:number;paperIndex?:number}
type Connection=WordLiveBinding&{owner:WordLiveSession;own:OwnHistory;workspace:{current?:WordViewState}}
function WordLayoutRecovery({session,onClose,onRetry}:{session:Session;onClose?:()=>void;onRetry:()=>void}){const legacy=useMemo(()=>({...session,collaborationProtocol:wordRegionalProtocol}),[session]);return <WordCompatibilityProblem problem={documentProblem('HCD-DOC-1026')} session={legacy} checkpointSession={session} onClose={onClose} onRetry={onRetry}/>}
export function RegionalWordEditor(props:Props){const [retry,setRetry]=useState(0),[recovery,setRecovery]=useState(false),present=useRef(false),presence=useCallback((value:boolean)=>{present.current=value},[]);return <div className="hcd-document-boundary"><WordPageTransactions session={props.session} onRecovery={()=>setRecovery(true)} onFinished={()=>{if(!present.current){setRecovery(false);setRetry(value=>value+1)}}}><WordStoryTransactions session={props.session} onRecovery={()=>setRecovery(true)}><WordLinkTransactions session={props.session} onRecovery={()=>setRecovery(true)}>{recovery?<WordLayoutRecovery session={props.session} onClose={props.allowClose===false?undefined:props.onClose} onRetry={()=>{setRecovery(false);setRetry(value=>value+1)}}/>:<WordRecoveryGate key={retry} session={props.session} onClose={props.allowClose===false?undefined:props.onClose} fallback={props.session.collaborationProtocol===wordLayoutProtocol?<WordLayoutRecovery session={props.session} onClose={props.allowClose===false?undefined:props.onClose} onRetry={()=>setRetry(value=>value+1)}/>:undefined}><WordConnection {...props} onEditorPresence={presence}/></WordRecoveryGate>}</WordLinkTransactions></WordStoryTransactions></WordPageTransactions></div>}
function WordConnection(props:Props){
 const {session}=props,{t}=useI18n(),[connection,setConnection]=useState<Connection|null>(null),[problem,setProblem]=useState<DocumentProblem|null>(null),[retry,setRetry]=useState(0),[recoveryTools,setRecoveryTools]=useState(false)
 const registry=useNodeExtensions(),latest=useRef(registry);latest.current=registry
 const [suspended,setSuspended]=useState(false),[phase,setPhase]=useState<WordLiveSession['phase']>('opening'),[sessionProblem,setSessionProblem]=useState('')
 useEffect(()=>{props.onEditorPresence?.(true);return()=>props.onEditorPresence?.(false)},[props.onEditorPresence])
 useEffect(()=>{
  if(recoveryTools)return
  let live=true,release:(()=>void)|undefined,owner:WordLiveSession|undefined,own:OwnHistory|undefined,opened:WordDeviceDraft|undefined;const workspace:{current?:WordViewState}={};setProblem(null);setConnection(null);setSuspended(false);setPhase('opening');setSessionProblem('')
  void(async()=>{
   const userId=session.userId??[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(session.token)))].map(value=>value.toString(16).padStart(2,'0')).join(''),identity=await wordDeviceIdentity(session,userId,location.href),cache=await WordDeviceDraft.open(identity.name);opened=cache;if(!live){await cache.close();return}
   const document=new Y.Doc();release=retainDocument(document);const room=wordBrowserConnection(session)
   owner=new WordLiveSession({session,document,cache,provider:wire=>new HocuspocusProvider({url:room.url,name:room.name,token:session.token,document:wire}),beforeApply:()=>{if(live)flushSync(()=>setSuspended(true))},onEpochChange:epoch=>{if(live)props.onEpochChange?.(epoch)}})
   const update=()=>{
    if(!live||!owner)return;setPhase(owner.phase);setSessionProblem(owner.problem??'');const binding=owner.connection
    if(binding?.controller.model&&binding.controller.projection){
     if(!own){const images=new CollaborativeImageDraftStore(document),manager=binding.controller.model.structure.undoManager(true,before=>prepareExtensionHistoryGuard(before,latest.current)),blocked=()=>owner?.phase!=='ready'||!owner.connection||owner.connection.controller.state().readOnly,history=new SemanticHistory(images,manager,()=>blocked()||images.uploading,async(id,signal)=>(await api(session,`/images/${id}`,{signal})).json(),Date.now,()=>!blocked()),detachImages=images.connect(),detachHistory=history.connect();own={images,manager,history,dispose:()=>{detachHistory();detachImages();manager.destroy()}}}
     setConnection({...binding,owner,own,workspace})
    }
    if(owner.phase==='ready')setSuspended(false)
   }
   owner.subscribe(update);await owner.start();update()
  })().catch(cause=>{if(!own){void(owner?.dispose()??opened?.close())?.catch(()=>{}).finally(()=>release?.());if(live)setProblem(classifyDocumentProblem(cause,'recovery'))}})
  return()=>{live=false;own?.dispose();if(owner)void owner.dispose().catch(()=>{}).finally(()=>release?.());else if(opened)void opened.close().catch(()=>{}).finally(()=>release?.());else release?.()}

 },[session,retry,recoveryTools])
 if(recoveryTools)return <WordLayoutRecovery session={session} onClose={props.allowClose===false?undefined:props.onClose} onRetry={()=>{setRecoveryTools(false);setRetry(value=>value+1)}}/>
 if(problem)return <DocumentProblemView problem={problem} documentId={session.documentId} onRetry={()=>setRetry(value=>value+1)} onClose={props.allowClose===false?undefined:props.onClose} secondary={session.collaborationProtocol===wordLayoutProtocol?{label:t('wordCheckpointTitle'),run:()=>setRecoveryTools(true)}:undefined}/>
 const retryConnection=()=>{if(connection?.owner.canRetry)void connection.owner.retry().catch(()=>{});else setRetry(value=>value+1)}
 if((suspended||phase==='recovery-required')&&connection)return <section className="local-draft-start"><h2>{t('wordSessionRebinding')}</h2><p role={sessionProblem?'alert':'status'}>{t(sessionProblem?'wordSessionRecoveryRequired':'wordSessionRebindingHint')}</p>{sessionProblem&&<code>{sessionProblem}</code>}{phase!=='reconnecting'&&<><button onClick={retryConnection}>{t('retry')}</button><WordDeviceDownloadButton cache={connection.cache} session={session}/><button onClick={()=>setRecoveryTools(true)}>{t('wordCheckpointTitle')}</button></>}</section>
 return connection?<>{phase==='reconnecting'&&<div className="word-region-error" role="status">{t('wordSessionRebinding')}</div>}<WordDocument {...props} openRecovery={session.collaborationProtocol===wordLayoutProtocol?()=>setRecoveryTools(true):undefined} connection={connection} retryConnection={retryConnection}/></>:<DocumentLoading documentId={session.documentId} onClose={props.allowClose===false?undefined:props.onClose}/>
}
function WordDocument(props:Props&{connection:Connection;retryConnection:()=>void}){
 const {connection,session}=props,{controller,cache,document}=connection,{t}=useI18n();useSyncExternalStore(controller.subscribe,controller.snapshot);useSyncExternalStore(cache.subscribe,cache.snapshot)
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 if(controller.recovery){const review=controller.recovery,largeReconnect=error.includes('word-device-large-reconnect')||controller.state().problem==='word-device-large-reconnect',largeUncertain=error.includes('word-device-large-uncertain')||controller.state().problem==='word-device-large-uncertain',reviewChanged=largeReconnect||largeUncertain||error.includes('word-device-review-changed')||controller.state().problem==='word-device-review-changed';return <section className="local-draft-start"><h2>{t('localDraftRecovery')}</h2><p>{t('wordDeviceRecoveryHint')}</p><div className="local-draft-compare"><section><h3>{t('localDraftServer')}</h3><p>{review.server}</p></section><section><h3>{t('localDraftDevice')}</h3><p>{review.local}</p></section><section><h3>{t('wordDeviceOwnPreview')}</h3><p>{review.own||t(review.problem==='word-device-recovery-too-large'?'wordDeviceRecoveryTooLarge':'wordDeviceOwnUnavailable')}</p></section></div><button disabled={busy||!review.canRestore} onClick={()=>{setBusy(true);void controller.chooseDevice('restore').catch(cause=>setError(String(cause))).finally(()=>setBusy(false))}}>{t('localDraftRestore')}</button><button disabled={busy} onClick={()=>{setBusy(true);void controller.chooseDevice('keep').catch(cause=>setError(String(cause))).finally(()=>setBusy(false))}}>{t('localDraftKeepAndOpen')}</button><WordDeviceDownloadButton cache={cache} session={session}/>{error&&<p role="alert">{largeReconnect?t('wordDeviceLargeReconnect'):largeUncertain?t('wordDeviceLargeUncertain'):reviewChanged?t('wordDeviceReviewChanged'):error}</p>}{reviewChanged&&<button disabled={busy} onClick={props.retryConnection}>{t('wordDeviceReviewRetry')}</button>}</section>}
 if(!controller.model||!controller.projection){
  if(!controller.problem)return <DocumentLoading documentId={session.documentId} onClose={props.allowClose===false?undefined:props.onClose}/>
  return <DocumentProblemView problem={classifyDocumentProblem(new Error(controller.problem),'collaboration')} documentId={session.documentId} onRetry={props.retryConnection} onClose={props.allowClose===false?undefined:props.onClose}><WordDeviceDownloadButton cache={cache} session={session}/>{props.openRecovery&&<button type="button" onClick={props.openRecovery}>{t('wordCheckpointTitle')}</button>}</DocumentProblemView>
 }
 return <WordHistoryHost {...props}/>
}
type HistoryRuntime={nodeResources:WordNodeResourceClient;uploads:WordUploadClient;images:CollaborativeImageDraftStore;history:SemanticHistory;manager:Y.UndoManager}
function WordHistoryHost(props:Props&{connection:Connection;retryConnection:()=>void}){
 const registry=useNodeExtensions(),latest=useRef(registry);latest.current=registry
 const [runtime,setRuntime]=useState<HistoryRuntime|null>(null),{controller,document,provider,cache,own}=props.connection,session=props.session
 useEffect(()=>{
  const {images,manager,history}=own
  const uploads=new WordUploadClient({session,document,cache,controller,images,ready:()=>!controller.state().readOnly&&provider.isSynced&&!provider.hasUnsyncedChanges});const channel=typeof BroadcastChannel==='undefined'?undefined:new BroadcastChannel(cache.name+'-node-resources')
  const nodeResources=new WordNodeResourceClient({cache,registry:{archiveResource:input=>latest.current.archiveResource(input)},ready:()=>!controller.state().readOnly&&provider.isSynced&&!provider.hasUnsyncedChanges,notify:()=>channel?.postMessage('changed')})
  const refreshResources=()=>{void nodeResources.refresh()};if(channel)channel.onmessage=refreshResources;window.addEventListener('focus',refreshResources)
  void nodeResources.initialize();void uploads.initialize();setRuntime({images,manager,history,uploads,nodeResources});return()=>{window.removeEventListener('focus',refreshResources);channel?.close();nodeResources.dispose();uploads.dispose()}
 },[controller,document,provider,cache,own,session])
 return runtime?<ConnectedWord {...props} runtime={runtime}/>:<DocumentLoading documentId={session.documentId}/>
}
function ConnectedWord({session,onClose,allowClose=true,connection,runtime,retryConnection}:Props&{connection:Connection;runtime:HistoryRuntime;retryConnection:()=>void}){
 const {t,locale}=useI18n(),{controller,provider,document,cache}=connection,model=controller.model!,projection=controller.projection!,state=controller.state(),registry=useNodeExtensions(),{images,history,uploads,nodeResources}=runtime
 useSyncExternalStore(controller.subscribe,controller.snapshot);useSyncExternalStore(cache.subscribe,cache.snapshot);useSyncExternalStore(images.subscribe,images.snapshot);useSyncExternalStore(history.subscribe,history.snapshot);useSyncExternalStore(uploads.subscribe,uploads.snapshot);useSyncExternalStore(nodeResources.subscribe,nodeResources.snapshot)
 const [section,setSection]=useState(()=>connection.workspace.current?.section??0),[variant,setVariant]=useState<'first'|'default'|'even'>(()=>connection.workspace.current?.variant??'first'),[stories,setStories]=useState(()=>connection.workspace.current?.stories??false),[active,setActive]=useState<Editor|null>(null),[tab,setTab]=useState(()=>connection.workspace.current?.tab??'home'),[panel,setPanel]=useState<WordWorkspacePanel|null>(()=>connection.workspace.current?.panel??null),[navigation,setNavigation]=useState(()=>connection.workspace.current?.navigation??false),[palette,setPalette]=useState(false),[deviceFileReview,setDeviceFileReview]=useState(false),[zoom,setZoom]=useState(()=>connection.workspace.current?.zoom??100),[error,setError]=useState(''),[image,setImage]=useState(''),[menu,setMenu]=useState<{x:number;y:number}|null>(null),[following,updateFollowing]=useState<number|null>(null),[peers,setPeers]=useState<Array<{client:number;id:string;name:string;color:string}>>([]),[,render]=useState(0)
 const [followIntent]=useState(()=>new ViewportFollowIntent()),setFollowing=useCallback((client:number|null)=>{followIntent.set(client);updateFollowing(client)},[followIntent])
 const [historyReview,setHistoryReview]=useState<{direction:'undo'|'redo';version:number}|null>(null)
 // Reviewing an immutable revision produces rows straight from the region
 // diff: the reviewed side reads immutable native history, the live side
 // re-projects through the active room owner, and both fold with the same
 // neutral engine as the semantic entry — no fixed-format descriptor detour.
 // Restore goes through the sidecar's coordinated
 // transaction (hcd-word-regions/2 only): every layout writer drains through
 // the hcd-restore handshake, and each client follows the rotated epoch from
 // its own receipt or the committed broadcast
 // (docs/design/hcd-revision-review-alignment.zh.md §4, phase 3b).
 const [historyOpen,setHistoryOpen]=useState(false),[revisionList,setRevisionList]=useState<Array<{revision:number;patchId?:string;authorName?:string;createdAtEpochMs?:number}>>([]),[revisionNextBefore,setRevisionNextBefore]=useState<number|null|undefined>(undefined),[revisionsLoading,setRevisionsLoading]=useState(false),[revisionSelection,setRevisionSelection]=useState<RevisionSelection|null>(null),[selectionLoading,setSelectionLoading]=useState(false),[historyProblem,setHistoryProblem]=useState('')
 const [restoreAsk,setRestoreAsk]=useState(false),[restoreUncertain,setRestoreUncertain]=useState(false)
 const historyDialog=useRef<HTMLDialogElement|null>(null),selectionRequest=useRef<AbortController|null>(null),pendingRestore=useRef<RestoreSubmission|null>(null),restoreRequest=useRef<AbortController|null>(null)
 useEffect(()=>()=>{selectionRequest.current?.abort();restoreRequest.current?.abort()},[])
 useEffect(()=>{const element=historyDialog.current;if(!element)return;if(historyOpen){if(!element.open)element.showModal()}else element.close()},[historyOpen])
 const clearRevisionSelection=()=>{selectionRequest.current?.abort();selectionRequest.current=null;setRevisionSelection(null);setSelectionLoading(false);setHistoryProblem('');setRestoreAsk(false)}
 const closeRevisionHistory=()=>{clearRevisionSelection();setHistoryOpen(false)}
 const loadRevisionPage=async(before:number|null)=>{
  setRevisionsLoading(true)
  try{
   const result=await (await api(session,before===null?'/revisions':`/revisions?before=${before}`)).json() as {revisions:Array<{revision:number;patchId?:string;authorName?:string;createdAtEpochMs?:number}>;nextBefore:number|null}
   setRevisionList(previous=>Array.from(new Map([...previous,...result.revisions].map(item=>[item.revision,item])).values()).sort((a,b)=>a.revision-b.revision))
   setRevisionNextBefore(previous=>before===null?(previous===undefined?result.nextBefore:previous):result.nextBefore)
  }catch(cause){setHistoryProblem(String(cause))}
  finally{setRevisionsLoading(false)}
 }
 const openRevisionHistory=()=>{setHistoryOpen(true);setHistoryProblem('');if(revisionNextBefore===undefined)void loadRevisionPage(null)}
 const showRevision=async(number:number)=>{
  const latest=state.revision
  if(latest===null)return
  selectionRequest.current?.abort();const controller=new AbortController();selectionRequest.current=controller
  setSelectionLoading(true);setRevisionSelection(null);setHistoryProblem('')
  try{
   const item=revisionList.find(entry=>entry.revision===number)
   // The reviewed side is immutable native history (older than the room's
   // pinned baseline, so the owner route would 409 it); the live side stays
   // pinned through the active room owner.
   const [before,after]=await Promise.all([readWordStorySessionProjection(session,number,controller.signal),readWordBrowserProjection(session,latest,controller.signal)])
   const selection=semanticRevisionSelection(before,after,{author:item?.authorName||(number===0?t('initialImport'):undefined),createdAt:item?.createdAtEpochMs})
   if(controller.signal.aborted||selectionRequest.current!==controller)return
   setRevisionSelection(selection)
  }catch(cause){if(!controller.signal.aborted&&selectionRequest.current===controller)setHistoryProblem(String(cause))}
  finally{if(!controller.signal.aborted&&selectionRequest.current===controller)setSelectionLoading(false)}
 }
 // The submitting client saves first so the CAS head matches the reviewed
 // comparison; an uncertain outcome keeps the exact intent for an idempotent
 // replay, mirroring the semantic entry (App.tsx restoreHistorical).
 const confirmRestore=async()=>{
  if(session.scope!=='write')throw new Error(t('readOnlyMode'))
  const selection=revisionSelection
  if(!selection)throw new Error(t('restoreCouldNotConfirm'))
  if(!pendingRestore.current){
   const head=await controller.save()
   if(head!==selection.comparedWith)throw new Error(t('restoreComparisonChanged'))
   pendingRestore.current={requestId:crypto.randomUUID().replaceAll('-',''),target:selection.target,expectedRevision:head,fromEpoch:session.collaborationEpoch??0}
  }
  restoreRequest.current?.abort();const abort=new AbortController();restoreRequest.current=abort
  try{
   const receipt=await submitRestore({...session,collabUrl:session.collabUrl||import.meta.env.VITE_HCD_COLLAB_URL},pendingRestore.current,abort.signal)
   pendingRestore.current=null;setRestoreAsk(false);setRestoreUncertain(false)
   controller.notifyRestoreCommitted(receipt.collaborationEpoch)
  }catch(cause){
   if(cause instanceof RestoreClientError&&!cause.uncertain)pendingRestore.current=null
   setRestoreUncertain(cause instanceof RestoreClientError&&cause.uncertain)
   throw new Error(t(cause instanceof RestoreClientError&&cause.uncertain?'restoreOutcomeUnknown':cause instanceof RestoreClientError&&['restore-client-busy','restore-online-clients'].includes(cause.code)?'restoreOtherClientBusy':'restoreComparisonChanged'))
  }
 }
 const [paperOverview,setPaperOverview]=useState(false),[paperSetup,setPaperSetup]=useState(false),paperButton=useRef<HTMLButtonElement|null>(null)
 const pageTransaction=useWordPageTransaction(),storyTransaction=useWordStoryTransaction(),linkTransaction=useWordLinkTransaction()
 useEffect(()=>{if(state.ready&&linkTransaction?.phase==='pending'&&!linkTransaction.busy)void linkTransaction.check().catch(()=>{})},[linkTransaction,state.ready])
 const pageRequestId=pageTransaction?.resumeId
 useEffect(()=>{if(state.ready&&pageRequestId&&pageTransaction?.phase==='pending'&&!pageTransaction.busy)void pageTransaction.check().catch(()=>{})},[pageTransaction,state.ready,pageRequestId])
 const [storyReview,setStoryReview]=useState<WordStoryReview|null>(null),[storyBusy,setStoryBusy]=useState(false),[storyError,setStoryError]=useState(''),storyCancellation=useRef<AbortController|null>(null)
 useSyncExternalStore(pageTransaction?.subscribe??noPageSubscribe,pageTransaction?.snapshot??noPageSnapshot)
 const closePaperOverview=()=>{setPaperOverview(false);setPaperSetup(false);requestAnimationFrame(()=>paperButton.current?.focus())}
 const [pageFlow,setPageFlow]=useState<WordFlowLayout>({phase:'measuring',pages:null})
 const [missingStory,setMissingStory]=useState<{kind:'header'|'footer';section:number;variant:string}|null>(null)
 useEffect(()=>setMissingStory(null),[section,variant])
 const book=useRef<WordBookHandle|null>(null),editors=useRef(new Map<string,Editor>()),selected=useRef<BlockTarget|null>(null),openBlocks=useRef<(()=>void)|null>(null),scroll=useRef<HTMLDivElement|null>(null),canvas=useRef<HTMLDivElement|null>(null),[availableWidth,setAvailableWidth]=useState(900),layout=projection.flowLayout
 const preserveView=useRef<()=>void|(()=>void)>(()=>{});preserveView.current=()=>{if(history.busy)throw Error('historyBusy');connection.workspace.current={section,variant,stories,tab,panel,navigation,zoom,scrollTop:scroll.current?.scrollTop??0,paperIndex:book.current?.viewport()?.paperIndex};const current=[...editors.current.values()];return()=>{for(const editor of current)if(!editor.isDestroyed)editor.destroy();editors.current.clear()}}
 useEffect(()=>connection.owner.setBeforeRebind(()=>preserveView.current()),[connection.owner])
 useEffect(()=>{const top=connection.workspace.current?.scrollTop;if(top===undefined)return;const frame=requestAnimationFrame(()=>{if(scroll.current)scroll.current.scrollTop=top});return()=>cancelAnimationFrame(frame)},[connection.workspace])
 useEffect(()=>controller.setTopologyInputPause(()=>{
  const current=[...editors.current.values()].filter(editor=>!editor.isDestroyed)
  if(history.busy||current.some(editor=>editor.view.composing))throw new Error('word-topology-input-busy')
  for(const editor of current)editor.setEditable(false)
  return()=>{} // The readOnly prop restores each region according to its active mode.
 }),[controller,history])
 const local=useMemo<StructureUser>(()=>({id:session.userId??`member:${document.clientID}`,name:session.displayName??session.userId??'Member',color:['#3478c0','#c64d6b','#43876c'][document.clientID%3]}),[session,document])
 useEffect(()=>{if(state.saved)setError(previous=>previous.includes('word-browser-newer-changes')?'':previous)},[state.saved])
 const nodeEdits=useExtensionEdits(document,registry,!state.readOnly)
 const existingNodes=extensionNodes(model.structure.project()),nodeProblems=[...nodeEdits.values()].filter(group=>existingNodes.has(group.root.instanceId)&&(!group.ready||Object.keys(group.conflicts).length))
 const deletionConflicts=useDeletionReviews(model.structure)
 const [nodeLocation,setNodeLocation]=useState<{regionId:string;instanceId:string}|null>(null)
 const [outlineLocation,setOutlineLocation]=useState<WordOutlineEntry|null>(null),[outlineCurrent,setOutlineCurrent]=useState<string|null>(null),[outlineNotice,setOutlineNotice]=useState(false),[editorGeneration,setEditorGeneration]=useState(0)
 const registryVersion=registry.snapshot()
 useEffect(()=>{const changed=()=>controller.setResourcePending(registry.resourceStatus().pending>0||nodeResources.state().pending);changed();const detach=registry.subscribe(changed),detachJobs=nodeResources.subscribe(changed);return()=>{detach();detachJobs();controller.setResourcePending(false)}},[controller,registry,nodeResources])
 useEffect(()=>{for(const editor of editors.current.values())if(!editor.isDestroyed)editor.view.dispatch(editor.state.tr.setMeta('hcd-node-registry',registryVersion))},[registryVersion,registry])
 const [link,setLink]=useState<string|null>(null)
 const [menuBlocks,setMenuBlocks]=useState<ReadonlySet<Editor>>(()=>new Set())
 const activeRegion=[...editors.current].find(([,editor])=>editor===active)?.[0],activeSection=layout.sections[section]
 const activeHeader=wordStoryForPage(layout,section,'header',variant==='first',variant==='even'?2:1),activeFooter=wordStoryForPage(layout,section,'footer',variant==='first',variant==='even'?2:1)
 const targetVisible=wordRegionIsActive(activeRegion,activeSection.id,activeHeader?.id,activeFooter?.id,stories)
 const activeTarget=targetVisible&&active&&!active.isDestroyed?active:null
 const activeStoryKind=stories&&activeTarget?(activeRegion===activeHeader?.id?'header':activeRegion===activeFooter?.id?'footer':undefined):undefined
 const storyVariant=wordPreviewVariant(layout,section,variant)
 const storyLinked=!!activeStoryKind&&section>0&&(activeStoryKind==='header'?activeSection.headers:activeSection.footers)[storyVariant]===undefined
 const sharedStory=activeStoryKind?wordStoryIsShared(layout,activeStoryKind==='header'?activeHeader:activeFooter):false
 const selectedNode=activeTarget?selectedExtension(activeTarget.state):null,selectedNodeEdits=selectedNode?nodeEdits.get(selectedNode.value.instanceId):undefined
 useEffect(()=>{storyCancellation.current?.abort();setStoryReview(null);setStoryError('')},[section,variant])
 useEffect(()=>()=>storyCancellation.current?.abort(),[])
 const aiWritable=state.ready&&!state.readOnly&&!history.busy&&state.connected&&provider.isSynced&&targetVisible
 const ai=useSemanticAi({editor:active,scope:`${section}:${variant}:${stories}`,session,store:editor=>(editor.storage as unknown as {hcdWordRegionCollaboration?:{store:SemanticAiStore|null}}).hcdWordRegionCollaboration?.store??undefined,canWrite:aiWritable,revision:state.revision,locale,history})
 useEffect(()=>{setLink(null)},[active,section,variant])
 const fileBoundary=()=>regionalFileBoundary({nodeFiles:()=>nodeResources.checkPending(),uploads:()=>uploads.checkPending(),resourcesBusy:()=>registry.resourceStatus().pending>0||nodeResources.state().pending,uploadsBusy:()=>uploads.state().pending,imagesBusy:()=>images.uploading||history.busy})
 const fileProblem=(cause:unknown)=>cause instanceof Error&&cause.message==='node-resource-pending'?t('nodeResourcePending'):cause instanceof Error&&cause.message==='word-upload-pending'?t('wordUploadPending'):String(cause)
 const saveLocked=async()=>{try{await fileBoundary();const revision=await controller.save();await fileBoundary();setError('');return revision}catch(cause){setError(fileProblem(cause));throw cause}}
 const exportHead=useRef<{revision:number;sourceSha256:string}|null>(null)
 const beforeRegionalExport=async()=>{exportHead.current=null;try{const revision=await saveLocked();exportHead.current=await regionalExportHead(session,revision,()=>controller.state(),fileBoundary,AbortSignal.timeout(30000));return revision}catch{return null}}
 const beforeRegionalDownload=async(revision:number,signal:AbortSignal)=>{try{const expected=exportHead.current;if(!expected||expected.revision!==revision)throw new Error('regional-export-changed');await regionalExportHead(session,revision,()=>controller.state(),fileBoundary,signal,expected)}catch{throw new Error(t('fixedExportChanged'))}}
 const save=()=>withRegionalFileLock(cache.name,saveLocked)
 const [linkReview,setLinkReview]=useState<WordLinkReview|null>(null),[linkBusy,setLinkBusy]=useState(false),[linkError,setLinkError]=useState(''),linkCancellation=useRef<AbortController|null>(null)
 useEffect(()=>{linkCancellation.current?.abort();setLinkReview(null);setLinkError('')},[section,variant])
 useEffect(()=>()=>linkCancellation.current?.abort(),[])
 const pageSetupAvailable=session.collaborationProtocol===wordLayoutProtocol&&!!pageTransaction&&pageTransaction.phase==='idle'&&storyTransaction?.phase==='idle'&&linkTransaction?.phase==='idle'&&!linkBusy&&!linkReview&&!storyBusy&&!state.readOnly&&!history.busy&&!state.uploadPending&&!state.resourcePending
 const submitPage:WordPageSetupSubmit=async input=>{
  if(!pageTransaction)throw new WordPageSetupError('word-page-unavailable')
  let staged=false
  try{return await withRegionalFileLock(cache.name,async()=>{
   await fileBoundary();if(connection.owner.phase!=='ready'||controller.state().readOnly||controller.state().revision!==input.revision||controller.model?.layoutState().layoutHash!==input.intent.baseLayoutHash)throw new WordPageSetupError('word-page-stale')
   const saved=await saveLocked(),current=controller.state();if(saved!==input.revision||!current.saved||current.readOnly||controller.model!.layoutState().layoutHash!==input.intent.baseLayoutHash)throw new WordPageSetupError('word-page-stale')
   await pageTransaction.prepare(input.revision,input.intent,controller.projection!.flowLayout);staged=true;setPaperOverview(false);await pageTransaction.retry();if(pageTransaction.phase!=='installed'||pageTransaction.revision===undefined)throw Error('word-page-outcome-unknown');return{revision:pageTransaction.revision}
  })}catch(error){if(!staged&&!(error instanceof WordPageSetupError))throw new WordPageSetupError('word-page-stale');throw error}
 }
 const storyAvailable=session.collaborationProtocol===wordLayoutProtocol&&storyTransaction?.phase==='idle'&&pageTransaction?.phase==='idle'&&linkTransaction?.phase==='idle'&&!linkBusy&&!linkReview&&!storyBusy&&state.ready&&!state.readOnly&&!history.busy&&!state.uploadPending&&!state.resourcePending
 async function beginStory(kind:'header'|'footer'){
  if(!storyAvailable||!storyTransaction)throw Error('word-story-unavailable')
  const abort=new AbortController();storyCancellation.current?.abort();storyCancellation.current=abort;setStoryBusy(true);setStoryError('')
  try{const review=await withRegionalFileLock(cache.name,async()=>{await saveLocked();abort.signal.throwIfAborted();return storyTransaction.preview(activeSection.id,kind,storyVariant,abort.signal)});abort.signal.throwIfAborted();setStoryReview(review)}catch(cause){if(!abort.signal.aborted)report(cause)}finally{if(storyCancellation.current===abort)setStoryBusy(false)}
 }
 async function confirmStory(){
  if(!storyReview||!storyTransaction||storyBusy)return
  const review=storyReview;setStoryBusy(true);setStoryError('')
  try{await withRegionalFileLock(cache.name,async()=>{
   await fileBoundary();const current=controller.state();if(connection.owner.phase!=='ready'||current.readOnly||current.revision!==review.revision||controller.model?.layoutState().layoutHash!==review.pending.request.baseLayoutHash)throw Error('word-story-review-changed')
   await storyTransaction.prepare(review);setStoryReview(null);await storyTransaction.retry()
  })}catch(cause){if(storyTransaction.record)setStoryReview(null);else setStoryError(cause instanceof Error?cause.message:'word-story-unavailable')}finally{setStoryBusy(false)}
 }
 const linkAvailable=storyAvailable&&!!linkTransaction&&!storyReview
 async function beginLink(kind:'header'|'footer'){
  if(!linkAvailable||!linkTransaction||section===0||activeSection[kind==='header'?'headers':'footers'][storyVariant]===undefined)throw Error(t('wordLinkUnavailable'))
  const abort=new AbortController();linkCancellation.current?.abort();linkCancellation.current=abort;setLinkBusy(true);setLinkError('')
  try{const review=await withRegionalFileLock(cache.name,async()=>{
   await saveLocked();abort.signal.throwIfAborted();const current=controller.state(),base=controller.model!.layoutState()
   if(current.readOnly||!current.saved||current.revision===null)throw Error('word-link-review-changed')
   return linkTransaction.preview({layout:base.layout,layoutHash:base.layoutHash,revision:current.revision},activeSection.id,kind,storyVariant,abort.signal)
  });abort.signal.throwIfAborted();setLinkReview(review)}catch(cause){if(!abort.signal.aborted)report(cause)}finally{if(linkCancellation.current===abort)setLinkBusy(false)}
 }
 async function confirmLink(){
  if(!linkReview||!linkTransaction||linkBusy)return
  const review=linkReview;setLinkBusy(true);setLinkError('')
  try{await withRegionalFileLock(cache.name,async()=>{
   await fileBoundary();const current=controller.state();if(connection.owner.phase!=='ready'||current.readOnly||current.revision!==review.revision||controller.model?.layoutState().layoutHash!==review.pending.request.link.baseLayoutHash)throw Error('word-link-review-changed')
   await linkTransaction.prepare(review);setLinkReview(null);await linkTransaction.retry()
  })}catch(cause){if(linkTransaction.record)setLinkReview(null);else setLinkError(cause instanceof Error?cause.message:'word-link-unavailable')}finally{setLinkBusy(false)}
 }
 const close=async()=>{try{await withRegionalFileLock(cache.name,async()=>{await fileBoundary();if(session.scope!=='read'&&!controller.state().saved)await saveLocked();await fileBoundary();if(session.scope!=='read'&&!controller.state().saved)throw new Error('word-browser-newer-changes');onClose()})}catch(cause){setError(fileProblem(cause))}}
 const report=(cause:unknown)=>setError(cause instanceof Error&&cause.message==='word-story-source-unsupported'?t('wordStoppedStorySourceUnsupported'):cause instanceof Error&&cause.message==='word-story-source-draft-pending'?t('wordStoppedStorySourceDraft'):commandMessage(cause)?t(commandMessage(cause)!):fileProblem(cause))
 const commands=useCommands(instance=>({instanceId:instance,documentId:session.documentId,format:'docx',profile:'flow',locale,platform:/Mac|iPhone|iPad/.test(navigator.platform)?'mac':'other',ready:state.ready,readOnly:state.readOnly,revision:state.revision,historical:false,selection:{...semanticSelection(activeTarget,controller.snapshot()),...(selectedNodeEdits?{nodeEdits:{ids:selectedNodeEdits.ids,conflicts:selectedNodeEdits.conflicts,ready:selectedNodeEdits.ready}}:{})},capabilities:{pageSetup:pageSetupAvailable,wordStories:!!storyTransaction,wordLinks:!!linkTransaction,mentions:true,customNodes:registry.list().length>0,customMarks:false,ai:!!ai.controller,aiAutocomplete:!!ai.automatic},actions:{'word.link.header':{enabled:linkAvailable&&section>0&&activeSection.headers[storyVariant]!==undefined},'word.link.footer':{enabled:linkAvailable&&section>0&&activeSection.footers[storyVariant]!==undefined},'word.story.header':{enabled:storyAvailable&&activeSection.headers[storyVariant]===undefined},'word.story.footer':{enabled:storyAvailable&&activeSection.footers[storyVariant]===undefined},'word.page.setup':{enabled:pageSetupAvailable},'node.insert':{enabled:!!activeTarget&&(canInsertExtension(activeTarget.state)||!!selected.current&&selected.current.intent!=='operate'&&blockActionStates(activeTarget.state,selected.current)['text.insert']?.enabled===true)},'node.update':{enabled:!!selectedNode&&!!registry.resolve(selectedNode.value)&&!Object.keys(selectedNodeEdits?.conflicts??{}).length},'node.resources':{enabled:!!selectedNode&&!!registry.resolve(selectedNode.value)&&!Object.keys(selectedNodeEdits?.conflicts??{}).length},'node.delete':{enabled:!!selectedNode&&!!registry.resolve(selectedNode.value)},'node.migrate':{enabled:!!selectedNode&&registry.migrationAvailable(selectedNode.value)&&(!selectedNodeEdits||selectedNodeEdits.ready&&!Object.keys(selectedNodeEdits.conflicts).length)},'node.properties':{enabled:!!selectedNode},'node.conflicts':{enabled:nodeProblems.length>0},'node.resolve':{enabled:!!selectedNodeEdits&&(!selectedNodeEdits.ready||Object.keys(selectedNodeEdits.conflicts).length>0)},'ai.open':{enabled:!!activeTarget&&!state.readOnly,active:!!ai.composer},'ai.compose':{enabled:ai.can('insert')},'ai.replace':{enabled:ai.can('replace')},'ai.insert':{enabled:ai.can('insert')},'ai.request':{enabled:ai.can('replace')||ai.can('insert')},'ai.accept':{enabled:ai.state.phase==='ready'},'ai.cancel':{enabled:['requesting','streaming','applying'].includes(ai.state.phase)},'ai.dismiss':{enabled:!!ai.state.requestId},'ai.locate':{enabled:!!ai.state.requestId},'ai.autocomplete.toggle':{enabled:!!ai.automatic&&(!state.readOnly||ai.enabled),active:ai.enabled},'ai.autocomplete.accept':{enabled:ai.autoState.phase==='ready'&&ai.autocomplete.current?.ready()===true},'ai.autocomplete.dismiss':{enabled:!!ai.autoState.requestId},...semanticActionStates(activeTarget),...(activeTarget&&selected.current?blockActionStates(activeTarget.state,selected.current):{}),'file.save':{enabled:state.ready&&!state.saving&&!images.uploading&&!state.uploadPending&&!state.resourcePending&&!nodeProblems.length&&provider.isSynced&&!provider.hasUnsyncedChanges},'file.export':{enabled:state.ready},'edit.undo':{enabled:!state.readOnly&&history.canUndo},'edit.redo':{enabled:!state.readOnly&&history.canRedo},'editor.palette':{enabled:true},...wordWorkspaceActions({navigation,panel,zoom}),'reference.person':{enabled:!!activeTarget&&canMentionAt(activeTarget.state)},'reference.person.insert':{enabled:!!activeTarget&&canMentionAt(activeTarget.state)},'block.menu':{enabled:!!activeTarget&&!state.readOnly}}} as CommandContext),async(id,input,signal,insertion)=>{
  if(signal.aborted)return false
  if(id==='word.link.header'||id==='word.link.footer')return beginLink(id==='word.link.header'?'header':'footer')
  if(id==='word.story.header'||id==='word.story.footer')return beginStory(id==='word.story.header'?'header':'footer')
  if(id==='word.page.setup'){if(!pageSetupAvailable)throw new WordPageSetupError('word-page-unavailable');await save();if(!controller.state().saved||controller.state().readOnly)throw new WordPageSetupError('word-page-stale');setPaperSetup(true);setPaperOverview(true);return true}if(id==='file.save')return save();if(id==='file.export'){setTab('export');return true}if(id==='editor.palette'){setPalette(value=>!value);return true}if(wordWorkspaceCommand(id,input,{navigation:setNavigation,panel:setPanel,zoom:setZoom},!!selectedNode))return true;if(id==='node.properties'){setPanel('properties');return true}if(id==='node.conflicts'){setPanel('nodes');return true}
  if(id==='ai.open'){ai.controller?.dismiss();ai.open();return true}
  if(id==='ai.request'){const value=input as {actionId?:string;instruction?:string};return ai.start(value?.actionId??'',value?.instruction??'')}
  if(id==='ai.accept')return ai.accept((input as {requestId?:string})?.requestId??'')
  if(id==='ai.cancel'){ai.controller?.cancel();return true}if(id==='ai.dismiss'){ai.controller?.dismiss();return true}if(id==='ai.locate')return ai.controller?.locate()??false
  if(id==='ai.autocomplete.toggle'){ai.setEnabled(value=>!value);ai.autocomplete.current?.dismiss();return true}if(id==='ai.autocomplete.dismiss'){ai.autocomplete.current?.dismiss();return true}if(id==='ai.autocomplete.accept')return ai.autocomplete.current?.accept((input as {requestId?:string})?.requestId??'')??false
  if(id==='edit.undo'||id==='edit.redo'){const direction=id==='edit.undo'?'undo':'redo';try{await history.step(direction);setHistoryReview(null);setError('');return true}catch(cause){const key=cause instanceof Error?cause.message:'';if(['historyConflict','historyDeleted','historyPeerChanges','historyGuardUnavailable','historyExtensionUnavailable'].includes(key)){setHistoryReview({direction,version:history.snapshot()});setError(t(key as MessageKey));return false}throw cause}}if(id==='block.menu'){if(!activeTarget)return false;openBlocks.current?.();return true}
  if(!activeTarget||!active||active.isDestroyed)return false
  if(insertion){const request=id==='node.insert'?{extension:registry.create((input as {type:string})?.type,(input as {data?:Record<string,unknown>})?.data)}:input;const apply='kind'in insertion.target?prepareBlockTransaction(active,id,request,insertion.target):prepareSlashTransaction(active,id,request,insertion.target);if(!apply)return false;insertion.stage(()=>{history.stopCapturing();try{const applied=apply();if(applied&&id==='ai.compose'){ai.controller?.dismiss();ai.open()}return applied}finally{history.stopCapturing()}});return true}
  if(id==='edit.copy'){await navigator.clipboard.writeText(active.state.doc.textBetween(active.state.selection.from,active.state.selection.to,'\n'));return true}
  if(id==='edit.paste'){const anchor=commands.registry.context().selection.anchor,text=await navigator.clipboard.readText();if(signal.aborted||commands.registry.context().selection.anchor!==anchor)return false;return commands.registry.execute('text.insert',{text})}
  history.stopCapturing();try{
   if(id==='text.fontSize.set')return applyFontSizeCommand(active,input)
   if(id==='node.resolve'){const request=input as {instanceId:string;ids:string[];choices:Record<string,string>};if(!selectedNode||selectedNode.value.instanceId!==request?.instanceId)return false;return resolveExtensionEdits(document,registry,request.instanceId,request.ids,request.choices,model.structure.origin)}
   if(['node.insert','node.update','node.delete','node.migrate','node.resources'].includes(id)){const prepared=prepareNodeTransaction(active,registry,id,input);if(!prepared?.commit())return false;if(id!=='node.delete')setPanel('properties');return prepared.value??true}
   if(id==='reference.person'){const tr=startMentionTransaction(active.state);if(!tr)return false;active.view.dispatch(tr);active.commands.focus();return true}
   if(id==='reference.person.insert'){const value=input as {match:MentionMatch;candidate:MentionCandidate};return insertMention(active,value.match,value.candidate)}
   if(id==='text.insert'){const text=(input as {text?:unknown})?.text;if(typeof text!=='string'||text.length>1000000)return false;return active.chain().focus().insertContent(text.replaceAll('\r\n','\n').split('\n').flatMap((part,index)=>[...(index?[{type:'hardBreak'}]:[]),...(part?[{type:'text',text:part}]:[])])).run()}
   if(['text.bold','text.italic','text.underline','text.strike'].includes(id))return active.chain().focus().toggleMark(id.slice(5)).run()
   if(blockOperations.includes(id)){const target=blockTarget(active.state);return target?prepareBlockTransaction(active,id,input,target)?.()??false:false}
   if(id==='text.link.open'){setLink(String(active.getAttributes('link').href??''));return true}
   if(id==='text.link.clear')return active.chain().focus().extendMarkRange('link').unsetLink().run()
   if(id==='text.link.set'){const href=(input as {href?:unknown})?.href;if(typeof href!=='string'||href.length>2048)throw new Error(t('linkInvalid'));let url:URL;try{url=new URL(href)}catch{throw new Error(t('linkInvalid'))}if(!['http:','https:','mailto:'].includes(url.protocol))throw new Error(t('linkInvalid'));const result=active.chain().focus().extendMarkRange('link').setLink({href:url.href}).run();if(result)setLink(null);return result}
   if(id==='text.color'||id==='text.highlight'){const color=(input as {color?:unknown})?.color;if(typeof color!=='string'||!/^#[a-f0-9]{6}$/i.test(color))return false;return active.chain().focus().setMark(id==='text.color'?'textColor':'textBackground',{color}).run()}
   if(id==='text.color.clear'||id==='text.highlight.clear')return active.chain().focus().unsetMark(id==='text.color.clear'?'textColor':'textBackground').run()
   if(id==='text.border')return active.chain().focus().setMark('textBorder',{color:'#1f2328',widthPt:1,style:'solid'}).run();if(id==='text.border.clear')return active.chain().focus().unsetMark('textBorder').run()
   return false
  }finally{history.stopCapturing()}
 },report)
 async function commitResource(draft:WordNodeResourceDraft,expected:ExtensionNodePayload){
  if(!active||active.isDestroyed||expected.instanceId!==draft.expected.instanceId||expected.type!==draft.expected.type||activeRegion!==draft.regionId||!registry.resolve(expected))throw new Error('word-node-resource-target-changed')
  const resources=expected.resources??[],same=resources.find(resource=>resource.key===draft.resource.key)
  if(same){const selected=selectedExtension(active.state);if(JSON.stringify(same)!==JSON.stringify(draft.resource)||!selected||JSON.stringify(selected.value)!==JSON.stringify(expected))throw new Error('word-node-resource-target-changed');return expected}
  const result=await commands.registry.execute('node.resources',{instanceId:expected.instanceId,expected,resources:[...resources,draft.resource]})
  if(!result||typeof result!=='object')throw new Error('word-node-resource-target-changed');return result as ExtensionNodePayload
 }
 async function attachResource(draft:WordNodeResourceDraft,expected:ExtensionNodePayload){
  // Bind the target displayed when clicked. Peer edits during staging cannot
  // silently rebase it; the ordinary command verifies this exact envelope.
  await nodeResources.attach(draft.id,staged=>commitResource(staged,expected))
 }
 async function archiveResource(file:File,expected:ExtensionNodePayload){
  if(!activeRegion)throw new Error('word-node-resource-target-changed');setPanel('properties')
  let result:ExtensionNodePayload|undefined
  await nodeResources.start(file,expected,activeRegion,async staged=>{result=await commitResource(staged,expected);return result})
  if(!result)throw new Error('word-node-resource-target-changed');return result
 }
 const autocomplete=useAiAutocomplete({editor:active,controller:ai.automatic,state:ai.autoState,policy:ai.configuration.autocomplete,enabled:ai.enabled,blocked:!aiWritable||!!ai.composer||palette||!!menu||link!==null||!!active&&menuBlocks.has(active),online:state.connected&&provider.isSynced,onAccept:requestId=>commands.run('ai.autocomplete.accept',{requestId})})
 ai.autocomplete.current=autocomplete
 const onMenus=useCallback((editor:Editor,blocked:boolean)=>setMenuBlocks(previous=>{if(previous.has(editor)===blocked)return previous;const next=new Set(previous);if(blocked)next.add(editor);else next.delete(editor);return next}),[])
 const handleEditorKey=(editor:Editor,event:KeyboardEvent)=>{
  if(editor!==active)return false
  if(!ai.composer&&!palette&&!menu&&link===null&&!menuBlocks.has(editor)&&aiSpaceEntry(editor.state,event,ai.can('insert'))){commands.run('ai.open');return true}
  if(commands.registry.handleKey(event,undefined,id=>{if(id!=='ai.autocomplete.accept')autocomplete.dismiss()}))return true
  return autocomplete.handleKey(event)
 }
 useEffect(()=>{if(!canvas.current)return;const observer=new ResizeObserver(entries=>setAvailableWidth(entries[0].contentRect.width));observer.observe(canvas.current);return()=>observer.disconnect()},[])
 const maxWidth=Math.max(...layout.sections.map((_value,index)=>wordPaperGeometry(layout,index).width)),scale=Math.min(1,Math.max(.25,(availableWidth-72)/maxWidth))*zoom/100,page=wordPaperGeometry(layout,section),current=layout.sections[section],header=wordStoryForPage(layout,section,'header',variant==='first',variant==='even'?2:1),footer=wordStoryForPage(layout,section,'footer',variant==='first',variant==='even'?2:1)
 function locate(client:number,follow=false){
  const followTicket=follow?followIntent.capture(client):null;if(follow&&!followTicket)return
  const value=provider.awareness?.getStates().get(client);if(!value){if(follow)setFollowing(null);return}
  if(follow&&viewportFollowCycle(provider.awareness!.getStates(),provider.awareness!.clientID,client)){setFollowing(null);setError(t('wordFollowCycle'));return}
  const raw=value[structureViewportField],viewport=readStructureViewport(raw),cursor=value[structureCursorField],regionId=follow?raw?.regionId??cursor?.regionId:cursor?.regionId??raw?.regionId
  if(typeof regionId!=='string'||!/^n_[a-f0-9]{32}$/.test(regionId))return
  const position=readWordPaperLocation(!follow&&cursor?.context?cursor.context:raw),location=wordPresenceLocation(layout,regionId,position?.sectionId??raw?.sectionId,position?.variant??raw?.variant);if(!location)return
  const paperIndex=position?.paperIndex
  setSection(location.section);setStories(location.stories);if(location.variant)setVariant(location.variant)
  if(location.stories)book.current?.locateSection(location.section,0,paperIndex??0)
  requestAnimationFrame(()=>{
   if(followTicket&&!followIntent.current(followTicket))return
   const container=scroll.current;if(!container)return
   const region=editors.current.get(regionId),person=value.user?.id,caret=!follow&&typeof person==='string'&&region&&!region.isDestroyed?[...region.view.dom.querySelectorAll<HTMLElement>('[data-hcd-collaborator-id]')].find(node=>node.dataset.hcdCollaboratorId===person):undefined
   if(caret){const box=caret.getBoundingClientRect(),outer=container.getBoundingClientRect();container.scrollTop+=box.top-outer.top-container.clientHeight/3}
   else if(viewport&&raw?.book===1&&position)book.current?.locateSection(location.section,position.paperProgress??0,paperIndex)
   else if(readWordBookProgress(raw)!==undefined)container.scrollTop=readWordBookProgress(raw)!*Math.max(0,container.scrollHeight-container.clientHeight)
   else book.current?.locateSection(location.section,viewport?.progress??0,paperIndex)
  })
 }
 function startFollow(client:number){setFollowing(client);locate(client,true)}
 const locateRef=useRef(locate);locateRef.current=locate
 useEffect(()=>{const refresh=()=>{const values:Array<{client:number;id:string;name:string;color:string}>=[];for(const[client,value]of provider.awareness?.getStates()??[]){const user=value.user;if(typeof user?.id==='string'&&typeof user.name==='string')values.push({client,id:user.id,name:user.name.slice(0,64),color:/^#[a-f0-9]{6}$/i.test(user.color)?user.color:'#3478c0'})}setPeers(selectViewportConnections(values,following));if(following!==null)locateRef.current(following,true)};provider.awareness?.on('change',refresh);refresh();return()=>provider.awareness?.off('change',refresh)},[provider,following])
 useEffect(()=>{const element=scroll.current;if(!element)return;let frame=0;const publish=()=>{frame=0;const position=book.current?.viewport(),bookProgress=element.scrollTop/Math.max(1,element.scrollHeight-element.clientHeight);provider.awareness?.setLocalStateField(structureViewportField,{version:1,owner:String(provider.awareness?.clientID??document.clientID),progress:position?.sectionProgress??bookProgress,bookProgress,anchor:null,...(position??{sectionId:layout.sections[section]?.id,variant}),...(following!==null?{following}:{})})};const schedule=()=>{if(!frame)frame=requestAnimationFrame(publish)};element.addEventListener('scroll',schedule,{passive:true});publish();return()=>{element.removeEventListener('scroll',schedule);cancelAnimationFrame(frame)}},[provider,section,variant,zoom,following,document])
 useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(session.scope==='write'&&(!controller.state().saved||images.uploading||cache.snapshot()==='writing')){event.preventDefault();event.returnValue=''}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[controller,images,cache,session.scope])
 function focusStory(kind:'header'|'footer'){const story=kind==='header'?header:footer;if(!story){setMissingStory({kind,section,variant});return}setMissingStory(null);setStories(true);requestAnimationFrame(()=>editors.current.get(story.id)?.commands.focus('start'))}
 const selectNode=(instanceId:string)=>{
  for(const region of model.capture().regions)if(extensionNodeLocations(model.project(region.regionId)).has(instanceId)){
   const location=wordPresenceLocation(layout,region.regionId,current.id,variant);if(!location)return false
   setSection(location.section);setStories(location.stories);if(location.variant)setVariant(location.variant);setNodeLocation({regionId:region.regionId,instanceId});setPanel('properties');return true
  }
  return false
 }
 useEffect(()=>{
  if(!nodeLocation)return
  const editor=editors.current.get(nodeLocation.regionId)
  if(!editor||editor.isDestroyed)return
  return waitForWordNode({
   exists:()=>extensionNodeLocations(model.project(nodeLocation.regionId)).has(nodeLocation.instanceId),
   locate:()=>{if(editor.isDestroyed)return false;const entry=extensionNodeLocations(editor.state.doc).get(nodeLocation.instanceId);if(!entry)return false;editor.commands.setNodeSelection(entry.position);editor.commands.focus();setActive(editor);setNodeLocation(null);return true},
   subscribe:listener=>{editor.on('transaction',listener);return()=>editor.off('transaction',listener)},
   missing:()=>{setNodeLocation(null);setError(t('wordNodeLocationMissing'))},
  })
 },[nodeLocation,section,variant,stories,editorGeneration,model,t])
 useEffect(()=>{
  if(!outlineLocation)return
  const editor=editors.current.get(outlineLocation.sectionId)
  return waitForWordNode({
   exists:()=>{try{return wordOutlinePosition(model.project(outlineLocation.sectionId),outlineLocation)!==null}catch{return false}},
   locate:()=>{
    if(!editor||editor.isDestroyed)return false
    try{
     const transaction=wordOutlineTransaction(editor.state,outlineLocation)
     if(!transaction)return false // Wait for the scoped binding's projection.
     editor.view.dispatch(transaction);editor.view.focus();setActive(editor);setOutlineCurrent(outlineLocation.key);setOutlineLocation(null)
     const position=wordOutlinePosition(editor.state.doc,outlineLocation),node=position===null?null:editor.view.nodeDOM(position),container=scroll.current
     if(node instanceof Element&&container){const rect=node.getBoundingClientRect(),box=container.getBoundingClientRect();container.scrollTo({top:container.scrollTop+rect.top-box.top-16,behavior:'smooth'})}
     return true
    }catch{setOutlineLocation(null);setOutlineNotice(true);return true}
   },
   subscribe:listener=>{model.document.on('update',listener);if(editor&&!editor.isDestroyed)editor.on('transaction',listener);return()=>{model.document.off('update',listener);if(editor&&!editor.isDestroyed)editor.off('transaction',listener)}},
   missing:()=>{setOutlineLocation(null);setOutlineNotice(true)},
  })
 },[outlineLocation,editorGeneration,model])
 const attach=useCallback((id:string,editor:Editor|null)=>{if(editor)editors.current.set(id,editor);else editors.current.delete(id);setEditorGeneration(value=>value+1)},[])
 const activate=(editor:Editor)=>{selected.current=null;const region=[...editors.current].find(([,value])=>value===editor)?.[0],index=layout.sections.findIndex(section=>section.id===region);if(index>=0){setSection(index);setStories(false)}setActive(editor);render(value=>value+1)}
 const insertOutline=()=>{
  if(!active||active.isDestroyed||stories||!aiWritable||activeRegion!==layout.sections[section].id)return
  try{const entries=wordOutline(layout,model.structure.project(),{fullLabels:true}),transaction=wordOutlineSnapshotTransaction(active.state,entries,t('untitledHeading'));if(!transaction){setError(t('wordOutlineSnapshotUnavailable'));return}history.stopCapturing();try{active.view.dispatch(transaction);active.commands.focus()}finally{history.stopCapturing()};setError('')}
  catch{setError(t('wordOutlineSnapshotUnavailable'))}
 }
 const regionView=(id:string,kind:'body'|'header'|'footer',flow?:WordPageFlowBinding)=><WordRegionView flow={flow} cursorContext={()=>kind==='body'?undefined:book.current?.editingLocation()} key={id} regionId={id} kind={kind} model={model} session={session} connection={connection} user={local} registry={registry} images={images} commands={commands} readOnly={state.readOnly||kind==='body'&&stories||kind!=='body'&&!stories} aiBlocked={!!ai.composer} onMenus={onMenus} onEditorKey={handleEditorKey} attach={attach} activate={activate} setBlockTarget={target=>{selected.current=target;commands.registry.refresh()}} setBlockMenu={open=>{openBlocks.current=open}} onImage={id=>{setImage(id);setPanel('images')}} onError={report} onContext={(x,y)=>setMenu({x,y})}/>
 return <div className="workspace semantic-workspace regional-word-workspace" onKeyDownCapture={event=>{if(event.nativeEvent.isComposing)return;if(following!==null)setFollowing(null);if(!(event.target instanceof HTMLElement)||event.target.closest('.tiptap'))return;if(commands.registry.handleKey(event.nativeEvent,'input'))event.preventDefault()}}>
  <header className="word-titlebar"><span className="word-app-badge">W</span><div><strong>{session.documentId}</strong><small>{t(state.topologyPending?'wordTopologyPaused':state.saved?'saved':state.saving?'saving':state.connected?'editing':'connecting')} · r{state.revision??'—'}</small></div><button onClick={()=>commands.run('view.collaboration')}>{peers.length} {t('onlineCollaborators')}</button><LocaleSelect/>{allowClose&&<button aria-label={t('close')} onClick={()=>void close()}>×</button>}</header>
  <nav className="word-tabs">{(['home','insert','layout','view','export'] as const).map(value=><button key={value} aria-selected={tab===value} onClick={()=>setTab(value)}>{t(value==='home'?'home':value==='insert'?'insert':value==='layout'?'wordPageLayout':value==='view'?'view':'export')}</button>)}</nav>
  <nav className="toolbar ribbon" aria-label={t('toolbar')}><CommandRibbon registry={commands.registry} run={commands.run} tab={tab}/>{tab==='home'&&<div className="word-tool-group word-font-size-tool"><FontSizeControl editor={activeTarget} readOnly={!state.ready||state.readOnly||history.busy} commands={commands.registry}/><span>{t('fontSize')}</span></div>}{tab==='insert'&&<div className="word-tool-group"><button onClick={()=>focusStory('header')}>{t('wordEditHeader')}</button><button onClick={()=>focusStory('footer')}>{t('wordEditFooter')}</button></div>}{tab==='view'&&<div className="word-tool-group"><button type="button" aria-pressed={historyOpen} disabled={state.revision===null} onClick={()=>historyOpen?closeRevisionHistory():openRevisionHistory()}>{t('revisionHistory')}</button></div>}{stories&&<div className="word-story-context"><span role="status" title={t('wordEditingStory',{region:t(activeStoryKind==='header'?'headerRegion':activeStoryKind==='footer'?'footerRegion':'wordHeaderFooter')})}>{t(activeStoryKind==='header'?'headerRegion':activeStoryKind==='footer'?'footerRegion':'wordHeaderFooter')} · {t('wordSection',{count:section+1})} · {t(storyVariant==='first'?'wordFirstPageVariant':storyVariant==='even'?'wordEvenPageVariant':'wordDefaultPages')}{storyLinked?` · ${t('wordLinkedPrevious')}`:''}{sharedStory?` · ${t('wordSharedStoryNotice')}`:''}</span><button type="button" onClick={()=>setStories(false)}>{t('wordCloseStories')}</button></div>}{tab==='export'&&<ExportControl session={session} revision={state.revision} runExport={operation=>withRegionalFileLock(cache.name,operation)} beforeExport={beforeRegionalExport} beforeDownload={beforeRegionalDownload} hint="wordRegionExportHint"/>}</nav>
  {historyReview&&historyReview.version===history.snapshot()&&<section className="history-review" role="group" aria-label={t('editHistory')}><p role="alert">{error}</p><div className="history-review-actions"><button disabled={history.busy} onClick={()=>{setHistoryReview(null);setError('')}}>{t('cancel')}</button><button disabled={state.readOnly||history.busy} title={t('historySkipHint')} onClick={()=>{try{history.skip(historyReview.direction,historyReview.version);setHistoryReview(null);setError('')}catch{setError(t('historyChanged'))}}}>{t('historySkip')}</button></div></section>}{error&&!(historyReview&&historyReview.version===history.snapshot())&&<div className="word-region-error" role="alert">{t('saveFailed')} · {error}<button onClick={()=>setError('')}>×</button></div>}{state.problem&&<div className="word-region-error" role="status">{state.problem==='deletion-drafts-conflict'?t('deletionReviewHint'):<>{t(state.problem.startsWith('word-upload-')?'wordUploadPending':state.problem.startsWith('node-drafts-')?'nodeConflicts':'saveConflict')} · <code>{state.problem}</code></>}<button onClick={state.problem==='deletion-drafts-conflict'?()=>setPanel('deletions'):state.problem.startsWith('word-upload-')?()=>setPanel('images'):state.problem.startsWith('node-drafts-')?()=>setPanel('nodes'):retryConnection}>{t(state.problem==='deletion-drafts-conflict'?'deletionReviewTitle':state.problem.startsWith('word-upload-')?'wordUploadTasks':state.problem.startsWith('node-drafts-')?'nodeConflicts':'retry')}</button></div>}
  {outlineNotice&&<div className="word-region-error" role="status">{t('wordOutlineMissing')}<button type="button" aria-label={t('close')} onClick={()=>setOutlineNotice(false)}>×</button></div>}
  {missingStory&&missingStory.section===section&&missingStory.variant===variant&&<div className="word-region-error" role="status">{t(missingStory.kind==='header'?'wordMissingHeaderNotice':'wordMissingFooterNotice')}<button type="button" aria-label={t('close')} onClick={()=>setMissingStory(null)}>×</button></div>}
  <div className="word-region-layout">{navigation&&<WordOutlineNavigation model={model} layout={layout} section={section} current={outlineCurrent} canInsert={!!active&&!active.isDestroyed&&!stories&&aiWritable&&activeRegion===current.id&&active.state.selection.empty} onInsert={insertOutline} onClose={()=>commands.run('view.navigation',{enabled:false})} onSection={index=>{setFollowing(null);setOutlineLocation(null);setOutlineCurrent(null);setOutlineNotice(false);setSection(index);setStories(false);book.current?.locateSection(index)}} onLocate={entry=>{const index=layout.sections.findIndex(value=>value.id===entry.sectionId);if(index<0){setOutlineNotice(true);return}setOutlineNotice(false);setFollowing(null);setSection(index);setStories(false);setOutlineLocation(entry)}}/>}
   <div ref={canvas} className="word-region-center"><div ref={scroll} className="document-scroll word-region-scroll" onWheel={()=>setFollowing(null)} onPointerDown={()=>setFollowing(null)}><WordBookSurface ref={book} layout={layout} section={section} scale={scale} scroll={scroll.current} activeRegion={activeRegion} initialPaperIndex={connection.workspace.current?.paperIndex} editingStories={stories} previewVariant={variant} renderBody={(id,flow)=>regionView(id,'body',flow)} renderStory={story=>regionView(story.id,story.kind)} onBody={index=>{setSection(index);setStories(false)}} onViewSection={index=>{if(!active?.isFocused)setSection(index)}} onLayout={setPageFlow} onStory={(index,kind,nextVariant,id)=>{setSection(index);setVariant(nextVariant);if(!id){setMissingStory({kind,section:index,variant:nextVariant});return}setMissingStory(null);setStories(true);requestAnimationFrame(()=>editors.current.get(id)?.commands.focus('start'))}}/></div></div>
   {panel&&<aside className="workspace-sidebar">{panel!=='nodes'&&panel!=='deletions'&&<div className="panel-head"><h2>{t(panel==='images'?'imageOptions':panel==='properties'?'properties':'onlineCollaborators')}</h2><button aria-label={t('hidePanel')} onClick={()=>commands.run('view.panel.close')}>×</button></div>}{panel==='deletions'?<DeletionReviewPanel groups={deletionConflicts} readOnly={state.readOnly||history.busy} canRestore={group=>!group.restoreAtEnd} canDelete={group=>canConfirmDeletion(model.structure,group,registry)} onClose={()=>setPanel(null)} onChoose={async(group,choice)=>{if(state.readOnly||history.busy||choice==='restore'&&group.restoreAtEnd)throw new Error('deletion-review-changed');if(choice==='delete'&&!canConfirmDeletion(model.structure,group,registry))throw new Error('deletion-review-changed');history.stopCapturing();try{resolveWordDeletionReview(model,projection,group,choice)}finally{history.stopCapturing()}}}/>:panel==='images'?<><WordUploadPanel client={uploads} globalPending={state.uploadPending} documentSaved={state.saved} disabled={state.readOnly||history.busy}/><ImagePanel session={session} revision={state.revision} drafts={images} disabled={state.readOnly} allowReplacement={!uploads.state().busy} onReplace={(file,image)=>uploads.start(file,image)} selectedNodeId={image} onSelected={setImage} onRevised={()=>{}} onSaveGeometry={()=>save().then(()=>{})}/></>:panel==='properties'?<><section className="inspector-property-group"><h3>{t('formatting')}</h3><FontSizeControl editor={activeTarget} readOnly={!state.ready||state.readOnly||history.busy} commands={commands.registry}/></section><WordNodeResourcePanel client={nodeResources} selected={selectedNode?.value??null} disabled={state.readOnly||history.busy} onLocate={selectNode} onApply={attachResource}/>{selectedNode?<ExtensionProperties key={selectedNode.value.instanceId} node={selectedNode.value} edits={selectedNodeEdits} registry={registry} commands={commands.registry} readOnly={state.readOnly} onArchive={archiveResource}/>:<p className="word-region-note">{t('wordNodeResourceSelect')}</p>}</>:panel==='nodes'?<NodeConflictPanel groups={nodeProblems} onSelect={selectNode} onClose={()=>setPanel(null)}/>:<>{peers.map(peer=><div key={peer.id} className="word-region-peer"><span style={{background:peer.color}}>{peer.name.slice(0,1)}</span><strong>{peer.name}</strong>{peer.id!==local.id&&<><button onClick={()=>locate(peer.client)}>{t('locateCollaborator')}</button><button aria-pressed={following===peer.client} onClick={()=>following===peer.client?setFollowing(null):startFollow(peer.client)}>{t(following===peer.client?'stopFollowing':'followCollaboratorAction')}</button></>}</div>)}</>}</aside>}
  </div>
  <footer className="statusbar"><button onClick={()=>commands.run('view.navigation')}>{t('wordSections')}</button><span>{t('wordSection',{count:section+1})}</span><span role="status" title={t(pageFlow.reason==='break'?'wordFlowBreakPreview':pageFlow.reason==='parity'?'wordFlowUnknownParity':'wordFlowScreenOnly')}>{t(pageFlow.phase==='ready'?pageFlow.reason==='parity'||pageFlow.reason==='break'?'wordFlowPreviewPages':'wordFlowPages':pageFlow.phase==='unsupported'?'wordFlowContinuous':'wordFlowMeasuring',{count:pageFlow.pages??0})}</span><button ref={paperButton} type="button" aria-haspopup="dialog" onClick={()=>setPaperOverview(true)} title={t('wordPaperOverview')}>{wordPaperFormat(page.width,page.height)??t('wordPaperSize')} · {t(page.width>page.height?'wordLandscape':'wordPortrait')}</button><select aria-label={t('wordHeaderFooter')} value={variant} onChange={event=>setVariant(event.target.value as typeof variant)}><option value="first">{t('wordFirstPage')}</option><option value="default">{t('wordDefaultPages')}</option><option value="even">{t('wordEvenPages')}</option></select>{state.resourcePending&&<button onClick={()=>setPanel('properties')}>{t('wordNodeResourceTasks')}</button>}{nodeProblems.length>0&&<button onClick={()=>setPanel('nodes')}>{t('nodeConflicts')} ({nodeProblems.length})</button>}{state.uploadPending&&<button onClick={()=>setPanel('images')}>{t('wordUploadPending')}</button>}<WordDeviceDownloadButton cache={cache} session={session}/><button onClick={()=>setDeviceFileReview(true)}>{t('wordDeviceFileTitle')}</button><span>{t(cache.snapshot()==='failed'?'localDraftUnavailable':cache.snapshot()==='stored'?'localDraftStored':'localDraftLoading')}</span><label>{zoom}%<input aria-label={t('zoom')} type="range" min={wordWorkspaceZoom.min} max={wordWorkspaceZoom.max} step={wordWorkspaceZoom.step} value={zoom} onChange={event=>commands.run('view.zoom.set',{percent:Number(event.target.value)})}/></label></footer>
  {storyBusy&&!storyReview&&!storyTransaction?.record&&<p className="word-region-error" role="status">{t('wordStoryRequestWorking')} <button onClick={()=>storyCancellation.current?.abort()}>{t('cancel')}</button></p>}
  {storyReview&&<WordStoryReviewDialog review={storyReview} busy={storyBusy} error={storyError} onCancel={()=>{storyCancellation.current?.abort();setStoryReview(null)}} onConfirm={()=>void confirmStory()}/>}
  {linkBusy&&!linkReview&&!linkTransaction?.record&&<p className="word-region-error" role="status">{t('wordLinkRequestWorking')} <button onClick={()=>linkCancellation.current?.abort()}>{t('cancel')}</button></p>}
  {linkReview&&<WordLinkReviewDialog review={linkReview} busy={linkBusy} error={linkError} onCancel={()=>{linkCancellation.current?.abort();setLinkReview(null)}} onConfirm={()=>void confirmLink()}/>}
  {paperOverview&&<WordPaperOverview layout={layout} section={section} onClose={closePaperOverview} startEditing={paperSetup} editing={pageTransaction&&session.collaborationProtocol===wordLayoutProtocol?{layoutHash:projection.flowLayoutHash,revision:state.revision??projection.revision,submit:submitPage}:undefined}/>}
  {link!==null&&<div className="hcd-dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setLink(null)}}><div className="hcd-dialog" role="dialog" aria-modal="true" aria-label={t('setLink')}><h2>{t('setLink')}</h2><label>{t('linkAddress')}<input autoFocus type="url" value={link} onChange={event=>setLink(event.target.value)} onKeyDown={event=>{if(event.key==='Escape')setLink(null);if(event.key==='Enter'&&!event.nativeEvent.isComposing)commands.run('text.link.set',{href:link.trim()})}}/></label><div className="hcd-dialog-actions"><button onClick={()=>setLink(null)}>{t('cancel')}</button><button onClick={()=>commands.run('text.link.set',{href:link.trim()})}>{t('applyLink')}</button></div></div></div>}
  {active&&!active.isDestroyed&&ai.composer&&<AiComposer key={ai.composer.id} editor={active} entry={ai.composer} state={ai.state} actions={ai.configuration.actions} available={!!ai.controller} canReplace={ai.can('replace')} canInsert={ai.can('insert')} onStart={(action,instruction)=>commands.run('ai.request',{actionId:action,instruction})} onAccept={()=>commands.run('ai.accept',{requestId:ai.state.requestId})} onCancel={()=>commands.run('ai.cancel')} onDismiss={()=>commands.run('ai.dismiss')} onClose={ai.close}/>}
  {deviceFileReview&&<WordDeviceBackupReview session={session} model={model} cache={cache} controller={controller} onImported={retryConnection} onClose={()=>setDeviceFileReview(false)}/>}{palette&&<CommandPalette registry={commands.registry} run={commands.run} onClose={()=>setPalette(false)}/>}{menu&&<ContextMenu {...menu} onClose={()=>setMenu(null)} actions={commands.registry.list('context').map(item=>({id:item.id,label:item.label,disabled:!item.enabled,active:item.active,action:()=>commands.run(item.id)}))}/>}
  {historyOpen&&<dialog ref={historyDialog} className="hcd-restore-dialog fixed-history-dialog" aria-label={t('revisionHistory')} onCancel={event=>{event.preventDefault();if(!selectionLoading)closeRevisionHistory()}}><div className="presentation-panel-heading"><strong>{t('revisionHistory')}</strong>{revisionSelection&&<button type="button" onClick={clearRevisionSelection}>← {t('revisionHistory')}</button>}<button className="presentation-icon-button" aria-label={t('close')} onClick={closeRevisionHistory}><EditorIcon name="close"/></button></div><div className="fixed-history-body">{selectionLoading&&<p role="status">{t('loadingRevision')}</p>}{historyProblem&&<p role="alert">{historyProblem}</p>}
   {revisionSelection?<RevisionReview session={session} selection={revisionSelection} latest={state.revision} unsaved={state.saving||provider.hasUnsyncedChanges} canRestore={session.scope==='write'&&state.ready&&!state.readOnly&&!history.busy&&session.collaborationProtocol===wordLayoutProtocol} onClose={closeRevisionHistory} onRefresh={()=>void showRevision(revisionSelection.target)} onRestore={()=>setRestoreAsk(true)}/>:revisionsLoading&&!revisionList.length?<p role="status">{t('loadingRevision')}</p>:<><div className="history">{revisionList.slice().reverse().map(item=><button key={item.revision} type="button" onClick={()=>void showRevision(item.revision)} aria-busy={selectionLoading} title={item.patchId}><span className="revision-avatar">{item.authorName?.slice(0,1)||(item.revision===0?'I':'?')}</span><span className="revision-detail"><strong>r{item.revision} <small>{item.createdAtEpochMs?new Date(item.createdAtEpochMs).toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):''}</small></strong><small>{item.authorName||(item.revision===0?t('initialImport'):t('unknownAuthor'))} · {item.revision===0?t('imported'):item.patchId?.startsWith('restore-')?t('restoredRevision'):t('contentUpdated')}</small><span>{t('viewRevision')}</span></span></button>)}</div>{revisionNextBefore!==null&&revisionNextBefore!==undefined&&<button type="button" disabled={revisionsLoading} onClick={()=>void loadRevisionPage(revisionNextBefore)}>{t('loadOlder')}</button>}{!revisionList.length&&!revisionsLoading&&<p role="status">{t('loadingRevision')}</p>}</>}
  </div></dialog>}
  {revisionSelection&&restoreAsk&&<RestoreRevisionDialog selection={revisionSelection} latest={state.revision} uploading={state.uploadPending} allowed={session.scope==='write'&&state.ready&&!history.busy} supported={session.collaborationProtocol===wordLayoutProtocol} uncertain={restoreUncertain} onCancel={()=>setRestoreAsk(false)} onConfirm={confirmRestore}/>}
 </div>
}
type ViewProps={cursorContext:()=>ReturnType<WordBookHandle['editingLocation']>|undefined;flow?:WordPageFlowBinding;regionId:string;kind:'body'|'header'|'footer';model:NonNullable<WordBrowserState['model']>;session:Session;connection:Connection;user:StructureUser;registry:ReturnType<typeof useNodeExtensions>;images:CollaborativeImageDraftStore;commands:ReturnType<typeof useCommands>;readOnly:boolean;aiBlocked:boolean;onMenus:(editor:Editor,blocked:boolean)=>void;onEditorKey:(editor:Editor,event:KeyboardEvent)=>boolean;attach:(id:string,editor:Editor|null)=>void;activate:(editor:Editor)=>void;setBlockTarget:(target:BlockTarget|null)=>void;setBlockMenu:(open:()=>void)=>void;onImage:(id:string)=>void;onError:(error:unknown)=>void;onContext:(x:number,y:number)=>void}
function WordRegionView(props:ViewProps){
 const {t,locale}=useI18n(),latest=useRef(props);latest.current=props
 const editor=useEditor({immediatelyRender:false,extensions:[WordPageFlow.configure({geometry:()=>latest.current.flow?.geometry??null,onLayout:value=>latest.current.flow?.onLayout(value)}),...schemaExtensions.map(extension=>extension.name==='hcdOpaque'?HcdOpaque.extend({addNodeView(){return wordOpaqueView(props.session,props.connection.controller,props.images,id=>latest.current.onImage(id))}}):extension.name==='hcdExtensionPreservation'?extension.configure({registry:()=>latest.current.registry}):['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(extension.name)?extension.configure({registry:()=>latest.current.registry}):extension),WordRegionCollaboration.configure({model:props.model,regionId:props.regionId,awareness:props.connection.provider.awareness,user:props.user,canWrite:()=>!latest.current.readOnly,canMaintain:()=>!latest.current.connection.controller.state().readOnly,cursorContext:()=>latest.current.cursorContext(),onError:error=>latest.current.onError(error)})],editable:!props.readOnly,editorProps:{attributes:{class:'hcd-editor-body',role:'textbox','aria-multiline':'true','aria-label':t(props.kind==='header'?'wordEditHeader':props.kind==='footer'?'wordEditFooter':'documentContent')},transformPasted:(slice,view)=>clearPastedBlockIds(slice,(view.state.storedMarks||view.state.selection.$from.marks()).find(mark=>mark.type.name==='hcdSource')?.attrs.nodeId)},onFocus:({editor})=>latest.current.activate(editor),onSelectionUpdate:({editor})=>{if(editor.isFocused)latest.current.activate(editor)},onUpdate:({editor})=>{if(editor.isFocused)latest.current.activate(editor)}},[props.regionId,props.model])
 useEffect(()=>{if(!editor)return;props.attach(props.regionId,editor);return()=>props.attach(props.regionId,null)},[editor,props.regionId,props.attach])
 useEffect(()=>{if(editor&&!editor.isDestroyed)(editor.storage as unknown as {hcdWordPageFlow:{requestLayout:()=>void}}).hcdWordPageFlow.requestLayout()},[editor,props.flow?.geometry])
 const resumeFocus=useRef(false)
 useEffect(()=>{if(!editor||editor.isDestroyed)return;if(props.readOnly){resumeFocus.current=editor.isFocused;editor.setEditable(false)}else{editor.setEditable(true);if(resumeFocus.current&&(document.activeElement===document.body||document.activeElement===editor.view.dom))editor.commands.focus();resumeFocus.current=false}},[editor,props.readOnly])
 const localeLabel=t(props.kind==='header'?'wordEditHeader':props.kind==='footer'?'wordEditFooter':'documentContent')
 useEffect(()=>{if(!editor||editor.isDestroyed)return;(editor.storage as unknown as {hcdIdentity:{locale:string}}).hcdIdentity.locale=locale;editor.view.dom.setAttribute('aria-label',localeLabel);editor.view.dispatch(editor.state.tr.setMeta('hcd-ui-locale',locale))},[editor,locale,localeLabel])
 const showSelection=useCallback(({state}:{state:Editor['state']})=>!latest.current.readOnly&&!latest.current.aiBlocked&&!state.selection.empty&&latest.current.commands.registry.list('bubble').some(item=>item.enabled),[])
 const blocks=useBlockControls(editor,props.commands.registry,props.commands.block,props.setBlockTarget,props.readOnly||props.aiBlocked),slash=useSlashMenu(editor,props.commands.registry,props.commands.insert,props.readOnly||props.aiBlocked||blocks.active),mention=useMentionMenu(editor,props.session,props.readOnly||props.aiBlocked||blocks.active||slash.active,(match,candidate)=>props.commands.registry.execute('reference.person.insert',{match,candidate}))
 useEffect(()=>{if(!editor)return;props.onMenus(editor,blocks.active||slash.active||mention.active);return()=>props.onMenus(editor,false)},[editor,blocks.active,slash.active,mention.active,props.onMenus])
 useEffect(()=>{if(editor?.isFocused)props.setBlockMenu(blocks.openSelected)},[editor,blocks.openSelected])
 useEffect(()=>{if(!editor||editor.isDestroyed)return;const element=editor.view.dom,key=(event:KeyboardEvent)=>{if(slash.handleKey(event)||mention.handleKey(event)||latest.current.onEditorKey(editor,event)){event.preventDefault();event.stopPropagation()}};element.addEventListener('keydown',key,true);return()=>element.removeEventListener('keydown',key,true)},[editor,slash.handleKey,mention.handleKey,props.commands.registry])
 return <div className="word-region-rich" data-word-region={props.regionId} data-word-kind={props.kind} onContextMenu={event=>{event.preventDefault();if(editor)props.activate(editor);props.onContext(event.clientX,event.clientY)}}>{editor&&<BubbleMenu editor={editor} shouldShow={showSelection}><div className="word-selection-bubble"><CommandBubble registry={props.commands.registry} run={props.commands.run}/></div></BubbleMenu>}<EditorContent editor={editor}/>{blocks.controls}{blocks.drop}{slash.menu}{mention.menu}</div>
}
