import { Children, Fragment, cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode, type MouseEventHandler } from 'react'
import { createPortal } from 'react-dom'
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignStartVertical, AlignEndVertical, ArrowDown, ArrowUp, Bold, Check, ChevronDown, ChevronUp, Columns3, Copy, FilePlus2, FolderOpen, Grid2X2, History, Image, Italic, Link, List, ListOrdered, Maximize2, MessageSquarePlus, MoreHorizontal, PaintBucket, PanelLeft, Play, Plus, Redo2, RotateCcw, Rows3, Save, Settings2, Snowflake, Sparkles, Square, Strikethrough, Table2, Trash2, Type, Underline, Undo2, WrapText, X, type LucideIcon } from 'lucide-react'
import { useI18n } from './i18n'
import { localizeSource } from './sourceLocale'
import { useDocumentViewState } from './DocumentViewState'
import './office-ribbon.css'

export function RibbonButton({ icon: Icon, label, iconOnly = false, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; iconOnly?: boolean }) {
  return <button type="button" {...props} className={`ribbon-command ${iconOnly ? 'ribbon-icon-command' : ''} ${className}`} aria-label={props['aria-label'] || label} title={props.title || label}
    onMouseDown={event => { props.onMouseDown?.(event); if (!event.defaultPrevented) event.preventDefault() }}>
    <Icon size={17} aria-hidden="true"/><span className="ribbon-command-label">{children || label}</span>
  </button>
}

export function RibbonGroup({ label, priority = 1, children, className = '', ...props }: { label: string; priority?: number; children: ReactNode; className?: string; onMouseDown?: MouseEventHandler<HTMLDivElement> }) {
  const { locale } = useI18n()
  return <div {...props} className={`ribbon-group ${className}`} role="group" aria-label={localizeSource(locale, label)} data-priority={priority}>
    <div className="ribbon-group-controls">{decorateCommands(children, locale)}</div><span className="ribbon-group-caption">{localizeSource(locale, label)}</span>
  </div>
}

