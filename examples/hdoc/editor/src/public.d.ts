import type { ReactElement } from 'react'

export type HcdEditorLocale = 'en-US' | 'en-GB' | 'zh-CN' | 'zh-TW' | 'zh-HK'

export type EmbeddedHcdEditorProps = {
  documentId: string
  token: string
  /** Same-origin API prefix, for example /v1/documents. */
  apiUrl: string
  collabUrl: string
  /** Initial locale. Defaults to en-US; accepts en, zh, zh-Hant and supported region tags. */
  locale?: string
  onLocaleChange?: (locale: HcdEditorLocale) => void
  onClose?: () => void
  onError?: (error: Error) => void
}

export declare function EmbeddedHcdEditor(props: EmbeddedHcdEditorProps): ReactElement
