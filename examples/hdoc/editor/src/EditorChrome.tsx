import { ZoomControls } from './CanvasZoom.tsx'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import type { ReactNode } from 'react'
import { ArrowLeft, Check, ChevronDown, ChevronUp, Eye, History, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, PanelRightOpen, Pencil, Search, Settings2, Sparkles } from 'lucide-react'
import { ExportControl } from './ExportControl.tsx'
import { useAgentWorkspace } from './AgentActivityLayer.tsx'
import type { Session } from './api.ts'

export type EditorTab = 'home' | 'insert' | 'view' | 'revisions' | 'format' | 'sheet'

export function EditorHeader({ session, revision, status, onTab, onClose, onSettings, onSearch, settingsOpen, beforeExport, presence, readOnly, onReadOnly, focused, onFocus }: {
  session: Session; revision: number | null; status: string; activeTab: EditorTab
  onTab: (tab: EditorTab) => void; onClose: () => void; onSettings: () => void; onSearch: () => void
  settingsOpen: boolean; beforeExport?: () => Promise<number | null>; presence?: ReactNode
  readOnly: boolean; onReadOnly: (value: boolean) => void; focused: boolean; onFocus: () => void
}) {
  const { locale } = useI18n()
  const { agents, panelOpen, setPanelOpen } = useAgentWorkspace()
  return <header className="editor-header">
    <div className="document-identity"><button className="icon-button back-library" aria-label={localizeSource(locale, '返回文档库')} title={localizeSource(locale, '返回文档库')} onClick={onClose}><ArrowLeft size={18} /></button><div className="document-title"><strong title={session.documentId}>{session.title || session.documentId}</strong><small><LocalText source="工作空间" /> / {session.format.toUpperCase()} · r{revision ?? '…'}</small></div><span className="status" role="status"><Check size={13} />{localizeDynamic(locale, status)}</span></div>
    <nav className="mode-switch" aria-label={localizeSource(locale, '文档模式')}>
      <button aria-pressed={!readOnly} disabled={session.scope === 'read'} onClick={() => onReadOnly(false)}><Pencil size={14} /><LocalText source="编辑" /></button>
      <button aria-pressed={readOnly} onClick={() => onReadOnly(true)}><Eye size={14} /><LocalText source="预览" /></button>
    </nav>
    <div className="header-actions">{presence}
      <button className="collaboration-trigger" aria-expanded={panelOpen && !focused} onClick={() => { if (focused) onFocus(); setPanelOpen(!panelOpen || focused) }}><Sparkles size={15} /><LocalText source="协作" />{agents.length > 0 && <span className="count-badge">{agents.length}</span>}</button>
      <button className="icon-button history-trigger" aria-label={localizeSource(locale, '修订历史')} title={localizeSource(locale, '修订历史')} onClick={() => { setPanelOpen(false); if (focused) onFocus(); onTab('revisions') }}><History size={18} /></button>
      <button className="icon-button search-trigger" aria-label={localizeSource(locale, '搜索文档')} title={localizeSource(locale, '查找全文 · ⌘/Ctrl+F')} onClick={onSearch}><Search size={18} /></button>
      <button className="icon-button focus-trigger" aria-pressed={focused} aria-label={localizeSource(locale, focused ? '退出专注模式' : '专注模式')} title={localizeSource(locale, focused ? '退出专注模式' : '专注模式')} onClick={onFocus}>{focused ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
      <button className="icon-button settings-trigger" aria-label={localizeSource(locale, '界面设置')} title={localizeSource(locale, '界面设置')} aria-expanded={settingsOpen} onClick={() => { setPanelOpen(false); if (focused) onFocus(); onSettings() }}><Settings2 size={18} /></button>
      <ExportControl session={session} revision={revision} beforeExport={beforeExport} />
    </div>
  </header>
}

export function ContentToolbar({ activeTab, onTab, expanded, onToggle, readOnly, format, onSearch }: {
  activeTab: EditorTab; onTab: (tab: EditorTab) => void; expanded: boolean; onToggle: () => void; readOnly: boolean; format: string; onSearch: () => void
}) {
  const { locale } = useI18n()
  const tabs: [EditorTab, string][] = [['home', '开始'], ...(format === 'xlsx' ? [['format', '单元格格式'], ['sheet', '工作表']] as [EditorTab, string][] : []), ['insert', '插入'], ['view', '视图'], ['revisions', '修订']]
  return <div className="content-toolbar">
    {readOnly ? <span className="preview-label"><Eye size={15} /><LocalText source="只读预览" /><small>{format.toUpperCase()}</small></span> : <nav aria-label={localizeSource(locale, '编辑功能')}>{tabs.map(([tab, title]) => <button key={tab} aria-pressed={activeTab === tab} onClick={() => onTab(tab)}>{localizeSource(locale, title)}</button>)}</nav>}
    <div className="content-toolbar-actions"><button className="toolbar-search" aria-label={localizeSource(locale, '查找全文')} title={localizeSource(locale, '查找全文 · ⌘/Ctrl+F')} onClick={onSearch}><Search size={15} /><span><LocalText source="查找" /></span></button>
    {!readOnly && <button className="icon-button toolbar-toggle" title={localizeSource(locale, expanded ? '收起工具栏' : '展开工具栏')} aria-label={localizeSource(locale, expanded ? '收起工具栏' : '展开工具栏')} aria-expanded={expanded} onClick={onToggle}>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>}</div>
  </div>
}

export function PanelDock({ side, onOpen, onHistory, onAgents }: { side: 'left' | 'right'; onOpen: () => void; onHistory?: () => void; onAgents?: () => void }) {
  const { locale } = useI18n()
  const label = side === 'left' ? '展开文档目录' : '展开属性面板'
  return <aside className={`panel-dock ${side}-dock`} aria-label={localizeSource(locale, side === 'left' ? '文档导航' : '面板快捷入口')}>
    <button className="icon-button" aria-label={localizeSource(locale, label)} title={localizeSource(locale, label)} aria-expanded={false} onClick={onOpen}>{side === 'left' ? <PanelLeftOpen size={18} /> : <PanelRightOpen size={18} />}</button>
    {onAgents && <button className="icon-button" aria-label={localizeSource(locale, '展开协作面板')} title={localizeSource(locale, '展开协作面板')} aria-expanded={false} onClick={onAgents}><Sparkles size={18} /></button>}
    {onHistory && <button className="icon-button" aria-label={localizeSource(locale, '修订历史')} title={localizeSource(locale, '修订历史')} onClick={onHistory}><History size={18} /></button>}
  </aside>
}

export const CollapseOutlineIcon = () => <PanelLeftClose size={17} />

export function EditorStatusbar({ mode, format, revision, readOnly, status }: { mode: string; format: string; revision: number | null; readOnly: boolean; status: string }) {
  const { locale } = useI18n()
  return <footer className="editor-statusbar"><span><i className="status-dot" />{localizeSource(locale, readOnly ? '预览模式' : '编辑模式')} · {localizeSource(locale, mode)} · {format.toUpperCase()}</span><span>r{revision ?? '…'} · {localizeDynamic(locale, status)}</span><ZoomControls /></footer>
}
