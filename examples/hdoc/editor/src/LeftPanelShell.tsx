import { useState, type ReactNode } from 'react'
import { ChevronDown, FileText, FolderTree, Layers, PanelLeftClose, PanelsTopLeft, Search, Settings2 } from 'lucide-react'
import type { Session } from './api.ts'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'

/** Pen VpLwm: one continuous navigation/content surface and a separate footer. */
export function LeftPanelShell({ session, hidden, className = '', label, onClose, onSearch, onWorkspace, onSettings, children }: {
  session: Session; hidden: boolean; className?: string; label: string; children: ReactNode
  onClose: () => void; onSearch: () => void; onWorkspace: () => void; onSettings: () => void
}) {
  const { locale } = useI18n()
  const [files, setFiles] = useState(false)
  return <aside hidden={hidden} className={`outline-panel workspace-left-panel ${className}`} aria-label={localizeSource(locale, label)}>
    <div className="left-panel-main">
      <div className="left-panel-navigation">
        <div className="panel-tool-row" role="toolbar" aria-label={localizeSource(locale, '左侧工具')}>
          <button aria-label={localizeSource(locale, '文件与项目')} title={localizeSource(locale, '文件与项目')} aria-pressed={files} onClick={() => setFiles(value => !value)}><FolderTree size={16} /></button>
          <button aria-label={localizeSource(locale, '文档结构')} title={localizeSource(locale, '文档结构')} aria-pressed={!files} onClick={() => setFiles(false)}><Layers size={16} /></button>
          <button aria-label={localizeSource(locale, '搜索文档')} title={localizeSource(locale, '搜索文档')} onClick={onSearch}><Search size={16} /></button>
          <span className="panel-tool-spacer" />
          <button className="panel-close" aria-label={localizeSource(locale, '收起左侧面板')} title={localizeSource(locale, '收起左侧面板')} onClick={onClose}><PanelLeftClose size={16} /></button>
        </div>
        <button className="panel-workspace-path" aria-label={localizeSource(locale, '当前文档信息')} aria-expanded={files} onClick={() => setFiles(value => !value)}><span><LocalText source="当前文档" /></span><ChevronDown size={12} /></button>
      </div>
      <div className="left-panel-file-tools" hidden={!files}>
        <div><FileText size={14} /><span title={session.title || session.documentId}>{session.title || session.documentId}</span><small>{session.format.toUpperCase()}</small></div>
        <button onClick={onWorkspace}><LocalText source="打开其他文档" /></button>
      </div>
      <div className="left-panel-content">{children}</div>
    </div>
    <footer className="left-panel-footer"><button onClick={onWorkspace}><PanelsTopLeft size={16} /><LocalText source="工作空间" /></button><button className="left-panel-settings" aria-label={localizeSource(locale, '外观与设置')} title={localizeSource(locale, '外观与设置')} onClick={onSettings}><Settings2 size={16} /></button></footer>
  </aside>
}
