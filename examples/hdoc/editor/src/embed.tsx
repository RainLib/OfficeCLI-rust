import { AppearanceProvider, useAppearance, type Appearance } from './Appearance.tsx'
import { useEffect, useRef, useState } from 'react'
import { Workspace } from './App.tsx'
import type { Session } from './api.ts'
import { I18nProvider, useI18n, type EditorLocale } from './i18n.tsx'
import './style.css'

export type EmbeddedHcdEditorProps = {
  documentId: string
  token: string
  apiUrl: string
  collabUrl: string
  appearance?: Appearance
  onAppearanceChange?: (appearance: Appearance) => void
  locale?: string
  onLocaleChange?: (locale: EditorLocale) => void
  onClose?: () => void
  onError?: (error: Error) => void
}

/** Mount this component inside an existing React product without an iframe. */
export function EmbeddedHcdEditor(props: EmbeddedHcdEditorProps) {
  return <I18nProvider initialLocale={props.locale} onLocaleChange={props.onLocaleChange}><AppearanceProvider appearance={props.appearance} onAppearanceChange={props.onAppearanceChange}><EmbeddedContent {...props} /></AppearanceProvider></I18nProvider>
}

function EmbeddedContent({ documentId, token, apiUrl, collabUrl, onClose, onError }: EmbeddedHcdEditorProps) {
  const { theme } = useAppearance()
  const { locale, t } = useI18n()
  const liveToken = useRef(token); liveToken.current = token
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
      const access = await auth.json() as { scope: 'read' | 'write'; userId?: string; displayName?: string; collaborationEpoch: number; hostIntegration?: boolean; operations?: string[] }
      const info = await manifest.json() as { source: { format: string } }
      if (active) setSession({ documentId, token, accessToken: () => liveToken.current, scope: access.scope, format: info.source.format,
        userId: access.userId, displayName: access.displayName, collaborationEpoch: access.collaborationEpoch, apiUrl, collabUrl,
        hostIntegration: access.hostIntegration, operations: access.operations })
    }).catch(cause => {
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      if (active) { setError(failure.message); onError?.(failure) }
    })
    return () => { active = false }
  }, [documentId, token, apiUrl, collabUrl, onError])
  return <div className="hcd-surface hcd-embedded" data-theme={theme} lang={locale}>
    {session ? <Workspace key={session.documentId} session={session} onClose={() => onClose?.()} onEpochChange={epoch => setSession(previous => previous && ({ ...previous, collaborationEpoch: epoch }))} embedded /> : <div className="embedded-loading">{error || t('openingDocument')}</div>}
  </div>
}