type CommandProps = { size?: number; children?: ReactNode; source?: string; className?: string; title?: string; 'aria-label'?: string; onMouseDown?: MouseEventHandler<HTMLDivElement> }
function sourceText(node: ReactNode): string {
  return Children.toArray(node).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    if (!isValidElement<CommandProps>(child)) return ''
    return child.props.source || child.props['aria-label'] || sourceText(child.props.children)
  }).join('')
}
type Descriptor = { label: string; icon: LucideIcon; group: string; priority: number; short?: boolean }
function describe(source: string): Descriptor {
  const label = source.replace(/^[↶↷𝐁𝑰＋+\s]+/u, '').trim()
  const result = (icon: LucideIcon, group: string, priority = 1, short = false) => ({ label, icon, group, priority, short })
  if (/撤销|重做/.test(label)) return result(/重做/.test(label) ? Redo2 : Undo2, '撤销与重做', 2, true)
  if (/^应用(字号|颜色|填充|数字格式)$/.test(label)) return result(Check, /填充/.test(label) ? '单元格外观' : /数字/.test(label) ? '数字' : '字体', 0, true)
  if (/字号|文字颜色|应用颜色|^颜色|^字体|主题字体/.test(label)) return result(Type, '字体', 0)
  if (/加粗|斜体|下划线|删除线/.test(label)) return result(/加粗/.test(label) ? Bold : /斜体/.test(label) ? Italic : /删除线/.test(label) ? Strikethrough : Underline, '字体', 0, true)
  if (/对齐|居中|自动换行/.test(label)) return result(/左/.test(label) ? AlignLeft : /右/.test(label) ? AlignRight : /两端|分散/.test(label) ? AlignJustify : /顶/.test(label) ? AlignStartVertical : /底/.test(label) ? AlignEndVertical : /垂直/.test(label) ? AlignVerticalJustifyCenter : /换行/.test(label) ? WrapText : AlignCenter, '对齐方式', 0, true)
  if (/填充|框线/.test(label)) return result(/框线/.test(label) ? Grid2X2 : PaintBucket, '单元格外观')
  if (/数字格式|格式代码/.test(label)) return result(Type, '数字')
  if (/工作表名|工作表/.test(label)) return result(/删除/.test(label) ? Trash2 : /新增/.test(label) ? Plus : Table2, '工作表')
  if (/冻结/.test(label)) return result(Snowflake, '冻结窗格')
  if (/列宽|行高/.test(label)) return result(/列宽/.test(label) ? Columns3 : Rows3, '单元格大小')
  if (/合并|拆分/.test(label)) return result(Grid2X2, '合并与拆分')
  if (/选中行|末尾.*行|插入行数|末尾空行/.test(label)) return result(/删除|撤销/.test(label) ? Trash2 : Rows3, '行')
  if (/选中列/.test(label)) return result(/删除/.test(label) ? Trash2 : Columns3, '列')
  if (/批注|审阅/.test(label)) return result(MessageSquarePlus, '批注')
  if (/正文|标题/.test(label)) return result(Type, '样式')
  if (/编号|项目符号|列表|段落上移|段落下移/.test(label)) return result(/编号/.test(label) ? ListOrdered : /上移/.test(label) ? ArrowUp : /下移/.test(label) ? ArrowDown : List, '段落')
  if (/图片/.test(label)) return result(Image, '图片')
  if (/幻灯片|页面/.test(label)) return result(/复制/.test(label) ? Copy : /删除/.test(label) ? Trash2 : /上移/.test(label) ? ArrowUp : /下移/.test(label) ? ArrowDown : /旋转/.test(label) ? RotateCcw : FilePlus2, '页面')
  if (/图层/.test(label)) return result(Image, '图层')
  if (/裁剪|旋转|涂抹|擦除|光线|色彩/.test(label)) return result(Image, '调整')
  if (/适合窗口|原始大小/.test(label)) return result(Maximize2, '缩放')
  if (/AI 修图|局部重绘/.test(label)) return result(Sparkles, 'AI')
  if (/母版|背景/.test(label)) return result(PaintBucket, '设计')
  if (/播放|放映/.test(label)) return result(Play, '放映')
  if (/动画/.test(label)) return result(Sparkles, '动画')
  if (/链接|引用|白板/.test(label)) return result(Link, '链接与引用')
  if (/修订|版本/.test(label)) return result(History, '版本')
  if (/保存/.test(label)) return result(Save, '保存', -1, true)
  if (/大纲|导航/.test(label)) return result(PanelLeft, '导航')
  if (/设置/.test(label)) return result(Settings2, '视图')
  if (/新增|插入/.test(label)) return result(Plus, '插入')
  if (/删除/.test(label)) return result(Trash2, '编辑')
  if (/应用/.test(label)) return result(Check, '格式')
  return result(/打开|查看/.test(label) ? FolderOpen : /缩放/.test(label) ? Maximize2 : Square, '工具', 2)
}

function decorateCommands(children: ReactNode, locale: ReturnType<typeof useI18n>['locale']): ReactNode {
  return Children.map(children, node => {
    if (!isValidElement<CommandProps>(node)) return node
    if (node.type === Fragment) return cloneElement(node, {}, decorateCommands(node.props.children, locale))
    if (node.type !== 'button' || node.props.className?.includes('ribbon-command')) return node
    const original = node as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>
    const description = describe(sourceText(node) || original.props['aria-label'] || original.props.title || '')
    if (!description.label) return node
    const Icon = description.icon
    const existingIcon = Children.toArray(original.props.children).find(child => isValidElement<CommandProps>(child)
      && (child.type === 'svg' || typeof child.type === 'object' || typeof child.props.size === 'number'))
    return cloneElement(original, {
      className: `ribbon-command ${description.short ? 'ribbon-icon-command' : ''} ${original.props.className || ''}`,
      'aria-label': original.props['aria-label'] || localizeSource(locale, description.label), title: original.props.title || localizeSource(locale, description.label),
      onMouseDown: event => { original.props.onMouseDown?.(event); if (!event.defaultPrevented && event.button === 0) event.preventDefault() },
    }, <>{existingIcon || <Icon size={17} aria-hidden="true"/>}<span className="ribbon-command-label">{localizeSource(locale, description.label)}</span></>)
  })
}

