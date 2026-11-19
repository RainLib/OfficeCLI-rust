import type { ReactElement, ReactNode } from 'react'

export type HcdEditorLocale = 'en-US' | 'en-GB' | 'zh-CN' | 'zh-TW' | 'zh-HK'

export type HcdEmbedSelection = {
  documentId: string
  revision: number
  collaborationEpoch: number
  target: { kind: 'document'; spans: { blockId: string; start: number; end: number; textHash: string }[] }
    | { kind: 'canvas'; elementIds: string[]; spec?:true }
    | { kind: 'spec'; id:string; block:number; start:number; end:number; expected:string; anchor:string; head:string }
    | { kind: 'sheet'; sheetId: string; sheetIndex: number; top: number; left: number; bottom: number; right: number }
}

export type EmbeddedHcdEditorProps = {
  documentId: string
  title?: string
  token: string
  committedRevision?: number
  /** Same-origin API prefix, for example /v1/documents. */
  apiUrl: string
  collabUrl: string
  /** Omit to retain the editor's native panel, pass false to hide it, or supply a host-owned chat. */
  chatPanel?: ReactNode
  /** Fill the host pane when the surrounding app already supplies the file title and navigation. */
  canvasLayout?: 'panel' | 'fill'
  onPreparationChange?: (prepare: (() => Promise<unknown>) | null) => void
  onSelectionChange?: (selection: HcdEmbedSelection | null) => void
  /** Open the host assistant for this exact Spec sentence (optional). */
  onSpecRewriteRequest?: (selection: HcdEmbedSelection) => void | Promise<void>
  /** Initial locale. Defaults to en-US; accepts en, zh, zh-Hant and supported region tags. */
  locale?: string
  /** Workspace appearance; document colors are preserved. Defaults to system. */
  appearance?: 'system' | 'light' | 'dark'
  onAppearanceChange?: (appearance: 'system' | 'light' | 'dark') => void
  onLocaleChange?: (locale: HcdEditorLocale) => void
  onClose?: () => void
  onError?: (error: Error) => void
}

export declare function EmbeddedHcdEditor(props: EmbeddedHcdEditorProps): ReactElement
export declare function AgentCompanionMark(props: {size:number; state?:'idle'|'listening'|'active'|'complete'|'still'; label?:string}): ReactElement

export declare function AgentPointer(props: { phase: 'idle' | 'writing' | 'done'; className?: string; color?: string; label?: string }): ReactElement

export type Appearance = 'system' | 'light' | 'dark'
export declare function AppearanceProvider(props: {
  children: ReactNode; persist?: boolean; initialAppearance?: Appearance
  appearance?: Appearance; onAppearanceChange?: (value: Appearance) => void; localControls?: boolean
}): ReactElement
export declare function useAppearance(): {
  preference: Appearance; theme: 'light' | 'dark'; setPreference: (value: Appearance) => void; localControls: boolean
}
