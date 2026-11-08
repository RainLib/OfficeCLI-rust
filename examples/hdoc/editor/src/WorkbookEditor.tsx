import {CommandAction,CommandRibbon,CommandPalette,useCommands,commandMessage} from './commands/react.tsx'
import {commandKeyScope} from './commands/keymap.ts'
import {toggleInput} from './commands/workspace.ts'
import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import {BooleanNumber,createUniver,defaultTheme,type IWorkbookData} from '@univerjs/presets'
import {UniverSheetsCorePreset} from '@univerjs/preset-sheets-core'
import {UniverSheetsDrawingPreset} from '@univerjs/preset-sheets-drawing'
import {HcdUniverAdapter} from '../../xlsx-univer-viewer/src/adapter.ts'
import {hasProtectedSheetReadOnly,hasStoredBlankMappingLimit} from '../../xlsx-univer-viewer/src/hcd.ts'
import {parseStyleCatalog} from '../../xlsx-univer-viewer/src/hcd-parser.ts'
import {ServiceGridClient} from './ServiceGridClient.ts'
import {FixedDraftBootstrap,downloadFixedDraft,type FixedBinding} from './FixedDraftBootstrap.tsx'
import {FixedDraftImport} from './FixedDraftImport.tsx'
import {FixedDraftDownload} from './FixedDraftDownload.tsx'
import {DocumentProblemView} from './DocumentProblem.tsx'
import {classifyDocumentProblem,documentProblemCopy,type DocumentProblem} from './documentProblems.ts'
import {ExportControl} from './ExportControl.tsx'
import {api,ApiError,watchRevisions,type Session} from './api.ts'
import {LiveAccess} from './liveAccess.ts'
import {refreshTextDrafts} from './saveEdits.ts'
import {LocaleSelect,useI18n,type MessageKey} from './i18n.tsx'
import {univerLocale,loadUniverMessages} from './workbookLocale.ts'
import {workbookDraftPort} from './workbookDrafts.ts'
import {WorkbookInputCapture,restoreWorkbookInput,workbookInputDiverged,workbookInputLocation,workbookCellAddress} from './workbookInputBuffer.ts'
import {closeFixedIfSettled} from './fixedCloseGuard.ts'
import {verifyWorkbookDownload,workbookServerHead} from './workbookExportGuard.ts'
import {WorkbookOwnRevisions} from './workbookOwnRevisions.ts'
import {WorkbookDeferredRevisions,workbookLatePeerNeedsReload} from './workbookDeferredRevisions.ts'
import {captureWorkbookViewport,restoreWorkbookViewport,type WorkbookViewport} from './workbookViewport.ts'
import {FixedImageTasks} from './fixedImageTasks.ts'
import {FixedImageTasksView} from './FixedImageTasksView.tsx'
import {FixedPortablePanel} from './FixedPortablePanel.tsx'
import {FixedPresenceIndicator,useFixedPresence,type FixedPeer} from './FixedPresence.tsx'
import {workbookPresence,workbookFollowCycle} from './workbookPresence.ts'
import {restoreWorkbookSource} from './workbookSourceRestore.ts'
import {workbookFormulaAudit} from './workbookFormulaAudit.ts'
import {markWorkbookPeers} from './workbookPeerMarks.ts'
import {WorkbookBlankPreparation} from './workbookBlankPreparation.ts'
import {WorkbookBlankInputCapture,workbookBatchAvoidsBlank,workbookBatchSnapshotAllowed} from './workbookBlankInput.ts'
import {resolveWorkbookBlankInput,resolveWorkbookBlankRecovery} from './workbookBlankRecovery.ts'
import {workbookBlankConflict} from './workbookBlankConflict.ts'
import {WorkbookBlankBatchClient} from './workbookBlankBatchClient.ts'
import {WorkbookBlankBatchPanel} from './WorkbookBlankBatchPanel.tsx'
import {copyMappedBatchCell,readMappedBatchCell,stageMappedBatchDraft} from './workbookBatchMappedCopy.ts'
import {WorkbookCombinedBackup} from './WorkbookCombinedBackup.tsx'
import type {FWorkbook} from '@univerjs/preset-sheets-core'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'

type Props={session:Session;onClose:()=>void;embedded:boolean;allowClose?:boolean}
const idle=()=> 'idle' as const,emptySubscribe=()=>()=>{},emptyVersion=()=>0
export function WorkbookEditor(props:Props){
 return <FixedDraftBootstrap session={props.session} onClose={props.allowClose===false?undefined:props.onClose}>{binding=><WorkbookContent {...props} session={binding.session} binding={binding}/>}</FixedDraftBootstrap>
}