type Section = { key: string; priority: number; content: ReactNode }
/** Keep each command's original handler and capability checks. */
function sections(children: ReactNode, locale: ReturnType<typeof useI18n>['locale']): Section[] {
  const output: Section[] = []
  function visit(nodes: ReactNode, prefix = '', mouseDown?: MouseEventHandler<HTMLDivElement>) {
    let pending: { name: string; priority: number; items: ReactNode[]; key: string } | undefined
    const flush = () => {
      if (!pending) return
      output.push({ key: pending.key, priority: pending.priority, content: <RibbonGroup label={pending.name} priority={pending.priority} onMouseDown={mouseDown}>{pending.items}</RibbonGroup> })
      pending = undefined
    }
    Children.toArray(nodes).forEach((node, index) => {
      const key = `${prefix}/${isValidElement(node) && node.key !== null ? node.key : index}`
      if (!isValidElement<CommandProps>(node)) { if (node) { flush(); output.push({ key, priority: 3, content: node }) }; return }
      if (node.type === 'div' && node.props.className?.split(' ').includes('slide-command-group')) {
        flush()
        const text = sourceText(node)
        const label = node.props['aria-label'] || (/新增文字框|插入图片|取消放置/.test(text) ? '插入' : /上移一页|下移一页/.test(text) ? '顺序' : '幻灯片')
        output.push({ key, priority: 1, content: <RibbonGroup label={label}>{node.props.children}</RibbonGroup> })
        return
      }
      if (node.type === Fragment || node.type === 'div' && node.props.className?.split(' ').includes('tool-group')) {
        flush(); visit(node.props.children, key, node.props.onMouseDown || mouseDown); return
      }
      if (node.type === RibbonGroup) {
        flush(); output.push({ key, priority: (node as ReactElement<{ priority?: number }>).props.priority ?? 1, content: node }); return
      }
      const description = describe(sourceText(node))
      let content: ReactNode = node
      if (node.type === 'button') content = decorateCommands(node, locale)
      if (typeof node.type !== 'string') {
        flush(); output.push({ key, priority: description.priority, content: <RibbonGroup label={description.group}>{content}</RibbonGroup> }); return
      }
      if (!pending || pending.name !== description.group || pending.items.length >= 5) { flush(); pending = { name: description.group, priority: description.priority, items: [], key } }
      pending.items.push(<Fragment key={key}>{content}</Fragment>)
    })
    flush()
  }
  visit(children)
  return output
}

function RibbonSection({ content, slot, expanded, menu, measure, onMeasure, onHideFocus }: { content: ReactNode; slot: 'inline' | 'menu' | 'hidden'; expanded: boolean; menu: HTMLDivElement | null; measure: HTMLDivElement | null; onMeasure: (width: number) => void; onHideFocus: () => void }) {
  const inline = useRef<HTMLDivElement>(null)
  const [host] = useState(() => { const element = document.createElement('div'); element.className = 'ribbon-section-host'; return element })
  useLayoutEffect(() => {
    const target = slot === 'inline' ? inline.current : slot === 'menu' ? menu : measure
    const active = host.contains(document.activeElement) ? document.activeElement as HTMLElement : null
    if (target && host.parentNode !== target) target.appendChild(host)
    host.dataset.placement = slot
    host.dataset.expanded = String(expanded && slot === 'inline')
    host.inert = slot === 'hidden'
    host.setAttribute('aria-hidden', String(slot === 'hidden'))
    if (active) { if (slot === 'hidden') onHideFocus(); else active.focus({ preventScroll: true }) }
  }, [host, slot, expanded, menu, measure, onHideFocus])
  useLayoutEffect(() => {
    const update = () => { if (!expanded && slot !== 'menu') onMeasure(Math.ceil(host.getBoundingClientRect().width)) }
    const observer = new ResizeObserver(update)
    observer.observe(host); update()
    return () => observer.disconnect()
  }, [host, expanded, slot, onMeasure])
  useLayoutEffect(() => () => host.remove(), [host])
  return <><div className="ribbon-section-slot" ref={inline} hidden={slot !== 'inline'}/>{createPortal(content, host)}</>
}

