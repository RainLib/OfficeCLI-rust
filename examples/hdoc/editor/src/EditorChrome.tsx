import { useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import type { ReactNode } from 'react'
import { ExportControl } from './ExportControl.tsx'
import type { Session } from './api.ts'

export type EditorTab = 'home' | 'insert' | 'view' | 'revisions'

export function EditorHeader({ session, revision, status, activeTab, onTab, onClose, onSettings, onSearch, settingsOpen, beforeExport, presence }: {
  session: Session
  revision: number | null
  status: string
  activeTab: EditorTab
  onTab: (tab: EditorTab) => void
  onClose: () => void
  onSettings: () => void
  onSearch: () => void
  settingsOpen: boolean
  beforeExport?: () => Promise<number | null>
  presence?: ReactNode
}) {
  const { locale } = useI18n()
  return <header className="editor-header">
    <div className="document-identity"><span className="brand">HCD</span><div className="document-title"><strong title={session.documentId}>{session.documentId}</strong><small>{session.format.toUpperCase()} · r{revision ?? '…'}</small></div><span className="status" role="status">{localizeDynamic(locale, status)}</span></div>
    <nav className="header-tabs" aria-label={localizeSource(locale, "编辑功能")}>{([
      ['home', '开始'], ['insert', '插入'], ['view', '视图'], ['revisions', '修订'],
    ] as const).map(([tab, label]) => <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => onTab(tab)}>{localizeSource(locale, label)}</button>)}</nav>
    <div className="header-actions">{presence}<button aria-label={localizeSource(locale, "搜索文档")} title={localizeSource(locale, "查找全文 · ⌘/Ctrl+F")} onClick={onSearch}><LocalText source={"⌕ 搜索"} /></button><ExportControl session={session} revision={revision} beforeExport={beforeExport} /><button className="settings-trigger" aria-label={localizeSource(locale, "界面设置")} aria-expanded={settingsOpen} onClick={onSettings}>⚙</button><button className="ghost" onClick={onClose}><LocalText source={"关闭"} /></button></div>
  </header>
}

export function EditorStatusbar({ mode, format, revision, readOnly, status }: {
  mode: string
  format: string
  revision: number | null
  readOnly: boolean
  status: string
}) {
  const { locale } = useI18n()
  return <footer className="editor-statusbar"><span>{localizeSource(locale, mode)} · {format.toUpperCase()}</span><span>r{revision ?? '…'} · {localizeSource(locale, readOnly ? '只读' : '可编辑')} · {localizeDynamic(locale, status)}</span></footer>
}
