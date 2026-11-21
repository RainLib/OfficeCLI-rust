import { createContext, useCallback, useContext, useEffect, useReducer, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import type { EditorTab } from './EditorChrome.tsx'

type RightPanel = 'agents' | 'settings' | 'revisions' | 'properties' | 'word-review'
type PanelState = { agentPanelOpen: boolean; rightPanel: Exclude<RightPanel, 'agents'> | null; lastRightPanel: RightPanel }
type PanelAction = { type: 'agents'; value: SetStateAction<boolean> } | { type: 'panel'; value: SetStateAction<PanelState['rightPanel']> } | { type: 'close' } | { type: 'reopen' }
function panelReducer(state: PanelState, action: PanelAction): PanelState {
  if (action.type === 'close') return { ...state, agentPanelOpen: false, rightPanel: null }
  if (action.type === 'reopen') return { ...state, agentPanelOpen: state.lastRightPanel === 'agents', rightPanel: state.lastRightPanel === 'agents' ? null : state.lastRightPanel }
  if (action.type === 'agents') {
    const open = typeof action.value === 'function' ? action.value(state.agentPanelOpen) : action.value
    return open ? { agentPanelOpen: true, rightPanel: null, lastRightPanel: 'agents' } : { ...state, agentPanelOpen: false }
  }
  const panel = typeof action.value === 'function' ? action.value(state.rightPanel) : action.value
  return { agentPanelOpen: false, rightPanel: panel, lastRightPanel: panel ?? state.lastRightPanel }
}

type DocumentViewState = {
  focused: boolean; setFocused: Dispatch<SetStateAction<boolean>>
  wrapText: boolean; setWrapText: Dispatch<SetStateAction<boolean>>
  selectedRevision: number | null; setSelectedRevision: Dispatch<SetStateAction<number | null>>
  comparing: boolean; setComparing: Dispatch<SetStateAction<boolean>>
  stickerMotionPaused: boolean; setStickerMotionPaused: Dispatch<SetStateAction<boolean>>
  rightPanel: PanelState['rightPanel']; setRightPanel: Dispatch<SetStateAction<PanelState['rightPanel']>>
  agentPanelOpen: boolean; setAgentPanelOpen: Dispatch<SetStateAction<boolean>>
  lastRightPanel: RightPanel; closeRightPanel: () => void; reopenRightPanel: () => void
  ribbonExpanded: boolean; setRibbonExpanded: Dispatch<SetStateAction<boolean>>
  activeTab: EditorTab; setActiveTab: Dispatch<SetStateAction<EditorTab>>
}
const ViewContext = createContext<DocumentViewState | null>(null)
type SavedView = Pick<DocumentViewState, 'focused' | 'wrapText' | 'selectedRevision' | 'comparing' | 'rightPanel' | 'agentPanelOpen' | 'activeTab' | 'lastRightPanel' | 'stickerMotionPaused' | 'ribbonExpanded'>
function readView(key?: string): Partial<SavedView> {
  try {
    if (!key) return {}
    const data = JSON.parse(sessionStorage.getItem(`hcd-view-v1:${key}`) || '{}')
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const result: Partial<SavedView> = {}
    for (const property of ['focused', 'wrapText', 'comparing', 'agentPanelOpen', 'stickerMotionPaused', 'ribbonExpanded'] as const) if (typeof data[property] === 'boolean') result[property] = data[property]
    if (data.selectedRevision === null || Number.isSafeInteger(data.selectedRevision) && data.selectedRevision >= 0) result.selectedRevision = data.selectedRevision
    if (['settings', 'revisions', 'properties', 'word-review', null].includes(data.rightPanel)) result.rightPanel = data.rightPanel
    if (['agents', 'settings', 'revisions', 'properties', 'word-review'].includes(data.lastRightPanel)) result.lastRightPanel = data.lastRightPanel
    if (['home', 'insert', 'view', 'review', 'revisions', 'format', 'sheet', 'data', 'animation', 'layout', 'references', 'formula', 'design', 'show', 'pages', 'ocr'].includes(data.activeTab)) result.activeTab = data.activeTab
    return result
  } catch { return {} }
}

/** UI state lives above the collaboration epoch: replacing a Yjs room must not
 * change the user's reading mode or take them out of an immutable revision. */
export function DocumentViewProvider({ storageKey, children }: { storageKey?: string; children: ReactNode }) {
  const [saved] = useState(() => readView(storageKey))
  const [focused, setFocused] = useState(saved.focused ?? false)
  const [wrapText, setWrapText] = useState(saved.wrapText ?? true)
  const [selectedRevision, setSelectedRevision] = useState<number | null>(saved.selectedRevision ?? null)
  const [comparing, setComparing] = useState(saved.comparing ?? false)
  const [stickerMotionPaused, setStickerMotionPaused] = useState(saved.stickerMotionPaused ?? false)
  const [{ rightPanel, agentPanelOpen, lastRightPanel }, dispatchPanel] = useReducer(panelReducer, saved, initial => {
    const panel = initial.agentPanelOpen ? null : initial.rightPanel ?? null
    const agents = panel ? false : initial.agentPanelOpen ?? (typeof window !== 'undefined' && window.innerWidth > 900)
    return { rightPanel: panel, agentPanelOpen: agents, lastRightPanel: initial.lastRightPanel ?? (panel || 'agents') }
  })
  const setRightPanel = useCallback<DocumentViewState['setRightPanel']>(value => dispatchPanel({ type: 'panel', value }), [])
  const setAgentPanelOpen = useCallback<DocumentViewState['setAgentPanelOpen']>(value => dispatchPanel({ type: 'agents', value }), [])
  const closeRightPanel = useCallback(() => dispatchPanel({ type: 'close' }), [])
  const reopenRightPanel = useCallback(() => dispatchPanel({ type: 'reopen' }), [])
  const [ribbonExpanded, setRibbonExpanded] = useState(saved.ribbonExpanded ?? false)
  const [activeTab, setActiveTab] = useState<EditorTab>(saved.activeTab ?? 'home')
  useEffect(() => {
    if (!storageKey) return
    try { sessionStorage.setItem(`hcd-view-v1:${storageKey}`, JSON.stringify({ focused, wrapText, selectedRevision, comparing, rightPanel, agentPanelOpen, lastRightPanel, activeTab, ribbonExpanded, stickerMotionPaused })) } catch { /* Storage is optional. */ }
  }, [storageKey, focused, wrapText, selectedRevision, comparing, rightPanel, agentPanelOpen, lastRightPanel, activeTab, ribbonExpanded, stickerMotionPaused])
  return <ViewContext.Provider value={{ focused, setFocused, wrapText, setWrapText, selectedRevision, setSelectedRevision, comparing, setComparing, rightPanel, setRightPanel, agentPanelOpen, setAgentPanelOpen, lastRightPanel, closeRightPanel, reopenRightPanel, activeTab, setActiveTab, ribbonExpanded, setRibbonExpanded, stickerMotionPaused, setStickerMotionPaused }}>{children}</ViewContext.Provider>
}

export function useDocumentViewState() {
  const state = useContext(ViewContext)
  if (!state) throw new Error('DocumentViewProvider is required')
  return state
}
