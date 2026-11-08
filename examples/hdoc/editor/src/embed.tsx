export {createHttpAiProvider} from './ai/http.ts'
export type {HttpAiProviderOptions} from './ai/http.ts'
export {AiSuggestionController,AiError} from './ai/core.ts'
import type {AiExtensions} from './ai/types.ts'
export type {AiAutocompleteOptions,AiExtensions,AiProvider,AiRequest,AiEvent,AiAction,AiContext,AiSnapshot,AiAdapter,AiAccepted,AiLimits,AiErrorCode} from './ai/types.ts'
import type {NodeExtensions} from './extensionTypes.ts'
export type {NodeExtensions,NodeExtensionDefinition,NodeExtensionService,NodeProperty,ExtensionNodePayload,ExtensionViewContext,NodeConflictChoice,NodeEditInfo,NodeMigrationStep,NodeMigrationPreview,NodeResource,NodeExportFormat,NodeExportSnapshot,NodeExportBlock,NodeExportRun} from './extensionTypes.ts'
import { useEffect, useRef, useState } from 'react'
import { Workspace } from './App.tsx'
import type { Session } from './api.ts'
import { I18nProvider, useI18n, type EditorLocale } from './i18n.tsx'
import type {CommandExtensions} from './commands/types.ts'
import type {InlineContainerExtensions} from './inlineContainerRegistry.ts'
export type {CommandExtensions,EditorCommand,EditorCommandService,CommandContext,CommandItem,CommandSurface,CommandInvocation,CommandLabel,CommandMenuOverride,EditorProfile} from './commands/types.ts'
import './style.css'
import {readDocumentSession,WordCompatibilityError} from './documentSession.ts'
import {WordCompatibilityProblem} from './WordCompatibilityProblem.tsx'
import {DocumentLoading,DocumentProblemView} from './DocumentProblem.tsx'
import {classifyDocumentProblem,EditorDocumentError,type DocumentProblem} from './documentProblems.ts'

export type EmbeddedHcdEditorProps = {
  documentId: string
  token: string
  apiUrl: string
  collabUrl: string
  locale?: string
  onLocaleChange?: (locale: EditorLocale) => void
  commandExtensions?: CommandExtensions
  nodeExtensions?: NodeExtensions
  inlineContainerExtensions?: InlineContainerExtensions
  aiExtensions?: AiExtensions
  onClose?: () => void
  onError?: (error: Error) => void
}

/** Mount this component inside an existing React product without an iframe. */
export function EmbeddedHcdEditor(props: EmbeddedHcdEditorProps) {
  return <I18nProvider initialLocale={props.locale} onLocaleChange={props.onLocaleChange}>
    <EmbeddedContent {...props} />
  </I18nProvider>
}

function EmbeddedContent({ documentId, token, apiUrl, collabUrl, commandExtensions, nodeExtensions, inlineContainerExtensions, aiExtensions, onClose, onError }: EmbeddedHcdEditorProps) {
  const { locale } = useI18n()
  const errorCallback=useRef(onError);errorCallback.current=onError
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<DocumentProblem|null>(null)
  const [compatibility,setCompatibility]=useState<WordCompatibilityError|null>(null)
  const [retry,setRetry]=useState(0)
  useEffect(() => {
    let active = true
    const controller=new AbortController()
    setError(null);setSession(null);setCompatibility(null)
    readDocumentSession({documentId,token,apiUrl,collabUrl},controller.signal).then(next => {
      if (active) setSession(next)
    }).catch(cause => {
      if (active&&!controller.signal.aborted) { const problem=classifyDocumentProblem(cause);setError(problem);if(cause instanceof WordCompatibilityError)setCompatibility(cause);try{errorCallback.current?.(new EditorDocumentError(problem))}catch{/* Host reporting cannot hide the error screen. */} }
    })
    return () => { active = false;controller.abort() }
  }, [documentId, token, apiUrl, collabUrl,retry])
  return <div className="hcd-surface hcd-embedded" lang={locale}>
    {session&&session.documentId===documentId&&session.token===token&&session.apiUrl===apiUrl&&session.collabUrl===collabUrl ? <Workspace aiExtensions={aiExtensions} nodeExtensions={nodeExtensions} inlineContainerExtensions={inlineContainerExtensions} commandExtensions={commandExtensions} key={`${session.documentId}:${session.collaborationEpoch ?? 0}`} session={session} onClose={() => onClose?.()} allowClose={!!onClose} onError={onError} onEpochChange={epoch => setSession(previous => previous && ({ ...previous, collaborationEpoch: epoch }))} embedded /> : error?(compatibility&&compatibility.recoverySession.documentId===documentId&&compatibility.recoverySession.token===token&&compatibility.recoverySession.apiUrl===apiUrl&&compatibility.recoverySession.collabUrl===collabUrl?<WordCompatibilityProblem problem={error} session={compatibility.recoverySession} checkpointSession={compatibility.checkpointSession} onRetry={()=>setRetry(value=>value+1)} onClose={onClose}/>:<DocumentProblemView problem={error} documentId={documentId} onRetry={()=>setRetry(value=>value+1)} onClose={onClose}/>):<DocumentLoading documentId={documentId} onClose={onClose}/>}
  </div>
}
