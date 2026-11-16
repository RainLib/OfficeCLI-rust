import { AppearanceSelect } from './Appearance.tsx'
import { useState, type ReactNode } from 'react'
import { Image as ImageIcon, ArrowRight, ChevronRight, File, FileCode2, Files, FileText, FolderOpen, Layers2, Link2, List, PanelLeftClose, PanelLeftOpen, Presentation, Search, Sheet, Upload } from 'lucide-react'
import { LocaleSelect, useI18n } from './i18n.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import type { Session } from './api.ts'

export type LibraryDocument = { id: string; title: string; format: string; mode: string }
export function FormatIcon({ format, size = 18 }: { format: string; size?: number }) {
  const Icon = ['png', 'jpg', 'jpeg', 'webp'].includes(format.toLowerCase()) ? ImageIcon : format.toLowerCase() === 'xlsx' ? Sheet : format.toLowerCase() === 'pptx' ? Presentation : ['html', 'md', 'markdown'].includes(format.toLowerCase()) ? FileCode2 : format.toLowerCase() === 'pdf' ? File : FileText
  return <span className={`format-icon format-${format.toLowerCase()}`}><Icon size={size} strokeWidth={1.6} /></span>
}

export function WorkspaceLibrary({ samples, sessions, opening, onOpen, onResume, children }: {
  samples: LibraryDocument[]; sessions: Session[]; opening: string | null
  onOpen: (id: string) => void; onResume: (id: string) => void; children: ReactNode
}) {
  const { locale } = useI18n()
  const [collapsed, setCollapsed] = useState(false)
  const [view, setView] = useState<'all' | 'open'>('all')
  const [query, setQuery] = useState('')
  const [format, setFormat] = useState('all')
  const [accessOpen, setAccessOpen] = useState(false)
  const documents = view === 'open'
    ? sessions.map(session => ({ id: session.documentId, title: session.title || session.documentId, format: session.format, mode: session.scope === 'read' ? '只读' : '可编辑' }))
    : [...samples, ...sessions.filter(session => !samples.some(sample => sample.id === session.documentId)).map(session => ({ id: session.documentId, title: session.title || session.documentId, format: session.format, mode: session.scope === 'read' ? '只读' : '可编辑' }))]
  const filtered = documents.filter(document => (format === 'all' || (document.format.toLowerCase() === 'markdown' ? 'md' : document.format.toLowerCase()) === format) && `${document.title} ${document.format}`.toLowerCase().includes(query.toLowerCase()))
  function openDocument(id: string) { if (sessions.some(session => session.documentId === id)) onResume(id); else onOpen(id) }
  function showAccess() { setAccessOpen(true); requestAnimationFrame(() => document.getElementById('document-access')?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }
  return <main className={`workspace-library ${collapsed ? 'library-collapsed' : ''}`}>
    <aside className="library-navigation" aria-label={localizeSource(locale, '工作空间导航')}>
      <div className="library-brand"><Layers2 size={24} /><strong>office.</strong><button className="icon-button" aria-label={localizeSource(locale, collapsed ? '展开导航' : '收起导航')} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
      <div className="workspace-label"><span>O</span><LocalText source="我的工作空间" /></div>
      <nav><button className={view === 'all' ? 'selected' : ''} title={localizeSource(locale, '所有文档')} onClick={() => setView('all')}><Files size={18} /><span><LocalText source="所有文档" /></span><small>{samples.length + sessions.filter(session => !samples.some(sample => sample.id === session.documentId)).length}</small></button><button className={view === 'open' ? 'selected' : ''} title={localizeSource(locale, '已打开的文档')} onClick={() => setView('open')}><FolderOpen size={18} /><span><LocalText source="已打开的文档" /></span><small>{sessions.length}</small></button><button title={localizeSource(locale, '连接文档')} onClick={showAccess}><Link2 size={18} /><span><LocalText source="连接文档" /></span></button><button title={localizeSource(locale, '导入 HCD')} onClick={showAccess}><Upload size={18} /><span><LocalText source="导入 HCD" /></span></button></nav>
      <div className="library-nav-footer"><span className="workspace-avatar">O</span><span>OfficeCLI<small><LocalText source="文档工作空间" /></small></span></div>
    </aside>
    <div className="library-main">
      <header className="library-topbar"><span><LocalText source="工作空间" /><ChevronRight size={14} /><LocalText source={view === 'all' ? '所有文档' : '已打开的文档'} /></span><label className="library-search"><Search size={17} /><input aria-label={localizeSource(locale, '搜索文档')} placeholder={localizeSource(locale, '搜索文档名称或格式')} value={query} onChange={event => setQuery(event.target.value)} /></label><AppearanceSelect /><LocaleSelect /></header>
      <section className="library-content">
        <div className="library-heading"><div><h1><LocalText source={view === 'all' ? '所有文档' : '已打开的文档'} /></h1><p><LocalText source="让文档、想法与协作，留在同一个工作空间。" /></p></div><button className="primary" onClick={showAccess}><Upload size={16} /><LocalText source="连接 / 导入文档" /></button></div>
        {!query && format === 'all' && documents.length > 0 && <section className="library-featured" aria-label={localizeSource(locale, sessions.length ? '继续上次的工作' : '可用文档')}><div className="library-section-head"><h2><LocalText source={sessions.length ? '继续上次的工作' : '可用文档'} /></h2><span><LocalText source="预览 · 编辑 · 协作" /></span></div><div className="featured-grid">{(sessions.length ? sessions.map(session => ({ id: session.documentId, title: session.title || session.documentId, format: session.format, mode: session.scope === 'read' ? '只读' : '可编辑' })) : documents).slice(0, 3).map(document => <button key={document.id} className="featured-document" onClick={() => openDocument(document.id)} disabled={opening !== null}>
          <div className={`document-art art-${document.format.toLowerCase()}`} aria-hidden="true"><FormatIcon format={document.format} size={32} /><span>{document.format.toUpperCase()}</span><i /><i /><i /></div>
          <div className="featured-document-info"><FormatIcon format={document.format} /><div><strong>{document.title}</strong><small><LocalText source={document.mode} /></small></div><ArrowRight size={16} /></div>
        </button>)}</div></section>}
        <div className="library-filterbar"><nav aria-label={localizeSource(locale, '文档格式筛选')}>{['all', 'docx', 'xlsx', 'pptx', 'pdf', 'md', 'html', 'txt', 'png', 'jpg', 'webp'].map(item => <button key={item} aria-pressed={format === item} onClick={() => setFormat(item)}>{item === 'all' ? localizeSource(locale, '全部') : item.toUpperCase()}</button>)}</nav><List size={18} /></div>
        <div className="library-document-list" role="table" aria-label={localizeSource(locale, '文档列表')}><div className="document-list-head" role="row"><span role="columnheader"><LocalText source="名称" /></span><span role="columnheader"><LocalText source="格式" /></span><span role="columnheader"><LocalText source="访问权限" /></span><span /></div>{filtered.map(document => <button role="row" className="library-document-row" key={document.id} onClick={() => openDocument(document.id)} disabled={opening !== null}><span role="cell"><FormatIcon format={document.format} /><strong>{document.title}</strong></span><span role="cell">{document.format.toUpperCase()}</span><span role="cell"><LocalText source={document.mode} /></span><ArrowRight size={16} /></button>)}</div>
        {!filtered.length && <div className="library-empty"><Files size={30} /><h2><LocalText source={query || format !== 'all' ? '没有找到匹配文档' : '在这里开始你的工作'} /></h2><p><LocalText source="连接已有文档，或导入 HCD 文件。" /></p><button onClick={showAccess}><LocalText source="连接文档" /></button></div>}
        <details className="document-access" id="document-access" open={accessOpen || !samples.length} onToggle={event => setAccessOpen(event.currentTarget.open)}><summary><Link2 size={16} /><LocalText source="连接文档 / 导入 HCD" /></summary><div className="access-forms">{children}</div></details>
        <footer className="library-footer"><span><Upload size={13} /><LocalText source="支持 DOCX、XLSX、PPTX、PDF、HTML、Markdown、TXT 和 PNG / JPEG / WebP" /></span><span>{filtered.length} <LocalText source="个文档" /></span></footer>
      </section>
    </div>
  </main>
}