function WorkbookContent({session,onClose,embedded,allowClose=true,binding}:Props&{binding:FixedBinding}){
 const {locale,t}=useI18n(),{texts,controller,journal}=binding
 const access=useMemo(()=>new LiveAccess(session),[session]),accessState=useSyncExternalStore(access.subscribe,access.snapshot)
 useEffect(()=>access.start(),[access])
 const [imageTasks,setImageTasks]=useState<FixedImageTasks|null>(null),[taskGeneration,setTaskGeneration]=useState(0)
 useEffect(()=>{
  if(session.scope!=='write')return
  const tasks=new FixedImageTasks(session,binding.sourceHash,binding.images,controller,()=>access.snapshot()==='write')
  setImageTasks(tasks);void tasks.start();return()=>tasks.dispose()
 },[session,binding.sourceHash,binding.images,controller,access,taskGeneration])
 const imageTaskVersion=useSyncExternalStore(imageTasks?.subscribe??emptySubscribe,imageTasks?.snapshot??emptyVersion)
 const textVersion=useSyncExternalStore(texts.subscribe,texts.snapshot)
 const saveVersion=useSyncExternalStore(controller.subscribe,controller.snapshot)
 const historyVersion=useSyncExternalStore(controller.history.subscribe,controller.history.snapshot)
 const backup=useSyncExternalStore(journal?.subscribe??emptySubscribe,journal?.snapshot??idle)
 const workspace=useRef<HTMLDivElement>(null),exportControls=useRef<HTMLSpanElement>(null),[paletteOpen,setPaletteOpen]=useState(false)
 const [withoutBackup,setWithoutBackup]=useState(binding.unavailable)
 const [closeBackupFailed,setCloseBackupFailed]=useState(false)
 const [revision,setRevision]=useState<number|null>(null),revisionRef=useRef<number|null>(null)
 const [view,setView]=useState<WorkbookViewport|null>(null),[following,setFollowing]=useState<number|null>(null),[collaborationOpen,setCollaborationOpen]=useState(false)
 const workbookRef=useRef<FWorkbook|null>(null)
 const publishedView=useMemo(()=>view?workbookPresence(view,following):null,[view,following])
 const collaboration=useFixedPresence(session,null,accessState==='revoked',null,publishedView)
 const revised=useCallback((next:number)=>{revisionRef.current=Math.max(revisionRef.current??0,next);setRevision(revisionRef.current)},[])
 const [generation,setGeneration]=useState(0),[bootProblem,setBootProblem]=useState<DocumentProblem|null>(null),[error,setError]=useState('')
 const [updates,setUpdates]=useState('connecting'),[ready,setReady]=useState(false),[blankMappingLimit,setBlankMappingLimit]=useState(false),[protectedSheets,setProtectedSheets]=useState(false),[visibleLoadFailed,setVisibleLoadFailed]=useState(false)
 const gridReady=useRef(false)
 const [preparing,setPreparing]=useState(false)
 const blankSaving=useRef(false),blankPort=useRef<{allowed:(sheet:string,row:number,column:number)=>boolean;prepare:(sheet:string,row:number,column:number)=>boolean}|null>(null)
 const [auditing,setAuditing]=useState(false),[auditResult,setAuditResult]=useState<{key:MessageKey;revision:number;count?:number}|null>(null)
 const [restoringSource,setRestoringSource]=useState(false),[sourceNeeded,setSourceNeeded]=useState(false),sourceFile=useRef<HTMLInputElement>(null),sourceRestore=useRef<AbortController|null>(null)
 const [sourceGeneration,setSourceGeneration]=useState(0)
 const sourceChannel=useRef<BroadcastChannel|null>(null)
 useEffect(()=>{
  if(typeof BroadcastChannel==='undefined')return
  try{
   const channel=new BroadcastChannel('hcd-workbook-source');sourceChannel.current=channel
   channel.onmessage=event=>{if(event.data?.documentId===session.documentId&&event.data?.apiUrl===(session.apiUrl??'/v1/documents'))setSourceGeneration(value=>value+1)}
   return()=>{sourceChannel.current=null;channel.close()}
  }catch{return}
 },[session.documentId,session.apiUrl])
 const [,setInputReviewVersion]=useState(0)
 const [discardInput,setDiscardInput]=useState<typeof controller.workbookBuffer>(null)
 const [discardBlank,setDiscardBlank]=useState<typeof controller.workbookBlankInput>(null)
 const [blankConflict,setBlankConflict]=useState<{input:NonNullable<typeof controller.workbookBlankInput>;comparison:Awaited<ReturnType<typeof workbookBlankConflict>>}|null>(null)
 const [protectedSave,setProtectedSave]=useState(false)
 const protectedPaintBlocked=useRef(false)
 const [discardProtectedDraft,setDiscardProtectedDraft]=useState<{id:string;draft:NonNullable<ReturnType<typeof texts.get>>}|null>(null)
 const [replaceInput,setReplaceInput]=useState<{buffer:NonNullable<typeof controller.workbookBuffer>;draft:NonNullable<ReturnType<typeof texts.get>>}|null>(null)
 const [receiptNotice,setReceiptNotice]=useState<{revision:number}| 'missing' | 'unavailable' | null>(null)
 const [inputStopState,setInputStopState]=useState<'idle'|'stopping'|'failed'>('idle'),inputStopping=useRef(false)
 const host=useRef<HTMLDivElement>(null),adapter=useRef<HcdUniverAdapter|null>(null),client=useRef<ServiceGridClient|null>(null)
 const [offscreenEdit,setOffscreenEdit]=useState<string|null>(null),returnToEdit=useRef<(()=>void)|null>(null)
 const finishEditing=useRef<(()=>Promise<boolean>)|null>(null),cancelEditing=useRef<(()=>Promise<boolean>)|null>(null),flushGridRevisions=useRef<(()=>void)|null>(null),isEditing=useRef<()=>boolean>(()=>false),failedAt=useRef<number|null>(null)
 useEffect(()=>{if(!offscreenEdit)return;const onKey=(event:KeyboardEvent)=>{if(isEditing.current()&&!event.isComposing&&event.altKey&&event.shiftKey&&!event.ctrlKey&&!event.metaKey&&event.code==='KeyR'){event.preventDefault();event.stopPropagation();returnToEdit.current?.()}};window.addEventListener('keydown',onKey,true);return()=>window.removeEventListener('keydown',onKey,true)},[offscreenEdit])
 const mounted=useRef(true)
 const [batch,setBatch]=useState<WorkbookBlankBatchClient|null>(null),batchReady=useRef<()=>boolean>(()=>false),batchSaveReady=useRef<()=>boolean>(()=>false)
 // Unresolved saves can coexist with separately journaled non-overlapping
 // blank batches. Submission remains fenced until the original is resolved.
 batchReady.current=()=>access.snapshot()==='write'&&gridReady.current&&!controller.busy&&!controller.history.busy&&!controller.workbookBuffer&&(!controller.workbookBlankInput||!!controller.workbookBlankAttempt)&&(!texts.size||controller.pending)&&!binding.images.size&&!binding.images.uploading&&!blankSaving.current&&!inputStopping.current&&!isEditing.current()&&!withoutBackup&&!!journal&&journal.state!=='failed'&&!!imageTasks&&!imageTasks.pending
 batchSaveReady.current=()=>access.snapshot()==='write'&&gridReady.current&&!controller.busy&&!controller.history.busy&&!binding.images.uploading&&!blankSaving.current&&!inputStopping.current&&!isEditing.current()&&!withoutBackup&&!!journal&&journal.state!=='failed'&&!!imageTasks&&!imageTasks.pending
 useEffect(()=>{if(session.scope!=='write'||!session.userId){setBatch(null);return}const value=new WorkbookBlankBatchClient(session,binding.sourceHash,()=>batchReady.current(),()=>batchSaveReady.current(),()=>access.snapshot()==='write',()=>!controller.pending&&!controller.workbookBlankAttempt);setBatch(value);void value.start();return()=>value.dispose()},[session,binding.sourceHash,access,controller])
 useSyncExternalStore(batch?.subscribe??emptySubscribe,batch?.snapshot??emptyVersion)
 const batchPending=()=>session.scope==='write'&&!!session.userId&&(!batch||batch.pending)
 const batchGuard=<T,>(work:()=>Promise<T>):Promise<T>=>session.scope==='write'&&session.userId?(batch?batch.withClear(work):Promise.reject(new Error('blank batch pending'))):work()
 const followed=collaboration.others.find(peer=>peer.clientId===following&&peer.id!==collaboration.localId)
 const marksKey=JSON.stringify(collaboration.others.map(peer=>[peer.clientId,peer.id,peer.name,peer.color,peer.workbook?.sheetId,peer.workbook?.selection]))
 useEffect(()=>{const book=workbookRef.current;if(!ready||!book||!collaboration.connected)return;return markWorkbookPeers(book,collaboration.others,collaboration.localId)},[ready,generation,view?.sheetId,collaboration.connected,collaboration.localId,marksKey])
 const canLocate=(peer:FixedPeer)=>{const location=peer.workbook,book=workbookRef.current;if(!location||!book||!ready||isEditing.current()||controller.workbookBuffer)return false;const sheet=book.getSheetBySheetId(location.sheetId);return !!sheet&&location.row<sheet.getMaxRows()&&location.column<sheet.getMaxColumns()&&(!location.selection||location.selection.row+location.selection.height<=sheet.getMaxRows()&&location.selection.column+location.selection.width<=sheet.getMaxColumns())}
 const locate=(peer:FixedPeer)=>{const location=peer.workbook,book=workbookRef.current;if(!location||!book||!canLocate(peer))return false;const current=captureWorkbookViewport(book);return restoreWorkbookViewport(book,{sheetId:location.sheetId,row:location.row,column:location.column,zoom:current?.zoom??1,selection:location.selection})}
 useEffect(()=>{if(following===null)return;if(!followed||!collaboration.connected||collaboration.clientId===null||workbookFollowCycle(collaboration.peers,collaboration.clientId,following)){setFollowing(null);return}if(canLocate(followed))locate(followed)},[following,followed,collaboration.connected,collaboration.clientId,ready])
 const lifetime=useRef(new AbortController()),saveFlight=useRef<Promise<number>|null>(null)
 const ownRevisions=useMemo(()=>new WorkbookOwnRevisions(),[controller])
 const pendingViewport=useRef<WorkbookViewport|null>(null)
 useEffect(()=>{mounted.current=true;lifetime.current=new AbortController();return()=>{mounted.current=false;lifetime.current.abort()}},[])
 const writable=useCallback(()=>access.snapshot()==='write'&&!controller.busy&&(!journal||journal.state!=='failed'||withoutBackup),[access,controller,journal,withoutBackup])
 const input=useMemo(()=>new WorkbookInputCapture(texts,controller),[texts,controller])
 const blankInput=useMemo(()=>new WorkbookBlankInputCapture(value=>controller.setWorkbookBlankInput(value)),[controller])
 const port=useMemo(()=>({...workbookDraftPort(texts,()=>gridReady.current&&!batchPending()&&!inputStopping.current&&!blankSaving.current&&!protectedPaintBlocked.current&&access.snapshot()==='write'&&(!controller.workbookBuffer||input.isActive())&&(!controller.workbookBlankInput||blankInput.ownsInput),work=>controller.history.batch(work),()=>!protectedPaintBlocked.current),canStartEdit:()=>!batchPending()&&!inputStopping.current&&!blankSaving.current&&!protectedPaintBlocked.current&&!controller.workbookBlankInput&&!controller.workbookBlankAttempt&&input.canStart(),observed:(id:string,text:string)=>input.observed(id,text),rejected:(id:string)=>{if(input.reject(id)&&mounted.current)setInputReviewVersion(value=>value+1)},blankAllowed:(sheet:string,row:number,column:number)=>blankPort.current?.allowed(sheet,row,column)??false,blankPrepare:(sheet:string,row:number,column:number)=>blankPort.current?.prepare(sheet,row,column)??false,blankActive:(sheet:string,row:number,column:number)=>blankInput.acceptsObservation(sheet,row,column),blankObserved:(sheet:string,row:number,column:number,text:string)=>blankInput.observed(sheet,row,column,text),blankBatchWritable:()=>!protectedPaintBlocked.current&&batchReady.current(),stageBlankBatch:(cells:ReadonlyArray<{sheetId:string;row:number;column:number;text:string}>,revision:number,root:string)=>workbookBatchAvoidsBlank(cells,controller.workbookBlankInput,controller.workbookBlankAttempt)&&workbookBatchSnapshotAllowed(revision,revisionRef.current,controller.pending||!!controller.workbookBlankAttempt)&&client.current?.chunkRevision()===revision&&client.current?.manifest.rootHash===root&&(batch?.capture(cells,revision,root)??false)}),[texts,access,input,blankInput,controller,batch,session.scope,session.userId])
 useEffect(()=>{
  if(session.scope!=='write'||accessState==='write'||!input.isActive()&&!blankInput.active)return
  // Leave the durable private buffer intact before cancelling Univer's editor;
  // its cancellation event must not discard the text the user just typed.
  inputStopping.current=true;setInputStopState('stopping');input.abandon();blankInput.abandon();setInputReviewVersion(value=>value+1)
  const cancel=cancelEditing.current
  void (cancel?cancel():Promise.resolve(false)).catch(()=>false).then(ended=>{
   if(!mounted.current||cancel!==cancelEditing.current)return
   if(ended&&!isEditing.current()){inputStopping.current=false;setInputStopState('idle');adapter.current?.trimToVisibleWindow();adapter.current?.refreshDrafts();flushGridRevisions.current?.()}
   else setInputStopState('failed')
  })
 },[accessState,session.scope,input,blankInput])
 const save=useCallback((insideBatchGuard=false)=>{
  if(saveFlight.current)return saveFlight.current
  setPreparing(true)
  const task=(async()=>{
  if(inputStopping.current||controller.workbookBlankInput)throw new Error('workbookInputPending')
  if(revisionRef.current===null)throw new Error('revisionUnavailable')
  if(finishEditing.current&&!await finishEditing.current())throw new Error('draftsNotReady')
  await access.refresh()
  if(access.snapshot()!=='write'&&!controller.pending)throw new Error('accessRevoked')
  if(!controller.pending)await refreshTextDrafts(session,texts,revised,AbortSignal.any([lifetime.current.signal,AbortSignal.timeout(30_000)]))
  if(session.scope==='write'&&!imageTasks)throw new Error('imageUploadPending')
  const original=controller.state().attempt
  const captured:{value:ReturnType<FixedBinding['controller']['state']>['attempt']}={value:null}
  const submit=async()=>{if(original&&controller.state().attempt?.id!==original.id)throw new Error('fixedSaveChanged');const promise=controller.save(revisionRef.current!,undefined,access.snapshot()!=='write');captured.value=controller.state().attempt;ownRevisions.remember(captured.value?.id);return promise}
  const perform=()=>session.scope==='write'?imageTasks!.withClear(submit):submit()
  const saved=insideBatchGuard?await perform():original&&batchPending()&&batch?await batch.withPendingResolution(()=>{if(controller.state().attempt?.id!==original.id)throw new Error('fixedSaveChanged');return perform()}):await batchGuard(perform)
  // Paint the captured receipt, never the current (possibly newer) cell value.
  if(captured.value&&saved>=(revisionRef.current??0))for(const [id,draft]of captured.value.texts){
   const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(draft.text)),hash=Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('')
   if(mounted.current&&saved>=(revisionRef.current??0))adapter.current?.applyRemoteText(id,draft.text,hash,saved)
  }
  if(mounted.current){revised(saved);const currentClient=client.current;if(currentClient?.manifest)currentClient.manifest.revision=Math.max(currentClient.manifest.revision,saved);protectedPaintBlocked.current=false;adapter.current?.refreshDrafts();setError('');setSourceNeeded(false);setProtectedSave(false);setDiscardProtectedDraft(null)}
  return saved
  })().finally(()=>{if(saveFlight.current===task)saveFlight.current=null;if(mounted.current)setPreparing(false)})
  saveFlight.current=task;return task
 },[access,controller,session,texts,revised,imageTasks,ownRevisions,batch])
 const saveProblem=useCallback((cause:unknown)=>{
  if(cause instanceof Error&&cause.message==='blank batch superseded')return t('workbookBlankSuperseded')
  if(cause instanceof Error&&cause.message.startsWith('blank batch'))return t('workbookBatchBlocked')
  if(cause instanceof Error&&['workbookBlankStateChanged','workbookBlankStateBusy'].includes(cause.message))return t('workbookInputPending')
  if(cause instanceof ApiError&&cause.code==='XLSX_FORMULA_READ_ONLY')return t('workbookSourceFormulaProtected')
  if(cause instanceof ApiError&&cause.code==='XLSX_SHEET_PROTECTED')return t('workbookSourceSheetProtected')
  if(cause instanceof ApiError&&cause.code==='XLSX_MERGED_CELL_READ_ONLY')return t('workbookSourceMergedProtected')
  if(cause instanceof ApiError&&cause.code==='XLSX_SOURCE_CHANGED')return t('workbookSourceChanged')
  if(cause instanceof ApiError&&cause.code==='XLSX_FORMULA_PROOF_REQUIRED')return t('workbookProofRequired')
  if(cause instanceof ApiError&&cause.status===409)return t('saveConflictHint')
  const known:MessageKey[]=['revisionUnavailable','accessRevoked','draftsNotReady','fixedSaveUnknown','readOnlyMode','workbookInputPending','imageUploadPending','historyBusy','historyConflict','historyChanged','historyDeleted','historyInvalid','historyEmpty']
  return cause instanceof Error&&known.includes(cause.message as MessageKey)?t(cause.message as MessageKey):documentProblemCopy(classifyDocumentProblem(cause,'recovery'),locale).title
 },[t,locale])
 const failed=(cause:unknown)=>{failedAt.current=texts.snapshot();if(mounted.current){if(cause instanceof ApiError&&(cause.code==='XLSX_FORMULA_PROOF_REQUIRED'||cause.code==='XLSX_SOURCE_CHANGED'))setSourceNeeded(true);if(cause instanceof ApiError&&['XLSX_FORMULA_READ_ONLY','XLSX_MERGED_CELL_READ_ONLY','XLSX_SHEET_PROTECTED'].includes(cause.code??'')){protectedPaintBlocked.current=true;adapter.current?.refreshDrafts();setProtectedSave(true)}setError(saveProblem(cause))}}
 const saveBlank=async()=>{
  if(blankSaving.current)return
  blankSaving.current=true;setPreparing(true)
  try{
   const original=controller.workbookBlankAttempt?JSON.stringify(controller.workbookBlankAttempt):null
   const reconcileOnly=!!original&&batchPending()&&!!batch
   const work=async()=>{
   if(!journal||withoutBackup)throw new Error('localDraftUnavailable')
   if(controller.pending||controller.busy||controller.history.busy)throw new Error('historyBusy')
   if(finishEditing.current&&!await finishEditing.current())throw new Error('draftsNotReady')
   await access.refresh();if(access.snapshot()!=='write')throw new Error('accessRevoked')
   const signal=AbortSignal.any([lifetime.current.signal,AbortSignal.timeout(60_000)])
   let state=controller.state()
   if(reconcileOnly&&JSON.stringify(state.blankAttempt)!==original)throw new Error('workbookBlankStateChanged')
   const write=(value:typeof state)=>controller.writeWorkbookBlankState(value)
   state=await resolveWorkbookBlankRecovery(state,session,binding.sourceHash,write,signal)
   if(state.blankInput&&!reconcileOnly){const head=await workbookServerHead(session,binding.sourceHash,signal);state=await resolveWorkbookBlankInput(state,session,binding.sourceHash,head,write,signal)}
   if(!state.blankInput)blankInput.release();const head=await workbookServerHead(session,binding.sourceHash,signal)
   if(mounted.current){revised(head);pendingViewport.current=workbookRef.current?captureWorkbookViewport(workbookRef.current):null;gridReady.current=false;setReady(false);setGeneration(value=>value+1);setError('')}
   }
   if(reconcileOnly)await batch!.withPendingResolution(work);else await batchGuard(work)
  }catch(cause){
   const pending=controller.workbookBlankInput
   if(pending&&!controller.workbookBlankAttempt&&cause instanceof ApiError&&cause.code==='XLSX_CELL_ALREADY_MAPPED'){
    try{const comparison=await workbookBlankConflict(session,binding.sourceHash,pending,AbortSignal.any([lifetime.current.signal,AbortSignal.timeout(30_000)]));if(mounted.current&&controller.workbookBlankInput===pending)setBlankConflict({input:pending,comparison})}catch{/* Keep the private input and the original error. */}
   }
   if(mounted.current)setError(cause instanceof Error&&cause.message==='localDraftUnavailable'?t('localDraftUnavailable'):saveProblem(cause))
  }
  finally{blankSaving.current=false;if(mounted.current)setPreparing(false)}
 }
 const checkOriginalReceipt=async()=>{
  if(!controller.pending||controller.busy)return
  setReceiptNotice(null);const sent=controller.state().attempt;if(sent)ownRevisions.remember(sent.id)
  try{
   const result=await controller.checkPendingReceipt()
   if(!mounted.current)return
   if(result===null){setReceiptNotice('missing');return}
   revised(result);if(client.current?.manifest)client.current.manifest.revision=Math.max(client.current.manifest.revision,result)
   setReceiptNotice({revision:result});setError('')
   // A display failure cannot turn an already verified receipt into an
   // unknown outcome. A later revision refresh will repaint the grid.
   try{adapter.current?.refreshDrafts();if(sent&&result>=(revisionRef.current??0))for(const [id,draft] of sent.texts){
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(draft.text)),hash=Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('')
    if(mounted.current&&result>=(revisionRef.current??0))adapter.current?.applyRemoteText(id,draft.text,hash,result)
   }}catch{/* The committed receipt and retained input remain authoritative. */}
  }catch{if(mounted.current)setReceiptNotice('unavailable')}
 }
 const auditFormulas=async()=>{
  const requested=revisionRef.current;if(requested===null||auditing)return
  setAuditing(true);setAuditResult(null)
  try{
   const value=await workbookFormulaAudit(session,requested,false,AbortSignal.any([lifetime.current.signal,AbortSignal.timeout(60_000)]))
   if(mounted.current){setSourceGeneration(value=>value+1);setAuditResult({key:revisionRef.current===requested?'workbookAuditPassed':'workbookAuditStale',revision:requested,count:value.editableCellsChecked})}
  }catch(cause){if(mounted.current){if(cause instanceof ApiError&&(cause.code==='XLSX_SOURCE_MISSING'||cause.code==='XLSX_SOURCE_CHANGED'))setSourceGeneration(value=>value+1);setAuditResult({key:cause instanceof ApiError&&cause.code==='XLSX_SHEET_PROTECTED'?'workbookAuditSheetProtected':cause instanceof ApiError&&cause.code==='XLSX_MERGED_CELL_READ_ONLY'?'workbookAuditMergedConflict':cause instanceof ApiError&&cause.code==='XLSX_FORMULA_READ_ONLY'?'workbookAuditConflict':cause instanceof ApiError&&cause.code==='XLSX_SOURCE_MISSING'?'workbookAuditMissing':'workbookAuditFailed',revision:requested})}}
  finally{if(mounted.current)setAuditing(false)}
 }
 const enableSourceFreeProtection=async()=>{
  const requested=revisionRef.current;if(requested===null||auditing||access.snapshot()!=='write')return
  setAuditing(true)
  try{
   const value=await workbookFormulaAudit(session,requested,true,AbortSignal.any([lifetime.current.signal,AbortSignal.timeout(60_000)]))
   if(mounted.current)setAuditResult({key:revisionRef.current===requested?'workbookProofEnabled':'workbookAuditStale',revision:requested,count:value.editableCellsChecked})
  }catch(cause){if(mounted.current)setAuditResult({key:cause instanceof ApiError&&cause.code==='XLSX_SHEET_PROTECTED'?'workbookAuditSheetProtected':cause instanceof ApiError&&cause.code==='XLSX_MERGED_CELL_READ_ONLY'?'workbookAuditMergedConflict':cause instanceof ApiError&&cause.code==='XLSX_FORMULA_READ_ONLY'?'workbookAuditConflict':cause instanceof ApiError&&cause.code==='XLSX_SOURCE_MISSING'?'workbookAuditMissing':cause instanceof ApiError&&cause.code==='XLSX_AUDIT_REVISION_CHANGED'?'workbookAuditStale':'workbookProofUnknown',revision:requested})}
  finally{if(mounted.current)setAuditing(false)}
 }
 const restoreSource=async(file:File)=>{
  const requested=revisionRef.current;if(requested===null||restoringSource||sourceRestore.current||access.snapshot()!=='write')return
  const operation=new AbortController();sourceRestore.current=operation
  setRestoringSource(true)
  try{
   await restoreWorkbookSource(session,file,AbortSignal.any([lifetime.current.signal,operation.signal,AbortSignal.timeout(120_000)]))
   if(mounted.current){setError('');setSourceNeeded(false);setSourceGeneration(value=>value+1);setAuditResult({key:'workbookSourceRestored',revision:revisionRef.current??requested});try{sourceChannel.current?.postMessage({documentId:session.documentId,apiUrl:session.apiUrl??'/v1/documents'})}catch{/* Other tabs can still refresh independently. */}}
  }catch(cause){if(mounted.current)setAuditResult({key:cause instanceof ApiError&&cause.code==='XLSX_SOURCE_CHANGED'?'workbookSourceChanged':cause instanceof ApiError&&cause.code==='XLSX_SOURCE_CONFLICT'?'workbookSourceRestoreConflict':'workbookSourceRestoreFailed',revision:revisionRef.current??requested})}
  finally{if(sourceRestore.current===operation){sourceRestore.current=null;if(mounted.current)setRestoringSource(false)}}
 }
 useEffect(()=>{
  if(!ready||preparing||!texts.size||controller.workbookBuffer||controller.workbookBlankInput||controller.pending||controller.busy||controller.history.busy||session.scope==='write'&&(!imageTasks||imageTasks.pending)||failedAt.current===texts.snapshot()||!writable()||texts.entries().some(([,draft])=>draft.remote||draft.stale))return
  const timer=setTimeout(()=>{void save().catch(failed)},600)
  return()=>clearTimeout(timer)
 },[textVersion,saveVersion,historyVersion,imageTaskVersion,accessState,ready,preparing,save,controller,texts,writable,saveProblem,imageTasks,session.scope])
 useEffect(()=>{adapter.current?.refreshDrafts()},[textVersion])
 useEffect(()=>{
  const warn=(event:BeforeUnloadEvent)=>{if(batchPending()||isEditing.current()||blankSaving.current||texts.size||controller.workbookBuffer||controller.workbookBlankInput||controller.workbookBlankAttempt||controller.pending||controller.busy||backup==='writing'||(backup==='failed'||closeBackupFailed)&&!withoutBackup||session.scope==='write'&&(!imageTasks||imageTasks.pending)){event.preventDefault();event.returnValue=''}}
  const key=(event:KeyboardEvent)=>{
   if(!workspace.current?.contains(event.target as Node))return
   if(commands.registry.handleKey(event,isEditing.current()?'input':commandKeyScope(event.target))){event.preventDefault();event.stopPropagation()}
  }
  window.addEventListener('beforeunload',warn);window.addEventListener('keydown',key,true)
  return()=>{window.removeEventListener('beforeunload',warn);window.removeEventListener('keydown',key,true)}
 })
 useEffect(()=>{
  let alive=true,dispose:(()=>void)|undefined,unsubscribeDeferred:(()=>void)|undefined
  const editSubscriptions:Array<{dispose():void}>=[]
  const stop=new AbortController(),grid=new ServiceGridClient(session,locale);client.current=grid
  gridReady.current=false;setReady(false);setBootProblem(null);setBlankMappingLimit(false);setVisibleLoadFailed(false)
  void(async()=>{
   await grid.open()
   if(!alive)return
   setBlankMappingLimit(hasStoredBlankMappingLimit(grid.manifest))
   setProtectedSheets(hasProtectedSheetReadOnly(grid.manifest))
   if(grid.sourceHash!==binding.sourceHash)throw new Error('workbookChunkMismatch')
   await refreshTextDrafts(session,texts,revised,stop.signal)
   if(!alive)return
   const styles=parseStyleCatalog(await grid.readStyles()),sheets=grid.sheets(),messages=await loadUniverMessages(locale)
   if(!alive||!host.current)return
   if(!sheets.length)throw new Error('workbookNoSheets')
   const data:Partial<IWorkbookData>={id:grid.manifest.documentId,name:`HCD revision ${grid.manifest.revision}`,appVersion:'0.25.1',locale:univerLocale(locale),styles,sheetOrder:sheets.map(sheet=>sheet.sheetId),
    sheets:Object.fromEntries(sheets.map(sheet=>{
     const descriptors=grid.descriptors.filter(({grid})=>grid?.sheetId===sheet.sheetId),defaults=grid.sheetDefaults(sheet.sheetId)
     return[sheet.sheetId,{id:sheet.sheetId,name:sheet.sheetName,hidden:sheet.sheetState==='visible'?BooleanNumber.FALSE:BooleanNumber.TRUE,
      rowCount:Math.min(1_048_576,Math.max(1000,...descriptors.map(({grid})=>grid?.rowEnd??1))),columnCount:Math.min(16_384,Math.max(26,...descriptors.map(({grid})=>grid?.columnEnd??1))),
      defaultColumnWidth:defaults.columnWidth,defaultRowHeight:defaults.rowHeight,freeze:{xSplit:0,ySplit:0,startRow:0,startColumn:0},cellData:{},rowData:{},columnData:{},mergeData:[],showGridlines:BooleanNumber.TRUE,rightToLeft:BooleanNumber.FALSE}]
    })),custom:{hcdDocumentId:grid.manifest.documentId,hcdRevision:grid.manifest.revision,hcdRootHash:grid.manifest.rootHash}}
   const {univer,univerAPI}=createUniver({locale:univerLocale(locale),locales:{[univerLocale(locale)]:messages},theme:defaultTheme,presets:[UniverSheetsCorePreset({container:host.current,header:false,toolbar:false,formulaBar:session.scope==='write',contextMenu:false,footer:{sheetBar:true,statisticBar:false,menus:false,zoomSlider:true,addSheetButtonConfig:{show:false}}}),UniverSheetsDrawingPreset()]})
   dispose=()=>univer.dispose()
   const workbook=univerAPI.createWorkbook(data)
   workbookRef.current=workbook
   let presenceTimer:ReturnType<typeof setTimeout>|undefined
   const publishViewport=()=>{if(presenceTimer)return;presenceTimer=setTimeout(()=>{presenceTimer=undefined;if(!alive)return;const next=captureWorkbookViewport(workbook);if(next)setView(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next)},100)}
   editSubscriptions.push(univerAPI.addEvent(univerAPI.Event.Scroll,event=>{if(event.workbook.getId()===workbook.getId())publishViewport()}),univerAPI.addEvent(univerAPI.Event.SelectionChanged,event=>{if(event.workbook.getId()===workbook.getId())publishViewport()}),univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged,()=>publishViewport()),{dispose:()=>{clearTimeout(presenceTimer);if(workbookRef.current===workbook)workbookRef.current=null}})
   isEditing.current=()=>workbook.isCellEditing()
   finishEditing.current=async()=>!workbook.isCellEditing()||await workbook.endEditingAsync(true)
   cancelEditing.current=async()=>!workbook.isCellEditing()||await workbook.endEditingAsync(false)
   const refreshWorkbook=()=>{gridReady.current=false;pendingViewport.current=captureWorkbookViewport(workbook);setReady(false);setGeneration(value=>value+1)}
   const current=new HcdUniverAdapter(grid,univerAPI,workbook,session.scope==='write'?'editable':'readonly',message=>{if(!alive)return;if(message==='workbookVisibleLoadFailed')setVisibleLoadFailed(true);else if(message==='workbookVisibleLoaded')setVisibleLoadFailed(false);else if(message==='workbookBlankPreparing')setError(t('workbookBlankPreparing'));else if(message.startsWith('drafts')||message==='readOnlyMode'||message==='workbookBatchTooLarge'||message==='workbookUnsupportedPaste'||message==='workbookUnsupportedFormula'||message==='workbookCellUnmapped'||message==='workbookCellProtected'||message==='workbookCellPending')setError(t(message==='workbookBatchTooLarge'?'workbookBatchTooLarge':message==='workbookUnsupportedPaste'?'workbookUnsupportedPaste':message==='workbookUnsupportedFormula'?'workbookUnsupportedFormula':message==='workbookCellUnmapped'?'workbookCellUnmapped':message==='workbookCellProtected'?'workbookCellProtected':message==='workbookCellPending'?'workbookCellPending':message==='readOnlyMode'?'readOnlyMode':'workbookDraftRejected'))},port)
   const preparation=new WorkbookBlankPreparation(session,binding.sourceHash);editSubscriptions.push({dispose:()=>preparation.dispose()})
   let startingBlank:{cell:import('./workbookBlankInspection.ts').BlankObservation;revision:number}|null=null
   const eligible=(sheet:string,row:number,column:number)=>alive&&gridReady.current&&access.snapshot()==='write'&&!blankSaving.current&&!controller.workbookBlankInput&&!controller.workbookBlankAttempt&&revisionRef.current===grid.chunkRevision()&&current.canInspectBlank(sheet,row,column)
   const isSelected=(sheet:string,row:number,column:number)=>{const range=workbook.getActiveRange();return workbook.getActiveSheet().getSheetId()===sheet&&!!range&&range.getRow()===row&&range.getColumn()===column&&range.getHeight()===1&&range.getWidth()===1}
   const prepareBlank=(sheet:string,row:number,column:number,notify:boolean)=>{
    if(notify&&alive&&revisionRef.current!==grid.chunkRevision()&&!texts.size&&!controller.pending&&!controller.busy&&!controller.workbookBuffer&&!controller.workbookBlankInput&&!controller.workbookBlankAttempt&&!workbook.isCellEditing()){refreshWorkbook();return true}
    if(!eligible(sheet,row,column)||!isSelected(sheet,row,column))return false
    const target={sheetId:sheet,row,column},revision=grid.chunkRevision(),root=grid.manifest.rootHash
    void preparation.prepare(target,revision,root,()=>eligible(sheet,row,column)&&isSelected(sheet,row,column)).then(ok=>{if(ok&&notify&&alive)setError(t('workbookBlankReady'))}).catch(()=>{if(notify&&alive)setError(t('workbookCellUnmapped'))})
    return true
   }
   blankPort.current={allowed:(sheet,row,column)=>{startingBlank=null;if(!eligible(sheet,row,column))return false;const cell=preparation.prepared({sheetId:sheet,row,column},grid.chunkRevision(),grid.manifest.rootHash);if(!cell)return false;startingBlank={cell,revision:grid.chunkRevision()};return true},prepare:(sheet,row,column)=>prepareBlank(sheet,row,column,true)}
   editSubscriptions.push(univerAPI.addEvent(univerAPI.Event.SelectionChanged,event=>{if(event.workbook.getId()!==workbook.getId())return;preparation.clear();requestAnimationFrame(()=>{if(!alive)return;const range=workbook.getActiveRange();if(range&&range.getHeight()===1&&range.getWidth()===1)prepareBlank(workbook.getActiveSheet().getSheetId(),range.getRow(),range.getColumn(),false)})}))
   editSubscriptions.push(univerAPI.addEvent(univerAPI.Event.CellPointerUp,event=>{if(event.workbook.getId()!==workbook.getId())return;const sheet=event.worksheet.getSheetId(),row=event.row,column=event.column;requestAnimationFrame(()=>{if(alive)prepareBlank(sheet,row,column,false)})}))
   const navigationKey=(event:KeyboardEvent)=>{if(event.isComposing||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab','Enter'].includes(event.key)||!host.current?.contains(event.target as Node))return;requestAnimationFrame(()=>{if(!alive||workbook.isCellEditing())return;const range=workbook.getActiveRange();if(range&&range.getHeight()===1&&range.getWidth()===1)prepareBlank(workbook.getActiveSheet().getSheetId(),range.getRow(),range.getColumn(),false)})}
   window.addEventListener('keyup',navigationKey,true);editSubscriptions.push({dispose:()=>window.removeEventListener('keyup',navigationKey,true)})
   const deferred=new WorkbookDeferredRevisions()
   const applyRevision=(event:import('./api.ts').RevisionEvent)=>{
    texts.reconcile(event.nodes,event.revision);if(event.nodeHashes)texts.reconcileHashes(event.nodeHashes,event.revision)
    if(event.reset){refreshWorkbook();return false}
    let missing=false
    for(const node of event.nodes)if(!current.applyRemoteText(node.nodeId,node.text,node.nodeHash,event.revision))missing=true
    grid.manifest.revision=Math.max(grid.manifest.revision,event.revision)
    if(missing){refreshWorkbook();return false}return true
   }
   const flushDeferred=()=>{if(!alive||!deferred.pending||input.isActive()||blankInput.active||controller.workbookBuffer||controller.workbookBlankInput||workbook.isCellEditing())return;const batch=deferred.take();if(batch.reload){refreshWorkbook();return}for(const event of batch.events)if(!applyRevision(event))break}
   flushGridRevisions.current=flushDeferred
   const offInput=input.subscribeSettled(()=>{if(alive)setInputReviewVersion(value=>value+1);queueMicrotask(flushDeferred);requestAnimationFrame(()=>{if(alive){current.trimToVisibleWindow();flushDeferred();current.refreshDrafts()}})}),offController=controller.subscribe(()=>queueMicrotask(flushDeferred))
   unsubscribeDeferred=()=>{offInput();offController()}
   let editingCell:{sheet:ReturnType<typeof workbook.getActiveSheet>;row:number;column:number;label:string}|null=null,viewportFrame=0
   const updateEditingLocation=()=>{viewportFrame=0;if(!alive||!editingCell)return;const cell=editingCell,sheet=cell.sheet;if(workbook.getActiveSheet().getSheetId()!==sheet.getSheetId()){setOffscreenEdit(null);return}const main=sheet.getVisibleRange(),visible=main?[main]:[],freeze=sheet.getFreeze(),ranges=sheet.getVisibleRangesOfAllViewports(),keys=univerAPI.Enum.SHEET_VIEWPORT_KEY;if(ranges&&freeze){for(const key of [...(freeze.ySplit>0?[keys.VIEW_MAIN_TOP]:[]),...(freeze.xSplit>0?[keys.VIEW_MAIN_LEFT]:[]),...(freeze.xSplit>0&&freeze.ySplit>0?[keys.VIEW_MAIN_LEFT_TOP]:[])]){const range=ranges.get(key);if(range)visible.push(range)}}if(!visible.length)return;setOffscreenEdit(visible.some(range=>cell.row>=range.startRow&&cell.row<=range.endRow&&cell.column>=range.startColumn&&cell.column<=range.endColumn)?null:cell.label)}
   editSubscriptions.push(univerAPI.addEvent(univerAPI.Event.Scroll,event=>{if(event.workbook.getId()!==workbook.getId()||!editingCell||event.worksheet.getSheetId()!==editingCell.sheet.getSheetId())return;if(viewportFrame)cancelAnimationFrame(viewportFrame);viewportFrame=requestAnimationFrame(updateEditingLocation)}))
   editSubscriptions.push(univerAPI.addEvent(univerAPI.Event.SheetEditStarted,event=>{const sheetId=event.worksheet.getSheetId(),link=current.getNodeAt(sheetId,event.row,event.column);if(link)input.start(link,grid.manifest.revision,event.worksheet.getSheetName());else{const permit=startingBlank;startingBlank=null;const cell=permit?.cell;if(cell&&cell.sheetId===sheetId&&cell.row===event.row&&cell.column===event.column){setError('');blankInput.start({documentId:session.documentId,baseRevision:permit.revision,sourceSha256:binding.sourceHash,cell:{sheetId:cell.sheetId,sheetPart:cell.sheetPart,sheetName:cell.sheetName,row:cell.row+1,column:cell.column+1,nodeId:cell.nodeId,text:''}})}}editingCell={sheet:event.worksheet,row:event.row,column:event.column,label:link?current.cellLabel(link.nodeId)??`${event.row+1}`:workbookCellAddress(event.row,event.column)};returnToEdit.current=()=>{if(editingCell)editingCell.sheet.scrollToCell(editingCell.row,editingCell.column)};setOffscreenEdit(null)}))
   editSubscriptions.push(univerAPI.addEvent(univerAPI.Event.SheetEditChanging,event=>{const sheetId=event.worksheet.getSheetId(),link=current.getNodeAt(sheetId,event.row,event.column),stream=event.value.getData().body?.dataStream;if(typeof stream==='string'){if(link)input.change(link.nodeId,stream);else blankInput.change(sheetId,event.row,event.column,stream)}}))
   editSubscriptions.push(univerAPI.addEvent(univerAPI.Event.SheetEditEnded,event=>{editingCell=null;returnToEdit.current=null;setOffscreenEdit(null);if(viewportFrame)cancelAnimationFrame(viewportFrame);const link=current.getNodeAt(event.worksheet.getSheetId(),event.row,event.column);if(link)input.end(link.nodeId,event.isConfirm);else blankInput.end(event.isConfirm);requestAnimationFrame(()=>{if(alive){current.trimToVisibleWindow();flushDeferred();current.refreshDrafts()}})}))
   adapter.current=current;await current.start()
   if(!alive)return
   if(pendingViewport.current){
    const viewport=pendingViewport.current
    if(univerAPI.getCurrentLifecycleStage()<univerAPI.Enum.LifecycleStages.Rendered)await new Promise<void>((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);subscription.dispose();stop.signal.removeEventListener('abort',abort)},done=()=>{cleanup();resolve()},abort=()=>{cleanup();reject(stop.signal.reason)},subscription=univerAPI.addEvent(univerAPI.Event.LifeCycleChanged,event=>{if(event.stage>=univerAPI.Enum.LifecycleStages.Rendered)done()}),timer=setTimeout(()=>{cleanup();reject(new Error('workbook render timeout'))},30_000);stop.signal.addEventListener('abort',abort,{once:true});if(stop.signal.aborted)abort();else if(univerAPI.getCurrentLifecycleStage()>=univerAPI.Enum.LifecycleStages.Rendered)done()})
    if(!alive)return
    restoreWorkbookViewport(workbook,viewport);pendingViewport.current=null
    await current.retryVisible()
    if(!alive)return
   }
   const openedRevision=grid.manifest.revision
   revised(grid.manifest.revision);inputStopping.current=false;setInputStopState('idle');gridReady.current=true;setReady(true);publishViewport()
   void watchRevisions(session,stop.signal,event=>{
    if(!alive)return
    preparation.clear()
    const own=ownRevisions.isOwn(event,controller.state().attempt?.id)
    if(event.revision<(revisionRef.current??0)){if(workbookLatePeerNeedsReload(event,revisionRef.current??0,openedRevision,own)){deferred.push({...event,reset:true});queueMicrotask(flushDeferred)}return}
    revised(event.revision)
    if(own)return
    texts.reconcile(event.nodes,event.revision);if(event.nodeHashes)texts.reconcileHashes(event.nodeHashes,event.revision)
    // Tracked-draft snapshots can describe the revision this grid already
    // loaded; rebuilding it would repeatedly replay the same snapshot.
    if(event.revision<=grid.chunkRevision())return
    if(workbook.isCellEditing()||input.isActive()||blankInput.active||controller.workbookBuffer||controller.workbookBlankInput||deferred.pending){deferred.push(event);queueMicrotask(flushDeferred);return}
    applyRevision(event)
   },status=>{if(alive)setUpdates(status)},{afterRevision:grid.manifest.revision,tracking:{snapshot:()=>texts.entries().map(([id])=>id),subscribe:texts.subscribe}})
  })().catch(cause=>{if(alive)setBootProblem(classifyDocumentProblem(cause,'content'))})
  return()=>{alive=false;gridReady.current=false;blankPort.current=null;blankInput.abandon();returnToEdit.current=null;setOffscreenEdit(null);unsubscribeDeferred?.();stop.abort();for(const subscription of editSubscriptions.splice(0))subscription.dispose();if(client.current===grid)client.current=null;adapter.current?.dispose();adapter.current=null;finishEditing.current=null;cancelEditing.current=null;flushGridRevisions.current=null;isEditing.current=()=>false;input.abandon();grid.dispose();const oldDispose=dispose;if(oldDispose)queueMicrotask(oldDispose)}
 },[session,locale,generation,port,input,blankInput,controller,texts,revised,binding.sourceHash,t,ownRevisions])
 async function beforeExport(){
  if(inputStopping.current||blankSaving.current||controller.workbookBlankInput||controller.workbookBlankAttempt)throw new Error(t('workbookInputPending'))
  if(session.scope==='write'&&(!imageTasks||await imageTasks.checkPending()))throw new Error(t('imageUploadPending'))
  if(finishEditing.current&&!await finishEditing.current())throw new Error(t('draftsNotReady'))
  if(controller.busy||controller.history.busy)throw new Error(t('saveDraftsFirst'))
  if(controller.pending||texts.size||controller.workbookBuffer)try{await save(true)}catch(cause){throw new Error(saveProblem(cause))}
  try{await controller.flush()}catch{throw new Error(t('localDraftUnavailable'))}
  if(session.scope==='write'&&(!imageTasks||await imageTasks.checkPending()))throw new Error(t('saveDraftsFirst'))
  if(workbookLeaveBlocked())throw new Error(t(workbookInputInProgress()?'workbookFinishEditingFirst':'saveDraftsFirst'))
  return revisionRef.current
 }
 function workbookInputInProgress(){return isEditing.current()||input.isActive()||inputStopping.current}
 function workbookLeaveBlocked(){return !mounted.current||batchPending()||workbookInputInProgress()||!!texts.size||!!controller.workbookBuffer||!!controller.workbookBlankInput||!!controller.workbookBlankAttempt||blankSaving.current||controller.pending||controller.busy||controller.history.busy}
 async function beforeWorkbookDownload(revision:number,signal:AbortSignal){
  try{await verifyWorkbookDownload(revision,()=>revisionRef.current,()=>workbookLeaveBlocked()||session.scope==='write'&&(!imageTasks||imageTasks.pending),async()=>session.scope==='write'&&(!imageTasks||await imageTasks.checkPending()),()=>workbookServerHead(session,binding.sourceHash,signal))}
  catch{throw new Error(t('workbookExportChanged'))}
 }
 async function close(){
  if(finishEditing.current&&!await finishEditing.current()){setError(t('draftsNotReady'));return}
  const finish=async()=>{const result=await closeFixedIfSettled(workbookLeaveBlocked,()=>controller.flush(),onClose);if(result!=='closed'&&mounted.current){if(result==='flush-failed')setCloseBackupFailed(true);setError(t(result==='flush-failed'?'localDraftUnavailable':workbookInputInProgress()?'workbookFinishEditingFirst':'saveDraftsFirst'))}}
  try{await batchGuard(async()=>{if(session.scope==='write'){if(!imageTasks)throw new Error('imageUploadPending');await imageTasks.withClear(finish)}else await finish()})}
  catch(cause){setError(t(cause instanceof Error&&cause.message.startsWith('blank batch')?'workbookBatchBlocked':'imageUploadPending'))}
 }
  const rescue=()=>{if(workbookInputInProgress()||blankInput.active){setError(t('workbookBackupFinishInput'));return false}downloadFixedDraft(session,controller.state(),binding.sourceHash);return true}
 async function changeHistory(direction:'undo'|'redo'){
  if(!ready||batchPending()||inputStopping.current||preparing||accessState!=='write'||controller.busy||controller.pending||controller.history.busy)return
  try{const result=await controller.history.step(direction);if(mounted.current){revised(result.revision);adapter.current?.refreshDrafts();setError('')}}catch(cause){if(mounted.current)setError(saveProblem(cause))}
 }
 function resolveCell(id:string,keepLocal:boolean){
  const draft=texts.get(id);if(!draft||controller.workbookBuffer?.base.nodeId===id||controller.pending||controller.busy||accessState!=='write')return
  if(draft.remote)texts.resolve(draft.remote,revisionRef.current??draft.revision,keepLocal)
  else if(!keepLocal)texts.discard(id)
  setError('')
 }
 // Toggling inert on a reused Univer host can leave its recreated hidden
 // input without a working keyboard context. Retain the interaction gate.
 const gridBlocked=!ready||!!bootProblem||protectedSave||inputStopState!=='idle'||session.scope==='write'&&accessState!=='write'
 const blockGridInput=()=>!gridReady.current||!!bootProblem||protectedPaintBlocked.current||inputStopping.current||session.scope==='write'&&access.snapshot()!=='write'
 const hasCellConflict=texts.entries().some(([,draft])=>!!draft.remote||!!draft.stale)
 const batchUnknown=!!batch?.entries.some(entry=>!!entry.state.attempt)
 const unknownSave=controller.pending||!!controller.workbookBlankAttempt||batchUnknown
 const batchUnavailable=session.scope==='write'&&!!session.userId&&!!batch?.problem
 const batchLoading=session.scope==='write'&&!!session.userId&&(!batch||batch.loading)
 const saveState:MessageKey=controller.busy?'saving':unknownSave?'fixedRetrySave':batchUnavailable?'localDraftUnavailable':batchLoading?'loadingWorkbook':texts.size||controller.workbookBuffer||controller.workbookBlankInput||batch?.working||batch?.transient||batch?.entries.length?'editing':'saved'
 const canSave=ready&&!(batchPending()&&(!(controller.pending||controller.workbookBlankAttempt)||!batch||batch.loading||batch.problem||batch.working||!!batch.transient))&&inputStopState==='idle'&&!preparing&&!controller.busy&&!(controller.workbookBuffer&&!input.isActive())&&!(session.scope==='write'&&(!imageTasks||imageTasks.pending))&&(accessState==='write'||controller.pending)&&!(!unknownSave&&hasCellConflict)
 const canHistory=ready&&!batchPending()&&!inputStopping.current&&!preparing&&accessState==='write'&&!controller.busy&&!controller.pending&&!controller.history.busy&&!isEditing.current()
 const commands=useCommands(instanceId=>({instanceId,documentId:session.documentId,format:session.format,profile:'sheet',locale,platform:/Mac|iPhone|iPad/.test(navigator.platform)?'mac':'other',ready,readOnly:accessState!=='write',historical:false,revision,
  selection:{kind:'none',empty:true,anchor:null,protected:false,parentTypes:[]},capabilities:{text:false,blocks:false,images:false,customNodes:false,mentions:false,ai:false},
  actions:{'file.save':{enabled:!!canSave},'file.export':{enabled:ready&&revision!==null},'edit.undo':{enabled:canHistory&&controller.history.canUndo},'edit.redo':{enabled:canHistory&&controller.history.canRedo},'editor.palette':{enabled:true,active:paletteOpen},'view.collaboration':{enabled:accessState!=='revoked',active:collaborationOpen},'view.panel.close':{enabled:collaborationOpen}}
 }),async(id,input,signal)=>{
  signal.throwIfAborted()
  if(id==='file.save'){try{return await (controller.workbookBlankInput||controller.workbookBlankAttempt?saveBlank():save())}catch(cause){failed(cause);throw cause}}
  if(id==='edit.undo'||id==='edit.redo')return changeHistory(id==='edit.undo'?'undo':'redo')
  if(id==='editor.palette'){setPaletteOpen(value=>!value);return true}
  if(id==='view.collaboration'){setCollaborationOpen(value=>toggleInput(id,input,value));return true}
  if(id==='view.panel.close'){setCollaborationOpen(false);return true}
  if(id==='file.export'){exportControls.current?.scrollIntoView({block:'nearest'});(exportControls.current?.querySelector<HTMLElement>('select:not(:disabled),button:not(:disabled)')??exportControls.current)?.focus();return true}
  return false
 },cause=>{const key=commandMessage(cause);setError(key?t(key):saveProblem(cause))})
 return <div ref={workspace} className={`workspace hcd-univer-workspace ${embedded?'embedded':''}`}>
  <header className="workbook-header"><div className="presentation-document"><span className="presentation-file-icon workbook-file-icon" aria-hidden="true">X</span><div><h1 title={session.documentId}>{session.documentId}</h1><span className="presentation-save-state" role="status" title={unknownSave?t('fixedSaveUnknown'):undefined}>{revision===null?t('loadingWorkbook'):<>{t(saveState)} <small>· r{revision}</small></>}</span></div></div><div className="header-actions"><FixedPresenceIndicator peers={collaboration.peers} connected={collaboration.connected} inactive={accessState==='revoked'} open={collaborationOpen} onOpen={()=>setCollaborationOpen(value=>!value)}/><LocaleSelect/>{allowClose&&<button className="ghost" onClick={()=>void close()}>{t('close')}</button>}</div></header>
  <nav className="viewer-controls workbook-file-actions" aria-label={t('document')}>
   <CommandAction registry={commands.registry} run={commands.run} id="file.save">{t(controller.pending||controller.workbookBlankAttempt?'fixedRetrySave':'saveAllText')}</CommandAction>
   <CommandAction registry={commands.registry} run={commands.run} id="edit.undo"/><CommandAction registry={commands.registry} run={commands.run} id="edit.redo"/>
   <CommandRibbon registry={commands.registry} run={commands.run} tab="home" customOnly/>
   <span ref={exportControls} className="workbook-export-controls" tabIndex={-1} aria-label={t('export')}><ExportControl session={session} revision={ready?revision:null} runExport={async work=>{try{await batchGuard(work)}catch(error){if(error instanceof Error&&error.message.startsWith('blank batch'))throw new Error(t('workbookBatchBlocked'));throw error}}} beforeExport={beforeExport} beforeDownload={beforeWorkbookDownload} refreshKey={sourceGeneration}/></span>
   <button onClick={()=>void auditFormulas()} disabled={!ready||revision===null||auditing||restoringSource}>{t(auditing?'workbookAuditWorking':'workbookAudit')}</button>
   {auditResult?.key==='workbookAuditPassed'&&auditResult.revision===revision&&accessState==='write'&&<button onClick={()=>void enableSourceFreeProtection()} disabled={auditing}>{t('workbookProofEnable')}</button>}
   {accessState==='write'&&(auditResult?.key==='workbookAuditMissing'||auditResult?.key==='workbookSourceChanged'||auditResult?.key==='workbookSourceRestoreConflict'||auditResult?.key==='workbookSourceRestoreFailed'||sourceNeeded)&&<><button onClick={()=>sourceFile.current?.click()} disabled={restoringSource}>{t('workbookSourceRestore')}</button><input ref={sourceFile} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void restoreSource(file)}}/></>}
   {restoringSource&&<button type="button" onClick={()=>sourceRestore.current?.abort(new Error('source-restore-wait-stopped'))}>{t('exportStopWaiting')}</button>}
   <span>{t(accessState==='write'?'cellEdits':'readOnly')} · {t(updates==='connected'?'connected':'revisionConnectionUnavailable')}</span>
  </nav>
  {paletteOpen&&<CommandPalette registry={commands.registry} run={commands.run} onClose={()=>setPaletteOpen(false)}/>}
  {protectedSheets&&<p className="local-draft-warning" role="status">{t('workbookProtectedSheets')}</p>}
  {blankMappingLimit&&<p className="local-draft-warning" role="status">{t('workbookBlankMappingLimit')}</p>}
  {visibleLoadFailed&&<p className="local-draft-warning" role="alert">{t('workbookVisibleLoadFailed')} <button type="button" onClick={()=>void adapter.current?.retryVisible()}>{t('workbookRetryVisibleLoad')}</button></p>}
  {auditResult&&!(auditResult.key==='workbookSourceRestored'&&auditResult.revision!==revision)&&<p className="local-draft-status" role="status">{t(auditResult.revision===revision||auditResult.key==='workbookProofEnabled'||auditResult.key.startsWith('workbookSource')?auditResult.key:'workbookAuditStale',{revision:auditResult.revision,count:auditResult.count??0})}</p>}
  {offscreenEdit&&<div className="workbook-offscreen-edit" role="status">{t('workbookOffscreenEdit',{cell:offscreenEdit})} <button type="button" aria-keyshortcuts="Alt+Shift+R" onMouseDown={event=>event.preventDefault()} onClick={()=>returnToEdit.current?.()}>{t('workbookReturnToEdit')}</button> <span>{t('workbookReturnToEditShortcut')}</span></div>}
  {batch?.problem&&<p className="local-draft-warning" role="alert">{t('localDraftUnavailable')} <button type="button" disabled={batch.working||batch.loading} onClick={()=>void batch.retryStorage()}>{t('localDraftRetry')}</button></p>}
  {batch&&<WorkbookBlankBatchPanel client={batch} sheetName={id=>workbookRef.current?.getSheetBySheetId(id)?.getSheetName()} onLoadFull={async(item,at,signal)=>(await readMappedBatchCell({session,source:binding.sourceHash,revision:at,reviewed:item,signal:AbortSignal.any([signal,lifetime.current.signal,AbortSignal.timeout(30_000)]),guard:()=>mounted.current})).text} onCopy={async(item,at,signal,full)=>{
   const combined=AbortSignal.any([signal,lifetime.current.signal,AbortSignal.timeout(30_000)])
   const readyToCopy=()=>mounted.current&&access.snapshot()==='write'&&!controller.pending&&!controller.busy&&!controller.history.busy&&!controller.workbookBuffer&&!controller.workbookBlankInput&&!controller.workbookBlankAttempt&&!isEditing.current()&&!withoutBackup&&!!journal&&journal.state!=='failed'
   await access.refresh();await copyMappedBatchCell({session,source:binding.sourceHash,revision:at,reviewed:item,reviewedFull:full,signal:combined,guard:readyToCopy,stage:async(run,revision,text)=>{
    await stageMappedBatchDraft({texts,run,revision,text,signal:combined,guard:readyToCopy,flush:()=>journal!.flush()})
   }})
  }} onSaved={next=>{revised(next);pendingViewport.current=workbookRef.current?captureWorkbookViewport(workbookRef.current):null;gridReady.current=false;setReady(false);setGeneration(value=>value+1);setError('')}}/>}
  <div ref={host} className="hcd-univer-host" aria-busy={!ready} aria-disabled={gridBlocked} style={{pointerEvents:gridBlocked?'none':undefined}} onPointerDownCapture={()=>setFollowing(null)} onWheelCapture={()=>setFollowing(null)} onFocusCapture={event=>{if(blockGridInput()) (event.target as HTMLElement).blur()}} onKeyDownCapture={event=>{setFollowing(null);if(blockGridInput()){event.preventDefault();event.stopPropagation()}}} onPasteCapture={event=>{if(blockGridInput()){event.preventDefault();event.stopPropagation()}}}/>
  {collaborationOpen&&<aside className="workbook-collaboration" aria-label={t('onlineCollaborators')}><section className="collaboration-panel"><div className="panel-head"><h2>{t('collaborationPanelTitle')}</h2><button type="button" className="panel-close" aria-label={t('hidePanel')} onClick={()=>setCollaborationOpen(false)}>×</button></div><ul className="collaboration-members">{collaboration.peers.map(peer=>{const own=peer.id===collaboration.localId,active=peer.clientId===following,location=peer.workbook,sheet=location&&workbookRef.current?.getSheetBySheetId(location.sheetId),selected=location?.selection&&workbookCellAddress(location.selection.row,location.selection.column),visible=location&&workbookCellAddress(location.row,location.column);return <li key={peer.clientId}><div className="collaboration-member-name"><i style={{background:peer.color}}>{Array.from(peer.name)[0]||'•'}</i><strong>{peer.name}{own?` ${t('you')}`:''}</strong></div><small>{location&&sheet?`${sheet.getSheetName()}${selected?` · ${selected}`:''} · ${t('view')} ${visible}`:t('collaboratorLocationPending')}</small>{!own&&<div className="collaboration-member-actions"><button disabled={!canLocate(peer)} onClick={()=>{setFollowing(null);locate(peer)}}>{t('locateCollaborator')}</button><button aria-pressed={active} disabled={!active&&(!canLocate(peer)||collaboration.clientId===null||workbookFollowCycle(collaboration.peers,collaboration.clientId,peer.clientId))} onClick={()=>{if(active)setFollowing(null);else if(locate(peer))setFollowing(peer.clientId)}}>{t(active?'stopFollowing':'followCollaboratorAction')}</button></div>}</li>})}</ul>{!collaboration.connected&&<p role="status">{t('collaborationConnecting')}</p>}</section></aside>}
  {bootProblem&&<DocumentProblemView problem={bootProblem} documentId={session.documentId} onRetry={()=>setGeneration(value=>value+1)} secondary={{label:t('downloadDraft'),run:rescue}}/>}
  {inputStopState==='failed'&&!controller.workbookBuffer&&<p className="local-draft-warning" role="alert">{t('workbookInputStopFailed')}</p>}
  {controller.workbookBlankInput&&!blankInput.active&&<section className="workbook-conflicts" role="status"><p>{t('workbookInputUnfinished')}</p><p>{t('workbookInputLocation',{location:`${controller.workbookBlankInput.cell.sheetName??controller.workbookBlankInput.cell.sheetId}!${workbookCellAddress(controller.workbookBlankInput.cell.row-1,controller.workbookBlankInput.cell.column-1)}`})}</p><p>{controller.workbookBlankInput.cell.text}</p>{controller.workbookBlankAttempt&&<p>{t('fixedSaveUnknown')}</p>}{blankConflict&&blankConflict.input===controller.workbookBlankInput&&<><p>{t('localDraftServer')} · r{blankConflict.comparison.revision}: {blankConflict.comparison.run.text}</p>{blankConflict.comparison.editable&&<button disabled={preparing||controller.busy||controller.pending||accessState!=='write'||!!texts.get(blankConflict.comparison.run.nodeId)} onClick={()=>{if(controller.workbookBlankInput!==blankConflict.input||controller.workbookBlankAttempt)return;texts.edit(blankConflict.comparison.run,blankConflict.comparison.revision,blankConflict.input.cell.text);controller.setWorkbookBlankInput(null);blankInput.release();revised(blankConflict.comparison.revision);setBlankConflict(null);pendingViewport.current=workbookRef.current?captureWorkbookViewport(workbookRef.current):null;gridReady.current=false;setReady(false);setGeneration(value=>value+1)}}>{t('workbookKeepLocalCell')}</button>}</>}<button disabled={!ready||batchLoading||batchUnavailable||preparing||controller.busy||accessState!=='write'} onClick={()=>void saveBlank()}>{t('workbookBlankSave')}</button><button disabled={preparing||controller.busy||!!controller.workbookBlankAttempt} onClick={()=>setDiscardBlank(controller.workbookBlankInput)}>{t('workbookInputDiscard')}</button>{discardBlank&&discardBlank===controller.workbookBlankInput&&<div><p>{t('workbookInputDiscardConfirm')}</p><button disabled={preparing||!!controller.workbookBlankAttempt} onClick={()=>{if(controller.workbookBlankInput===discardBlank){controller.setWorkbookBlankInput(null);blankInput.release();setBlankConflict(null);setGeneration(value=>value+1)}setDiscardBlank(null)}}>{t('fixedPortableDiscardConfirm')}</button> <button onClick={()=>setDiscardBlank(null)}>{t('cancel')}</button></div>}</section>}
  {controller.workbookBuffer&&!input.isActive()&&<section className="workbook-conflicts" role="status"><p>{t(inputStopState==='failed'?'workbookInputStopFailed':inputStopState==='stopping'?'workbookInputStopping':'workbookInputInterrupted')}</p><p>{t('workbookInputRecoveryHint')}</p><p>{t('workbookInputLocation',{location:workbookInputLocation(controller.workbookBuffer)})}</p><p>{controller.workbookBuffer.text}</p>{controller.pending&&<button type="button" disabled={!ready||preparing||controller.busy} onClick={()=>void checkOriginalReceipt()}>{t('workbookReceiptCheck')}</button>}{receiptNotice&&<p role="status">{typeof receiptNotice==='object'?t('workbookReceiptConfirmed',{revision:receiptNotice.revision}):t(receiptNotice==='missing'?'workbookReceiptMissing':'workbookReceiptUnavailable')}</p>}{workbookInputDiverged(texts,controller.workbookBuffer)&&<><p>{t('workbookInputDifferentDraft')}</p><p>{texts.get(controller.workbookBuffer.base.nodeId)?.text}</p></>}<button disabled={inputStopState!=='idle'||accessState!=='write'||controller.busy} onClick={()=>{const buffer=controller.workbookBuffer;if(!buffer)return;const draft=texts.get(buffer.base.nodeId);if(draft&&workbookInputDiverged(texts,buffer)){setReplaceInput({buffer,draft});setDiscardInput(null);return}restoreWorkbookInput(texts,buffer);controller.setWorkbookBuffer(null);setDiscardInput(null)}}>{t('workbookInputRestore')}</button><button disabled={inputStopState!=='idle'||controller.busy} onClick={()=>{setReplaceInput(null);setDiscardInput(controller.workbookBuffer)}}>{t('workbookInputDiscard')}</button>{replaceInput&&replaceInput.buffer===controller.workbookBuffer&&replaceInput.draft===texts.get(replaceInput.buffer.base.nodeId)&&<div><p>{t('workbookInputReplaceConfirm')}</p><button disabled={inputStopState!=='idle'||accessState!=='write'||controller.busy} onClick={()=>{if(controller.workbookBuffer===replaceInput.buffer&&texts.get(replaceInput.buffer.base.nodeId)===replaceInput.draft){restoreWorkbookInput(texts,replaceInput.buffer);controller.setWorkbookBuffer(null)}setReplaceInput(null)}}>{t('workbookInputReplace')}</button> <button onClick={()=>setReplaceInput(null)}>{t('cancel')}</button></div>}{discardInput&&discardInput===controller.workbookBuffer&&<div><p>{t('workbookInputDiscardConfirm')}</p><button disabled={inputStopState!=='idle'||controller.busy} onClick={()=>{if(controller.workbookBuffer===discardInput)controller.setWorkbookBuffer(null);setDiscardInput(null)}}>{t('fixedPortableDiscardConfirm')}</button> <button onClick={()=>setDiscardInput(null)}>{t('cancel')}</button></div>}</section>}
  {!!texts.entries().filter(([,draft])=>draft.remote||draft.stale).length&&<section className="workbook-conflicts" aria-label={t('workbookDraftConflicts')}><h3>{t('workbookDraftConflicts')}</h3>{texts.entries().filter(([,draft])=>draft.remote||draft.stale).map(([id,draft])=><div key={id}><strong>{adapter.current?.cellLabel(id)??t('workbookChangedCell')}</strong><p>{t('localDraftDevice')}: {draft.text}</p><p>{t('localDraftServer')}: {draft.remote?.text??t('localDraftWaitingNetwork')}</p>{controller.workbookBuffer?.base.nodeId===id&&<p>{t('workbookInputResolveFirst')}</p>}<button disabled={controller.workbookBuffer?.base.nodeId===id||!draft.remote||controller.pending||controller.busy||accessState!=='write'} onClick={()=>resolveCell(id,true)}>{t('workbookKeepLocalCell')}</button><button disabled={controller.workbookBuffer?.base.nodeId===id||controller.pending||controller.busy||accessState!=='write'} onClick={()=>resolveCell(id,false)}>{t('workbookKeepServerCell')}</button></div>)}</section>}
  {protectedSave&&texts.size>0&&<section className="workbook-conflicts" aria-label={t('workbookProtectedDraftTitle')}><h3>{t('workbookProtectedDraftTitle')}</h3><p>{t('workbookProtectedDraftHint')}</p>{texts.entries().map(([id,draft])=><div key={id}><strong>{adapter.current?.cellLabel(id)??id}</strong><p>{draft.text}</p><button disabled={controller.pending||controller.busy||accessState!=='write'||controller.workbookBuffer?.base.nodeId===id} onClick={()=>setDiscardProtectedDraft({id,draft})}>{t('discardDraftText')}</button>{discardProtectedDraft?.id===id&&discardProtectedDraft.draft===draft&&<div><p>{t('workbookProtectedDraftDiscardConfirm')}</p><button disabled={controller.pending||controller.busy||accessState!=='write'} onClick={()=>{if(texts.get(id)===draft){texts.discard(id);if(!texts.size){protectedPaintBlocked.current=false;setProtectedSave(false);adapter.current?.refreshDrafts()}setError('')}setDiscardProtectedDraft(null)}}>{t('fixedPortableDiscardConfirm')}</button> <button onClick={()=>setDiscardProtectedDraft(null)}>{t('cancel')}</button></div>}</div>)}</section>}
  {session.scope==='write'&&<><FixedImageTasksView tasks={imageTasks} reopen={()=>setTaskGeneration(value=>value+1)}/><FixedPortablePanel session={session} sourceHash={binding.sourceHash} save={controller} tasks={imageTasks}/><div className={withoutBackup||backup==='failed'||closeBackupFailed?'local-draft-warning':'local-draft-status'} role={backup==='failed'||closeBackupFailed?'alert':'status'}>{t(withoutBackup||backup==='failed'||closeBackupFailed?'localDraftUnavailable':backup==='writing'?'localDraftWriting':'localDraftStored')} <FixedDraftDownload download={rescue}/>{binding.importBackup&&<FixedDraftImport importBackup={binding.importBackup} />}{batch&&binding.importBackup&&<WorkbookCombinedBackup session={session} source={binding.sourceHash} batch={batch} fixed={()=>{if(workbookInputInProgress()||blankInput.active)throw Error('workbook-backup-input-active');return controller.state()}} importFixed={binding.importBackup}/>}{journal&&(backup==='failed'||closeBackupFailed)&&!withoutBackup&&<><button disabled={controller.busy||preparing} onClick={()=>void journal.write(controller.state()).then(()=>{if(mounted.current){setCloseBackupFailed(false);setError('')}}).catch(()=>{})}>{t('localDraftRetry')}</button><button disabled={controller.busy||preparing} onClick={()=>{controller.continueWithoutBackup();setWithoutBackup(true);setCloseBackupFailed(false)}}>{t('localDraftContinueWithout')}</button></>}{!!binding.copies.length&&<details><summary>{t('localDraftCopies')} ({binding.copies.length})</summary>{binding.copies.map(copy=><button key={copy.id} onClick={()=>downloadFixedDraft(session,copy.state,binding.sourceHash)}>{new Date(copy.updatedAt).toLocaleString(locale)} · {t('downloadDraft')}</button>)}</details>}</div></>}
  {accessState==='revoked'&&<p className="local-draft-warning" role="alert">{t('accessRevoked')}</p>}
  {error&&<p className="local-draft-warning" role="alert">{error}</p>}
 </div>
}