export function DocumentRibbon({ adaptive: _adaptive, label, children }: { adaptive: boolean; label: string; children: ReactNode }) {
  const { locale } = useI18n()
  const { ribbonExpanded: expanded, setRibbonExpanded: setExpanded } = useDocumentViewState()
  const groups = useMemo(() => sections(children, locale), [children, locale])
  const [widths, setWidths] = useState<Record<string, number>>({}), [available, setAvailable] = useState(0), [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<HTMLDivElement | null>(null), [measure, setMeasure] = useState<HTMLDivElement | null>(null)
  const row = useRef<HTMLDivElement>(null), more = useRef<HTMLButtonElement>(null)
  const onHideFocus = useCallback(() => more.current?.focus({ preventScroll: true }), [])
  const id = useId()
  const updateWidth = useCallback((key: string, width: number) => setWidths(previous => previous[key] === width || width < 1 ? previous : { ...previous, [key]: width }), [])
  const reporters = useMemo(() => Object.fromEntries(groups.map(group => [group.key, (width: number) => updateWidth(group.key, width)])), [groups, updateWidth])
  const visible = useMemo(() => {
    const chosen = new Set<string>(); let space = available
    for (const group of [...groups].sort((a, b) => a.priority - b.priority)) {
      const width = widths[group.key] ?? 10000
      if (width + 5 <= space) { chosen.add(group.key); space -= width + 5 }
    }
    return chosen
  }, [groups, available, widths])
  const overflow = !expanded && visible.size < groups.length
  useLayoutEffect(() => {
    if (!row.current) return
    const observer = new ResizeObserver(() => setAvailable(row.current?.clientWidth ?? 0))
    observer.observe(row.current); setAvailable(row.current.clientWidth)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (!menu) return
    if (!open || !overflow) { if (menu.matches(':popover-open')) menu.hidePopover(); return }
    menu.showPopover()
    const position = () => {
      const anchor = more.current?.getBoundingClientRect()
      if (!anchor) return
      const width = Math.min(560, window.innerWidth - 24)
      menu.style.width = `${width}px`
      menu.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`
      menu.style.top = `${Math.min(anchor.bottom + 8, Math.max(12, window.innerHeight - menu.offsetHeight - 12))}px`
    }
    position(); window.addEventListener('resize', position); window.addEventListener('scroll', position, true)
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node) && !more.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); document.removeEventListener('pointerdown', outside) }
  }, [menu, open, overflow])
  useEffect(() => { if (!overflow) setOpen(false) }, [overflow])
  useEffect(() => {
    if (!open || !row.current) return
    // Warm tabs stay mounted. A top-layer popover must close when its owning
    // document becomes hidden/inert, including keyboard-driven tab switches.
    const ancestors: HTMLElement[] = []
    for (let node = row.current.parentElement; node; node = node.parentElement) ancestors.push(node)
    const observer = new MutationObserver(() => {
      if (ancestors.some(node => node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') || !row.current?.getClientRects().length) setOpen(false)
    })
    for (const node of ancestors) observer.observe(node, { attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'class'] })
    return () => observer.disconnect()
  }, [open])
  const close = () => { setOpen(false); more.current?.focus() }
  return <nav className="toolbar ribbon document-ribbon office-ribbon" aria-label={label} data-expanded={expanded} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); close() }
  }}>
    <div ref={row} className="ribbon-sections">{groups.map(group => <RibbonSection key={group.key} content={group.content} expanded={expanded} slot={expanded || visible.has(group.key) ? 'inline' : open ? 'menu' : 'hidden'} menu={menu} measure={measure} onMeasure={reporters[group.key]} onHideFocus={onHideFocus}/>)}</div>
    <div className="ribbon-density-controls">
      {overflow && <button ref={more} type="button" className="ribbon-more" onMouseDown={event => event.preventDefault()} aria-label={localizeSource(locale, '更多命令')} title={localizeSource(locale, '更多命令')} aria-controls={id} aria-expanded={open} onClick={() => setOpen(value => !value)}><MoreHorizontal size={18}/></button>}
      <button type="button" className="ribbon-expand" onMouseDown={event => event.preventDefault()} aria-label={localizeSource(locale, expanded ? '收起功能区' : '展开功能区')} title={localizeSource(locale, expanded ? '收起功能区' : '展开功能区')} aria-expanded={expanded} onClick={() => { setOpen(false); setExpanded(value => !value) }}>{expanded ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}</button>
    </div>
    <div ref={setMeasure} className="ribbon-measure-bin" aria-hidden="true" inert/>
    <div ref={setMenu} id={id} popover="manual" className="ribbon-more-panel" role="region" aria-label={localizeSource(locale, '更多命令')} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
      <div className="ribbon-more-heading"><strong>{localizeSource(locale, '更多命令')}</strong><button type="button" aria-label={localizeSource(locale, '关闭更多命令')} onClick={close}><X size={16}/></button></div>
    </div>
  </nav>
}
