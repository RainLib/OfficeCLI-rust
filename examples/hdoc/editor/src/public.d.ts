import type { ReactElement } from 'react'

export type EmbeddedHcdEditorProps = {
  documentId: string
  token: string
  /** Same-origin API prefix, for example /v1/documents. */
  apiUrl: string
  collabUrl: string
  onClose?: () => void
  onError?: (error: Error) => void
}

export declare function EmbeddedHcdEditor(props: EmbeddedHcdEditorProps): ReactElement
