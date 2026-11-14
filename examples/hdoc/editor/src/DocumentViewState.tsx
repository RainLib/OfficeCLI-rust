import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import type { EditorTab } from './EditorChrome.tsx'

type DocumentViewState = {
  preview: boolean; setPreview: Dispatch<SetStateAction<boolean>>
  focused: boolean; setFocused: Dispatch<SetStateAction<boolean>>
  wrapText: boolean; setWrapText: Dispatch<SetStateAction<boolean>>
  selectedRevision: number | null; setSelectedRevision: Dispatch<SetStateAction<number | null>>
  comparing: boolean; setComparing: Dispatch<SetStateAction<boolean>>
  rightPanel: 'settings' | 'revisions' | null; setRightPanel: Dispatch<SetStateAction<'settings' | 'revisions' | null>>
  agentPanelOpen: boolean; setAgentPanelOpen: Dispatch<SetStateAction<boolean>>
  activeTab: EditorTab; setActiveTab: Dispatch<SetStateAction<EditorTab>>
}
const ViewContext = createContext<DocumentViewState | null>(null)

/** UI state lives above the collaboration epoch: replacing a Yjs room must not
 * change the user's reading mode or take them out of an immutable revision. */
export function DocumentViewProvider({ initialPreview, children }: { initialPreview: boolean; children: ReactNode }) {
  const [preview, setPreview] = useState(initialPreview)
  const [focused, setFocused] = useState(false)
  const [wrapText, setWrapText] = useState(true)
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null)
  const [comparing, setComparing] = useState(false)
  const [rightPanel, setRightPanel] = useState<'settings' | 'revisions' | null>(null)
  const [agentPanelOpen, setAgentPanelOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth > 900)
  const [activeTab, setActiveTab] = useState<EditorTab>('home')
  return <ViewContext.Provider value={{ preview, setPreview, focused, setFocused, wrapText, setWrapText, selectedRevision, setSelectedRevision, comparing, setComparing, rightPanel, setRightPanel, agentPanelOpen, setAgentPanelOpen, activeTab, setActiveTab }}>{children}</ViewContext.Provider>
}

export function useDocumentViewState() {
  const state = useContext(ViewContext)
  if (!state) throw new Error('DocumentViewProvider is required')
  return state
}
