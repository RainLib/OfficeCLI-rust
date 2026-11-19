import { AppearanceSelect } from './Appearance.tsx'
import { ZoomControls } from './CanvasZoom.tsx'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import type { ReactNode } from 'react'
import { ArrowLeft, Check, ChevronDown, ChevronUp, Eye, History, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pencil, Search, Settings2, Shapes, Sparkles } from 'lucide-react'
import { ExportControl } from './ExportControl.tsx'
import { useAgentWorkspace } from './AgentActivityLayer.tsx'
import type { Session } from './api.ts'
import { useDocumentViewState } from './DocumentViewState.tsx'
import { HostPublicationControl, permits, useHostPolicy } from './HostIntegration.tsx'

export type EditorTab = 'home' | 'insert' | 'view' | 'revisions' | 'format' | 'sheet' | 'data'

export function EditorHeader({ session, revision, status, onTab, onClose, onSettings, onSearch, settingsOpen, beforeExport, activeSheetName, presence, readOnly, onReadOnly, focused, onFocus, outlineOpen, onToggleOutline }: {
  session: Session; revision: number | null; status: string; activeTab: EditorTab
  onTab: (tab: EditorTab) => void; onClose: () => void; onSettings: () => void; onSearch: () => void
  settingsOpen: boolean; beforeExport?: () => Promise<number | null>; activeSheetName?: string; presence?: ReactNode
  readOnly: boolean; onReadOnly: (value: boolean) => void; focused: boolean; onFocus: () => void
  outlineOpen: boolean; onToggleOutline: () => void
}) {
  const { locale } = useI18n()
  const { agents, panelOpen, setPanelOpen } = useAgentWorkspace()
  const { rightPanel, setRightPanel, closeRightPanel, reopenRightPanel } = useDocumentViewState()
  const rightOpen = !focused && (panelOpen || rightPanel !== null)
  return <header className="editor-header">
    <div className="document-identity"><button className="icon-button sidebar-toggle left-sidebar-toggle" aria-label={localizeSource(locale, outlineOpen ? '收起左侧栏' : '展开左侧栏')} title={localizeSource(locale, outlineOpen ? '收起左侧栏' : '展开左侧栏')} aria-expanded={outlineOpen} onClick={onToggleOutline}>{outlineOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button><button className="icon-button back-library" aria-label={localizeSource(locale, '返回文档库')} title={localizeSource(locale, '返回文档库')} onClick={onClose}><ArrowLeft size={18} /></button><div className="document-title"><strong title={session.documentId}>{session.title || session.documentId}</strong><small><LocalText source="工作空间" /> / {session.format.toUpperCase()} · r{revision ?? '…'}</small></div><span className="status" role="status"><Check size={13} />{localizeDynamic(locale, status)}</span></div>
    <nav className="mode-switch" aria-label={localizeSource(locale, '文档模式')}>
      <button aria-pressed={!readOnly} disabled={session.scope === 'read'} onClick={() => onReadOnly(false)} title={localizeSource(locale, session.format === 'docx' ? '在连续长页中编辑文档' : '编辑文档')}><Pencil size={14} /><LocalText source={session.format === 'docx' ? '连续编辑' : '编辑'} /></button>
      <button aria-pressed={readOnly} onClick={() => onReadOnly(true)} title={localizeSource(locale, session.format === 'docx' ? '按页面查看页眉、页脚和打印排版（只读）' : '只读预览')}><Eye size={14} /><LocalText source={session.format === 'docx' ? '分页预览' : '预览'} /></button>
    </nav>
    <div className="header-actions">{presence}<AppearanceSelect />
      <HostPublicationControl session={session} revision={revision} beforeSave={beforeExport} />
      {permits(session, 'ai.read') && <button className="collaboration-trigger" aria-expanded={panelOpen && !focused} onClick={() => { if (focused) onFocus(); setPanelOpen(!panelOpen || focused) }}><Sparkles size={15} /><LocalText source="协作" />{agents.length > 0 && <span className="count-badge">{agents.length}</span>}</button>}
      {permits(session, 'history.view') && <button className="icon-button history-trigger" aria-label={localizeSource(locale, '修订历史')} title={localizeSource(locale, '修订历史')} onClick={() => { setPanelOpen(false); if (focused) onFocus(); onTab('revisions') }}><History size={18} /></button>}
      <button className="icon-button search-trigger" aria-label={localizeSource(locale, '搜索文档')} title={localizeSource(locale, '查找全文 · ⌘/Ctrl+F')} onClick={onSearch}><Search size={18} /></button>
      <button className="icon-button focus-trigger" aria-pressed={focused} aria-label={localizeSource(locale, focused ? '退出专注模式' : '专注模式')} title={localizeSource(locale, focused ? '退出专注模式' : '专注模式')} onClick={onFocus}>{focused ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
      {session.format === 'pptx' && <button className="icon-button properties-trigger" aria-label={localizeSource(locale, '形状属性')} title={localizeSource(locale, '形状属性')} aria-pressed={rightPanel === 'properties' && !focused} onClick={() => { if (focused) onFocus(); setRightPanel('properties') }}><Shapes size={18} /></button>}
      <button className="icon-button settings-trigger" aria-label={localizeSource(locale, '界面设置')} title={localizeSource(locale, '界面设置')} aria-expanded={settingsOpen} onClick={() => { setPanelOpen(false); if (focused) onFocus(); onSettings() }}><Settings2 size={18} /></button>
      {(permits(session, 'document.download') || permits(session, 'document.export')) && <ExportControl session={session} revision={revision} beforeExport={beforeExport} activeSheetName={activeSheetName} />}
      <button className="icon-button sidebar-toggle right-sidebar-toggle" aria-label={localizeSource(locale, rightOpen ? '收起右侧栏' : '展开右侧栏')} title={localizeSource(locale, rightOpen ? '收起右侧栏' : '展开右侧栏')} aria-expanded={rightOpen} onClick={() => { if (rightOpen) closeRightPanel(); else { if (focused) onFocus(); reopenRightPanel() } }}>{rightOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
    </div>
  </header>
}

export function ContentToolbar({ activeTab, onTab, expanded, onToggle, readOnly, format, onSearch }: {
  activeTab: EditorTab; onTab: (tab: EditorTab) => void; expanded: boolean; onToggle: () => void; readOnly: boolean; format: string; onSearch: () => void
}) {
  const { locale } = useI18n()
  const policy = useHostPolicy()
  const tabs: [EditorTab, string][] = [['home', '开始'], ...(format === 'xlsx' ? [['format', '单元格格式'], ['sheet', '工作表']] as [EditorTab, string][] : []), ['insert', '插入'], ...(['xlsx', 'csv', 'tsv'].includes(format) ? [['data', '数据']] as [EditorTab, string][] : []), ['view', '视图'], ['revisions', '修订']]
  return <div className="content-toolbar">
    {readOnly ? <span className="preview-label"><Eye size={15} /><LocalText source="只读预览" /><small>{format.toUpperCase()}</small>{['xlsx', 'csv', 'tsv'].includes(format) && <button aria-pressed={activeTab === 'data'} onClick={() => onTab('data')}><LocalText source="数据" /></button>}</span> : <nav aria-label={localizeSource(locale, '编辑功能')}>{tabs.filter(([tab]) => tab !== 'revisions' || policy.permits('history.view')).map(([tab, title]) => <button key={tab} aria-pressed={activeTab === tab} onClick={() => onTab(tab)}>{localizeSource(locale, title)}</button>)}</nav>}
    <div className="content-toolbar-actions"><button className="toolbar-search" aria-label={localizeSource(locale, '查找全文')} title={localizeSource(locale, '查找全文 · ⌘/Ctrl+F')} onClick={onSearch}><Search size={15} /><span><LocalText source="查找" /></span></button>
    {!readOnly && <button className="icon-button toolbar-toggle" title={localizeSource(locale, expanded ? '收起工具栏' : '展开工具栏')} aria-label={localizeSource(locale, expanded ? '收起工具栏' : '展开工具栏')} aria-expanded={expanded} onClick={onToggle}>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>}</div>
  </div>
}

export const CollapseOutlineIcon = () => <PanelLeftClose size={17} />
export const CollapseSidebarIcon = () => <PanelRightClose size={17} />

export function EditorStatusbar({ mode, format, revision, readOnly, status, draftProtection }: { mode: string; format: string; revision: number | null; readOnly: boolean; status: string; draftProtection?: 'loading' | 'protected' | 'writing' | 'failed' }) {
  const { locale } = useI18n()
  return <footer className="editor-statusbar"><span><i className="status-dot" />{localizeSource(locale, readOnly ? '预览模式' : '编辑模式')} · {localizeSource(locale, mode)} · {format.toUpperCase()}</span><span>r{revision ?? '…'} · {localizeDynamic(locale, status)}</span>{draftProtection && <span data-draft-protection={draftProtection} aria-label={localizeSource(locale, '本地草稿保护')}>{localizeSource(locale, { loading: '准备本地草稿', protected: '本地草稿已保护', writing: '正在保护草稿', failed: '本地保护不可用' }[draftProtection])}</span>}<ZoomControls /></footer>
}
