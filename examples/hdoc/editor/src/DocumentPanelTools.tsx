import { History, Settings2, Shapes } from 'lucide-react'
import { AgentCompanionMark } from './AgentCompanionMark.tsx'
import type { Session } from './api.ts'
import { useAgentWorkspace } from './AgentActivityLayer.tsx'
import { useDocumentViewState } from './DocumentViewState.tsx'
import { permits } from './HostIntegration.tsx'
import { useI18n } from './i18n.tsx'
import { localizeSource } from './sourceLocale.tsx'
import { WorkspacePanelControls, WorkspacePanelLayer } from './WorkspacePanel.tsx'

export function DocumentPanelTools({ session, leftOpen, onToggleLeft, focused, onExitFocus, onHistory }: {
  session: Session; leftOpen: boolean; onToggleLeft: () => void; focused: boolean; onExitFocus: () => void; onHistory?: () => void
}) {
  const { locale } = useI18n()
  const { busy, panelOpen, setPanelOpen } = useAgentWorkspace()
  const { rightPanel, setRightPanel, closeRightPanel, reopenRightPanel, lastRightPanel, setActiveTab } = useDocumentViewState()
  const rightOpen = !focused && (panelOpen || rightPanel !== null)
  const canAgents = !session.hideNativeChat && !session.hostIntegration && permits(session, 'ai.read'), canHistory = permits(session, 'history.view')
  function select(panel: 'settings' | 'revisions' | 'properties') {
    onExitFocus()
    if (rightPanel === panel && !panelOpen && !focused) { closeRightPanel(); return }
    setRightPanel(panel)
    if (panel === 'revisions') { setActiveTab('revisions'); onHistory?.() }
  }
  return <WorkspacePanelLayer>
    <WorkspacePanelControls side="left" open={leftOpen} onToggle={onToggleLeft} />
    <WorkspacePanelControls side="right" open={rightOpen} onToggle={() => {
      if (rightOpen) closeRightPanel()
      else {
        onExitFocus()
        const unavailable = (lastRightPanel === 'agents' && !canAgents) || (lastRightPanel === 'revisions' && !canHistory) || (lastRightPanel === 'properties' && (session.format !== 'pptx' || session.scope !== 'write'))
        if (unavailable) setRightPanel('settings'); else reopenRightPanel()
      }
    }}>
      {canAgents && <button className="collaboration-trigger" aria-label={localizeSource(locale, '协作')} title={localizeSource(locale, '协作')} aria-pressed={panelOpen && !focused} onClick={() => { onExitFocus(); setPanelOpen(!panelOpen || focused) }}><AgentCompanionMark size={20} state={busy ? 'active' : 'idle'} /></button>}
      {canHistory && <button className="history-trigger" aria-label={localizeSource(locale, '修订历史')} title={localizeSource(locale, '修订历史')} aria-pressed={rightPanel === 'revisions' && !focused} onClick={() => select('revisions')}><History size={18} /></button>}
      {session.format === 'pptx' && session.scope === 'write' && <button className="properties-trigger" aria-label={localizeSource(locale, '形状属性')} title={localizeSource(locale, '形状属性')} aria-pressed={rightPanel === 'properties' && !focused} onClick={() => select('properties')}><Shapes size={18} /></button>}
      <button className="settings-trigger" aria-label={localizeSource(locale, '界面设置')} title={localizeSource(locale, '界面设置')} aria-pressed={rightPanel === 'settings' && !focused} onClick={() => select('settings')}><Settings2 size={18} /></button>
    </WorkspacePanelControls>
  </WorkspacePanelLayer>
}
