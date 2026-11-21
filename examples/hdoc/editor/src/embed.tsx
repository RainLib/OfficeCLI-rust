import { AppearanceProvider, useAppearance, type Appearance } from './Appearance.tsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HcdEmbedSelection } from './public'
import { EmbedPreparation, type PreparationListener } from './WorkflowWorkspace'
import { EmbedSelection, EmbedSpecRewrite, EmbedCommittedRevision } from './embedSelection'
import { Workspace } from './App.tsx'
import type { Session } from './api.ts'
import { I18nProvider, useI18n, type EditorLocale } from './i18n.tsx'
import './style.css'
import { useRegisterEmbeddedSession } from './EmbeddedWorkspace'
export { EmbeddedWorkspace } from './EmbeddedWorkspace'
export { AgentCompanionMark } from './AgentCompanionMark'
export { AppearanceProvider, useAppearance } from './Appearance.tsx'
export { AgentPointer } from './AgentPointer'

export type EmbeddedHcdEditorProps = {
  documentId: string
  title?: string
  token: string
  committedRevision?: number
  apiUrl: string
  collabUrl: string
  chatPanel?: ReactNode
  canvasLayout?: 'panel' | 'fill'
  /** The host tab already displays the file name. */
  integratedToolbar?: boolean
  onPreparationChange?: PreparationListener
  onSelectionChange?: (selection: HcdEmbedSelection | null) => void
  /** Open the host assistant for this exact Spec sentence (optional). */
  onSpecRewriteRequest?: (selection: HcdEmbedSelection) => void | Promise<void>
  appearance?: Appearance
  onAppearanceChange?: (appearance: Appearance) => void
  locale?: string
  onLocaleChange?: (locale: EditorLocale) => void
  onClose?: () => void
  onError?: (error: Error) => void
}

/** Mount this component inside an existing React product without an iframe. */
export function EmbeddedHcdEditor(props: EmbeddedHcdEditorProps) {
  return <I18nProvider initialLocale={props.locale} onLocaleChange={props.onLocaleChange}><AppearanceProvider localControls={props.appearance === undefined || !!props.onAppearanceChange} appearance={props.appearance} onAppearanceChange={props.onAppearanceChange}><EmbeddedContent key={JSON.stringify([props.apiUrl, props.documentId])} {...props} /></AppearanceProvider></I18nProvider>
}

function EmbeddedContent({ documentId, title, token, apiUrl, collabUrl, onClose, onError, chatPanel, canvasLayout, integratedToolbar, onSelectionChange, onSpecRewriteRequest, onPreparationChange, committedRevision }: EmbeddedHcdEditorProps) {
  const { theme } = useAppearance()
  const { locale, t } = useI18n()
  const liveToken = useRef(token); liveToken.current = token
  const errorHandler = useRef(onError); errorHandler.current = onError
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const headers = { Authorization: `Bearer ${token}` }
    Promise.all([
      fetch(`${apiUrl}/${encodeURIComponent(documentId)}/auth`, { headers }),
      fetch(`${apiUrl}/${encodeURIComponent(documentId)}`, { headers }),
    ]).then(async ([auth, manifest]) => {
      if (!auth.ok || !manifest.ok) throw new Error(`HCD access failed: ${auth.status}/${manifest.status}`)
      const access = await auth.json() as { scope: 'read' | 'write'; serviceId?: string; userId?: string; displayName?: string; collaborationEpoch: number; hostIntegration?: boolean; operations?: string[] }
      const info = await manifest.json() as { source: { format: string } }
      if (active) setSession({ documentId, title, token, accessToken: () => liveToken.current, scope: access.scope, format: info.source.format,
        serviceId: access.serviceId, userId: access.userId, displayName: access.displayName, collaborationEpoch: access.collaborationEpoch, apiUrl, collabUrl,
        hostIntegration: access.hostIntegration, operations: access.operations })
    }).catch(cause => {
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      if (active) { setSession(null); setError(failure.message); errorHandler.current?.(failure) }
    })
    return () => { active = false }
  }, [documentId, title, token, apiUrl, collabUrl])
  const hideNativeChat = chatPanel !== undefined
  const effective = useMemo(() => session && ({ ...session, locale, hideNativeChat, canvasLayout, integratedToolbar }), [session, locale, hideNativeChat, canvasLayout, integratedToolbar])
  useRegisterEmbeddedSession(effective)
  return <div className="hcd-surface hcd-embedded" data-host-chat={chatPanel ? 'open' : undefined} data-host-back={onClose ? undefined : 'hidden'} data-theme={theme} lang={locale}>
    {effective ? <EmbedCommittedRevision.Provider value={committedRevision}><EmbedPreparation.Provider value={onPreparationChange}><EmbedSelection.Provider value={onSelectionChange}><EmbedSpecRewrite.Provider value={onSpecRewriteRequest}><Workspace key={effective.documentId} session={effective} onClose={() => onClose?.()} onEpochChange={epoch => setSession(previous => previous && ({ ...previous, collaborationEpoch: epoch }))} embedded /></EmbedSpecRewrite.Provider></EmbedSelection.Provider></EmbedPreparation.Provider></EmbedCommittedRevision.Provider> : <div className="embedded-loading">{error || t('openingDocument')}</div>}
    {effective && chatPanel && <aside className="hcd-embed-chat" aria-label="AI 聊天">{chatPanel}</aside>}
  </div>
}
