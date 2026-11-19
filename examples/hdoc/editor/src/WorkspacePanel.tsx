import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useI18n } from './i18n.tsx'
import { localizeSource } from './sourceLocale.tsx'
import './workspace-panels.css'

/** Shared docked surface. Each format supplies its own panel contents. */
export const WorkspacePanel = forwardRef<HTMLElement, HTMLAttributes<HTMLElement> & { side: 'left' | 'right' }>(function WorkspacePanel({ side, className = '', ...props }, ref) {
  return <aside {...props} ref={ref} data-panel-side={side} className={`workspace-panel ${side === 'left' ? 'outline-panel' : 'workspace-sidebar'} ${className}`} />
})

/** Flatten the controls into the editor's row without another layout owner. */
export function WorkspacePanelLayer({ children }: { children: ReactNode }) {
  return <div className="workspace-panel-layer">{children}</div>
}

export function WorkspacePanelControls({ side, open, onToggle, children }: {
  side: 'left' | 'right'; open: boolean; onToggle: () => void; children?: ReactNode
}) {
  const { locale } = useI18n()
  const label = side === 'left' ? open ? '收起左侧栏' : '展开左侧栏' : open ? '收起右侧栏' : '展开右侧栏'
  const Icon = side === 'left' ? open ? PanelLeftClose : PanelLeftOpen : open ? PanelRightClose : PanelRightOpen
  return <nav className={`workspace-panel-controls ${side}-panel-controls`} data-panel-open={open} aria-label={localizeSource(locale, side === 'left' ? '左侧面板工具' : '右侧面板工具')}>
    <button hidden={open} className={`sidebar-toggle ${side}-sidebar-toggle`} aria-label={localizeSource(locale, label)} title={localizeSource(locale, label)} aria-expanded={open} onClick={onToggle}><Icon size={18} /></button>
    {children}
  </nav>
}
