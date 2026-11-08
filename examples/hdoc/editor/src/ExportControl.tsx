import { useEffect, useRef, useState } from 'react'
import { currentExportOptions, docxSourceAllowed, readExportOptions, wordNumericFieldsPreserved, type ScopedExportOptions, type ExportOptions } from './exportOptions.ts'
import { api, ApiError, type Session } from './api.ts'
import { useI18n, type MessageKey } from './i18n.tsx'
import {ExportCompatibility} from './ExportCompatibility.tsx'
import {readExportCapabilities,currentExportCapabilities,exportCapabilityBlocked,exportCapabilityDecision,exportCapabilitySignature,type ScopedExportCapabilities} from './exportCapabilities.ts'
import {readExportPreflight} from './exportPreflight.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'

const formats = ['docx', 'xlsx', 'pptx', 'pdf', 'html', 'md', 'txt', 'hcdz'] as const
const fidelityLabels:Record<string,MessageKey>={SEMANTIC:'exportSupportSemantic',VISUAL:'exportSupportStatic',NATIVE:'offlineArchiveResult',EXACT:'exportFidelityExact',HIGH:'exportFidelityHigh',MEDIUM:'exportFidelityMedium',LOW:'exportFidelityLow'}

export function ExportControl({ session, revision, beforeExport, beforeDownload, runExport, hint, refreshKey = 0 }: {
  session: Session
  revision: number | null
  beforeExport?: () => Promise<number | null>
  beforeDownload?: (revision:number,signal:AbortSignal) => Promise<void>
  runExport?: (operation:()=>Promise<void>)=>Promise<void>
  hint?: MessageKey
  /** Changes when the retained source changes without a document revision. */
  refreshKey?: number
}) {
  const { t } = useI18n()
  const sourceFormat = session.format === 'markdown' ? 'md' : session.format
  const [format, setFormat] = useState<string>(sourceFormat)
  const [preferSource, setPreferSource] = useState(true)
  const [busy, setBusy] = useState(false)
  const latestRefresh=useRef(refreshKey);latestRefresh.current=refreshKey
  const [stopping,setStopping]=useState(false)
  const request=useRef<AbortController|null>(null)
  const [error, setError] = useState('')
  const [optionsFailed,setOptionsFailed]=useState(false)
  const [optionsRetry,setOptionsRetry]=useState(0)
  const [options, setOptions] = useState<ScopedExportOptions | null>(null)
  const [capabilities,setCapabilities]=useState<ScopedExportCapabilities|null>(null)
  const [capabilityError,setCapabilityError]=useState(false)
  const [capabilityRetry,setCapabilityRetry]=useState(0)
  const [review,setReview]=useState<{revision:number;signature:string}|null>(null)
  const [result, setResult] = useState<{ revision: number; fidelity: string | null } | null>(null)
  useEffect(()=>{
    setBusy(false);setStopping(false);setResult(null);setError('');setOptions(null);setOptionsFailed(false);setCapabilities(null);setCapabilityError(false);setReview(null)
    return()=>{request.current?.abort('export-scope-changed');request.current=null}
  },[session.documentId,session.token,session.apiUrl])
  const sameFormat = format === sourceFormat
  const docx = sameFormat && sourceFormat === 'docx'
  const sourcePreflight = sameFormat && ['docx','pptx','xlsx','pdf'].includes(sourceFormat)
  const pdfPreflight=sourceFormat==='pdf'&&format!=='hcdz'
  const regionTextPreflight=session.flowLayoutVersion===2&&format==='txt'
  const currentOptions = currentExportOptions(options,revision,refreshKey)
  const rebuild = docx && currentOptions !== null && !docxSourceAllowed(currentOptions)
  const source = sameFormat && preferSource && !rebuild
  const pdfContentExport = sameFormat && sourceFormat === 'pdf' && !source
  useEffect(() => { setError('') }, [revision, format, preferSource])
  useEffect(()=>setReview(null),[format,preferSource])
  const currentCapabilities=currentExportCapabilities(capabilities,session.documentId,revision,session.token,session.apiUrl,refreshKey)
  const sourceBlocked=sourcePreflight&&source&&(!currentOptions||!docxSourceAllowed(currentOptions))
  const sourceReason=(value:ExportOptions):MessageKey=>!value.sourceAvailable?(value.semanticReasonCode==='PDF_UNPAINTED_TEXT'?'pdfUnpaintedExportBlocked':'sourceUnavailableExport'):value.reasonCode==='PDF_MULTILINE_SOURCE_UNSUPPORTED'?'pdfMultilineSourceUnsupported':value.reasonCode==='IMAGE_SOURCE_UNSUPPORTED'?'exportSourceImageUnsupported':value.reasonCode==='STYLE_SOURCE_UNSUPPORTED'?'exportSourceStyleUnsupported':value.reasonCode==='STRUCTURE_SOURCE_UNSUPPORTED'?'exportSourceStructureUnsupported':'sourceUnavailableExport'
  const wordHint:MessageKey=wordNumericFieldsPreserved(currentOptions)?'wordRegionNumericExportHint':'wordRegionExportHint'
  const pdfOverlayBlocked=pdfPreflight&&!source&&currentOptions?.semanticReasonCode==='PDF_UNPAINTED_TEXT'
  const blocked=sourceBlocked||pdfPreflight&&!currentOptions||regionTextPreflight&&!currentOptions?.semanticFormats?.includes('txt')||pdfOverlayBlocked||!currentCapabilities||exportCapabilityBlocked(currentCapabilities,format,source)
  useEffect(() => {
    if ((!sourcePreflight&&!pdfPreflight&&!regionTextPreflight) || revision === null) return
    const controller = new AbortController()
    setOptionsFailed(false)
    void readExportPreflight(signal=>api(session, `/export-options?revision=${revision}`, { signal }),controller.signal)
      .then(value => { if (!controller.signal.aborted) setOptions({value:readExportOptions(value, revision),refreshKey}) })
      .catch(cause => { if (!controller.signal.aborted) {setOptionsFailed(true);setError(cause instanceof ApiError?t('exportSourceCheckHttp',{code:String(cause.status)}):t('exportSourceCheckFailed'))} })
    return () => controller.abort()
  }, [sourcePreflight, pdfPreflight,regionTextPreflight, revision, session, refreshKey, optionsRetry])

  async function readCapabilities(at:number,signal?:AbortSignal){
    try{return readExportCapabilities(await readExportPreflight(inner=>api(session,`/export-capabilities?revision=${at}`,{signal:inner}),signal),session.documentId,at)}catch{throw new Error(t('exportCapabilitiesUnavailable'))}
  }
  useEffect(()=>{
    if(revision===null)return
    const controller=new AbortController();setCapabilityError(false)
    void readCapabilities(revision,controller.signal).then(value=>{if(!controller.signal.aborted)setCapabilities({value,token:session.token,apiUrl:session.apiUrl,refreshKey})}).catch(()=>{if(!controller.signal.aborted)setCapabilityError(true)})
    return()=>controller.abort()
  },[revision,session.documentId,session.token,session.apiUrl,refreshKey,capabilityRetry])

  async function download() {
    if(request.current)return
    const controller=new AbortController();request.current=controller
    const current=()=>request.current===controller&&!controller.signal.aborted
    let timer:ReturnType<typeof setTimeout>|undefined
    setBusy(true)
    setStopping(false)
    setError('')
    setResult(null)
    setReview(null)
    const previousSignature=currentCapabilities?exportCapabilitySignature(currentCapabilities,format,source):null
    let exportRequested = false
    let requestedSource = false
    let exportedReady = false
    try {
      const savedRevision = beforeExport ? await beforeExport() : revision
      // Stopping the download never interrupts an already-started save. Its
      // receipt/recovery still belongs to the regular save coordinator.
      controller.signal.throwIfAborted()
      if (savedRevision === null) throw new Error(t(beforeExport?'exportSaveRequired':'revisionUnavailable'))
      timer=setTimeout(()=>controller.abort('export-timeout'),310000)
      let useSource = source
      if (docx && preferSource) {
        const latest = readExportOptions(await readExportPreflight(signal=>api(session, `/export-options?revision=${savedRevision}`,{signal}),controller.signal), savedRevision)
        if(current()&&latestRefresh.current===refreshKey)setOptions({value:latest,refreshKey})
        useSource = preferSource && docxSourceAllowed(latest)
      } else if(sourcePreflight && preferSource) {
        const latest=readExportOptions(await readExportPreflight(signal=>api(session,`/export-options?revision=${savedRevision}`,{signal}),controller.signal),savedRevision)
        if(current()&&latestRefresh.current===refreshKey)setOptions({value:latest,refreshKey})
        if(!docxSourceAllowed(latest))throw new Error(t(sourceReason(latest)))
      }
      if(sourceFormat==='pdf'&&!useSource&&format!=='hcdz'){
        const latest=readExportOptions(await readExportPreflight(signal=>api(session,`/export-options?revision=${savedRevision}`,{signal}),controller.signal),savedRevision)
        if(current()&&latestRefresh.current===refreshKey)setOptions({value:latest,refreshKey})
        if(latest.semanticReasonCode==='PDF_UNPAINTED_TEXT')throw new Error(t('pdfUnpaintedExportBlocked'))
      }
      if(regionTextPreflight){const latest=readExportOptions(await readExportPreflight(signal=>api(session,`/export-options?revision=${savedRevision}`,{signal}),controller.signal),savedRevision);if(current()&&latestRefresh.current===refreshKey)setOptions({value:latest,refreshKey});if(!latest.semanticFormats?.includes('txt'))throw new Error(t('wordRegionTextUnavailable'))}
      requestedSource = useSource
      const info=await readCapabilities(savedRevision,controller.signal)
      if(!current())return
      if(latestRefresh.current===refreshKey)setCapabilities({value:info,token:session.token,apiUrl:session.apiUrl,refreshKey});setCapabilityError(false)
      const decision=exportCapabilityDecision(previousSignature,info,format,useSource)
      if(decision==='blocked')throw new Error(t('exportBusinessSourceUnsupported'))
      const signature=exportCapabilitySignature(info,format,useSource)
      if(decision==='review'){setReview({revision:savedRevision,signature});return}
      controller.signal.throwIfAborted()
      exportRequested = true
      const response = await api(session,
        `/export/${format}?revision=${savedRevision}${useSource ? '&source=true' : ''}`,{signal:controller.signal})
      const fidelity = response.headers.get('x-hcd-fidelity-level')
      const blob=await response.blob()
      if(!current())return
      exportedReady=true
      if(beforeDownload)await awaitRecoveryPreparation(()=>beforeDownload(savedRevision,controller.signal),controller.signal)
      if(!current())return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${session.documentId}-r${savedRevision}.${format}`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setResult({ revision: savedRevision, fidelity })
    } catch (cause) {
      if(request.current!==controller)return
      setError(controller.signal.aborted?t(controller.signal.reason==='export-timeout'?'exportTimeout':'exportWaitStopped'):cause instanceof ApiError&&cause.status===504?t('exportTimeout'):cause instanceof ApiError&&cause.status===429?t('exportServerBusy'):`${cause instanceof Error?cause.message:String(cause)}${requestedSource && exportRequested && !exportedReady ? t('sourceExportFallback') : ''}`)
    } finally { clearTimeout(timer);if(request.current===controller){request.current=null;setBusy(false);setStopping(false)} }
  }

  return <><div className="export-control">
    <label>{t('exportFormat')} <select disabled={busy} aria-label={t('exportFormat')} value={format} onChange={event => {setFormat(event.target.value);setResult(null)}}>
      {formats.filter(item=>!session.flowLayoutVersion||item==='docx'||item==='hcdz'||session.flowLayoutVersion===2&&['html','txt'].includes(item)).map(item => <option key={item} value={item}>{item==='hcdz'?t('offlineArchive'):item.toUpperCase()}</option>)}
    </select></label>
    {sameFormat && <label>{t('exportMode')} <select disabled={busy} aria-label={t('exportMode')} value={source ? 'source' : 'semantic'} onChange={event => {setPreferSource(event.target.value === 'source');setResult(null)}}>
      <option value="source" disabled={rebuild}>{t('preserveSource')}</option>
      <option value="semantic">{t(sourceFormat === 'pdf' || sourceFormat === 'docx' ? 'currentContent' : 'semanticRebuild')}</option>
    </select></label>}
    <button onClick={() => {if(runExport)void runExport(download).catch(()=>setError(t('imageUploadPending')));else void download()}} disabled={busy||blocked}>{busy ? t(stopping?'exportStopping':'exporting') : t('export')}</button>
    {regionTextPreflight&&currentOptions&&!currentOptions.semanticFormats?.includes('txt')&&<span role="status">{t('wordRegionTextUnavailable')}</span>}
    {busy&&<button type="button" disabled={stopping} onClick={()=>{setStopping(true);request.current?.abort('export-stop-waiting')}}>{t('exportStopWaiting')}</button>}
    {session.flowLayoutVersion&&format==='docx'&&!source&&!hint&&<span className="export-reference-hint">{t(wordHint)}</span>}
    {sameFormat && <span className="export-mode-hint" title={source ? t('sourceHint') : pdfContentExport ? t('pdfContentExportHint') : t('semanticHint')}>{source ? t('sourceLayout') : pdfContentExport ? t('currentContent') : t('repaginate')}</span>}
    {rebuild && <span className="export-mode-hint">{t(currentOptions?.sourceAvailable ? 'docxRebuildExport' : 'sourceUnavailableExport')}</span>}
    {(sourceBlocked||regionTextPreflight)&&!currentOptions&&!optionsFailed&&<span className="export-reference-hint" role="status">{t(regionTextPreflight?'exportCapabilitiesChecking':'exportSourceChecking')}</span>}
    {(sourcePreflight||pdfPreflight||regionTextPreflight)&&!currentOptions&&optionsFailed&&<button type="button" onClick={()=>{setError('');setOptionsRetry(value=>value+1)}}>{t('retry')}</button>}
    {sourceBlocked&&currentOptions&&<span className="export-reference-hint" role="status">{t(sourceReason(currentOptions))}</span>}
    {pdfOverlayBlocked&&<span className="export-reference-hint" role="status">{t('pdfUnpaintedExportBlocked')}</span>}
    {currentCapabilities&&<ExportCompatibility report={currentCapabilities} format={format} source={source}/>}
    {!currentCapabilities&&!capabilityError&&revision!==null&&<span className="export-reference-hint" role="status">{t('exportCapabilitiesChecking')}</span>}
    {capabilityError&&!currentCapabilities&&<><span className="export-reference-hint" role="status">{t('exportCapabilitiesUnavailable')}</span><button type="button" onClick={()=>setCapabilityRetry(value=>value+1)}>{t('retry')}</button></>}
    {review&&currentCapabilities&&review.revision===revision&&review.signature===exportCapabilitySignature(currentCapabilities,format,source)&&<span className="export-reference-hint" role="status">{t('exportCompatibilityReview')}</span>}
    {result && <span className="export-result" role="status">{t('exported', { revision: result.revision })}{result.fidelity&&(format==='hcdz'||fidelityLabels[result.fidelity]) ? ` · ${format==='hcdz'?t('offlineArchiveResult'):format === 'pdf' && result.fidelity === 'VISUAL' ? t('pdfVisualExportResult') : format === 'docx' && result.fidelity === 'SEMANTIC' ? t('docxCurrentExportResult') : t(fidelityLabels[result.fidelity])}` : ''}</span>}
    {error && <span className="export-error" role="status" title={error}>{error}</span>}
  </div>{format==='hcdz'?<p>{t('offlineArchiveHint')}</p>:session.flowLayoutVersion===2&&format==='html'?<p>{t('wordRegionHtmlExportHint')}</p>:session.flowLayoutVersion===2&&format==='txt'?<p className="export-critical-hint">{t('wordRegionTextExportHint')}</p>:hint&&<p className="export-document-hint">{t(hint==='wordRegionExportHint'&&format==='docx'&&!source?wordHint:hint)}</p>}</>
}
