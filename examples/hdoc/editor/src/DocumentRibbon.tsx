import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useI18n } from './i18n'
import { localizeSource } from './sourceLocale'

export function DocumentRibbon({ adaptive, label, children }: { adaptive: boolean; label: string; children: ReactNode }) {
  const { locale } = useI18n()
  const items = useRef<HTMLDivElement>(null), row = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const [overflow, setOverflow] = useState(false), [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    const list = items.current, clip = row.current
    if (!list || !clip) return
    function fit() {
      if (!list || !clip || !list.offsetWidth) return
      const controls = [...list.children].flatMap(group =>
        getComputedStyle(group).display === 'contents' ? [...group.children] : [group]
      ).filter((el): el is HTMLElement => el instanceof HTMLElement && el.offsetWidth > 0)
      const width = controls.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0)
      const gap = parseFloat(getComputedStyle(list).columnGap) || 0
      const more = width + Math.max(0, controls.length-1)*gap > clip.clientWidth + (toggle.current?.offsetWidth || 0) + .5
      setOverflow(more)
      if (!more) setExpanded(false)
      const first = controls[0]?.getBoundingClientRect()
      if (!first) return
      let bottom = first.bottom
      for (const control of controls) {
        const rect = control.getBoundingClientRect()
        const rest = rect.top >= first.bottom - 1
        if (!rest) bottom = Math.max(bottom, rect.bottom)
        control.toggleAttribute('data-extra-command', rest)
        if (rest && !expanded && control.contains(document.activeElement)) toggle.current?.focus()
      }
      clip.style.setProperty('--command-row-height', Math.ceil(bottom - list.getBoundingClientRect().top) + 'px')
    }
    const size = new ResizeObserver(fit), content = new MutationObserver(fit)
    size.observe(clip); size.observe(list)
    content.observe(list, { childList:true, characterData:true, subtree:true })
    fit()
    return () => { size.disconnect(); content.disconnect() }
  }, [adaptive, expanded])
  if (!adaptive) return <nav className="toolbar ribbon" aria-label={label}>{children}</nav>
  const name = localizeSource(locale, expanded ? '收起更多命令' : '展开更多命令')
  return <nav className="toolbar ribbon document-ribbon" aria-label={label} data-expanded={expanded} onKeyDown={e=>{
    if (expanded && e.key === 'Escape') { e.stopPropagation(); setExpanded(false); toggle.current?.focus() }
  }}>
    <div className="command-clip" ref={row}><div className="command-rows" ref={items}>{children}</div></div>
    {overflow && <button ref={toggle} className="command-overflow" aria-label={name} title={name} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
      {expanded ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
    </button>}
  </nav>
}
