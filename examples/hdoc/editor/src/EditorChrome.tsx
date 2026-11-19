import { DocumentVisitorIdentity, ShareControl } from './DocumentSharing.tsx'
import { AppearanceSelect } from './Appearance.tsx'
import { ZoomControls } from './CanvasZoom.tsx'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import type { ReactNode } from 'react'
import { ArrowLeft, Check, ChevronDown, ChevronUp, Eye, Maximize2, Minimize2, PanelLeftClose, PanelRightClose, Search } from 'lucide-react'
import { ExportControl } from './ExportControl.tsx'
import type { Session } from './api.ts'
import { HostPublicationControl, permits, useHostPolicy } from './HostIntegration.tsx'

export type EditorTab = 'home' | 'insert' | 'view' | 'revisions' | 'format' | 'sheet'

export function EditorHeader({ session, revision, status, onClose, onSearch, beforeExport, presence, focused, onFocus }: {
  session: Session; revision: number | null; status: string
  onClose: () => void; onSearch: () => void
  beforeExport?: () => Promise<number | null>; presence?: ReactNode
  focused: boolean; onFocus: () => void
}) {
  const { locale } = useI18n()
  const headerStatus = status === '只读' ? '已打开' : status === '历史只读' ? '历史版本' : status
  return <header className="editor-header">
    <div className="document-identity"><button className="icon-button back-library" aria-label={localizeSource(locale, '返回文档库')} title={localizeSource(locale, '返回文档库')} onClick={onClose}><ArrowLeft size={18} /></button><div className="document-title"><strong title={session.documentId}>{session.title || session.documentId}</strong><small><LocalText source="工作空间" /> / {session.format.toUpperCase()} · r{revision ?? '…'}</small></div><span className="status" role="status"><Check size={13} />{localizeDynamic(locale, headerStatus)}</span></div>
    <div className="header-actions">{presence}<ShareControl /><AppearanceSelect />
      <HostPublicationControl session={session} revision={revision} beforeSave={beforeExport} />
      <button className="icon-button search-trigger" aria-label={localizeSource(locale, '搜索文档')} title={localizeSource(locale, '查找全文 · ⌘/Ctrl+F')} onClick={onSearch}><Search size={18} /></button>
      <button className="icon-button focus-trigger" aria-pressed={focused} aria-label={localizeSource(locale, focused ? '退出专注模式' : '专注模式')} title={localizeSource(locale, focused ? '退出专注模式' : '专注模式')} onClick={onFocus}>{focused ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
      {(permits(session, 'document.download') || permits(session, 'document.export')) && <ExportControl session={session} revision={revision} beforeExport={beforeExport} />}
    </div>
  </header>
}

export function ContentToolbar({ activeTab, onTab, expanded, onToggle, readOnly, format, onSearch }: {
  activeTab: EditorTab; onTab: (tab: EditorTab) => void; expanded: boolean; onToggle: () => void; readOnly: boolean; format: string; onSearch: () => void
}) {
  const { locale } = useI18n()
  const policy = useHostPolicy()
  const tabs: [EditorTab, string][] = [['home', '开始'], ...(format === 'xlsx' ? [['format', '单元格格式'], ['sheet', '工作表']] as [EditorTab, string][] : []), ['insert', '插入'], ['view', '视图'], ['revisions', '修订']]
  return <div className="content-toolbar">
    {readOnly ? <span className="preview-label"><Eye size={15} /><LocalText source="文档内容" /><small>{format.toUpperCase()}</small></span> : <nav aria-label={localizeSource(locale, '编辑功能')}>{tabs.filter(([tab]) => tab !== 'revisions' || policy.permits('history.view')).map(([tab, title]) => <button key={tab} aria-pressed={activeTab === tab} onClick={() => onTab(tab)}>{localizeSource(locale, title)}</button>)}</nav>}
    <div className="content-toolbar-actions"><button className="toolbar-search" aria-label={localizeSource(locale, '查找全文')} title={localizeSource(locale, '查找全文 · ⌘/Ctrl+F')} onClick={onSearch}><Search size={15} /><span><LocalText source="查找" /></span></button>
    {!readOnly && <button className="icon-button toolbar-toggle" title={localizeSource(locale, expanded ? '收起工具栏' : '展开工具栏')} aria-label={localizeSource(locale, expanded ? '收起工具栏' : '展开工具栏')} aria-expanded={expanded} onClick={onToggle}>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>}</div>
  </div>
}

export const CollapseOutlineIcon = () => <PanelLeftClose size={17} />
export const CollapseSidebarIcon = () => <PanelRightClose size={17} />

export function EditorStatusbar({ mode, format, revision, readOnly, status, draftProtection }: { mode: string; format: string; revision: number | null; readOnly: boolean; status: string; draftProtection?: 'loading' | 'protected' | 'writing' | 'failed' }) {
  const { locale } = useI18n()
  return <footer className="editor-statusbar"><span><i className="status-dot" />{localizeSource(locale, readOnly ? '可查看' : '可编辑')} · {localizeSource(locale, mode)} · {format.toUpperCase()}</span><span>r{revision ?? '…'} · {localizeDynamic(locale, status)}</span><DocumentVisitorIdentity />{draftProtection && <span data-draft-protection={draftProtection} aria-label={localizeSource(locale, '本地草稿保护')}>{localizeSource(locale, { loading: '准备本地草稿', protected: '本地草稿已保护', writing: '正在保护草稿', failed: '本地保护不可用' }[draftProtection])}</span>}<ZoomControls /></footer>
}
