import { useEffect, useRef, useState } from 'react'
import { FloatingLayer } from './FloatingLayer.tsx'
import { Table2 } from 'lucide-react'
import { useI18n } from './i18n.tsx'
import { localizeSource, LocalText } from './sourceLocale.tsx'
import './table-tools.css'

export function InsertTable({ disabled, onPrepare, onInsert }: { disabled: boolean; onPrepare: () => void; onInsert: (rows: number, columns: number) => void }) {
  const { locale } = useI18n()
  const [open, setOpen] = useState(false), [rows, setRows] = useState(3), [columns, setColumns] = useState(3)
  const root = useRef<HTMLDivElement>(null), popup = useRef<HTMLElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); root.current?.querySelector('button')?.focus() } }
    const place = () => { const rect = root.current?.getBoundingClientRect(); if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 340)) }) }; place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key) }
  }, [open])
  const insert = (r: number, c: number) => { setOpen(false); onInsert(r, c) }
  return <div className="insert-table-tool" ref={root}>
    <button disabled={disabled} aria-expanded={open} aria-haspopup="dialog" onMouseDown={event => { event.preventDefault(); onPrepare() }} onClick={() => { if (!open) onPrepare(); setOpen(!open) }}><Table2 size={15} /><LocalText source="插入表格" /></button>
    {open && !disabled && <FloatingLayer><section ref={popup} style={position} className="insert-table-popover" role="dialog" aria-label={localizeSource(locale, '插入表格')}>
      <strong><LocalText source="插入表格" /></strong><span className="insert-table-size">{rows} × {columns}</span>
      <div className="insert-table-grid">{Array.from({ length: 48 }, (_, i) => { const r = Math.floor(i / 8) + 1, c = i % 8 + 1; return <button key={i} className={r <= rows && c <= columns ? 'chosen' : ''} aria-label={`${r} ${localizeSource(locale, '行')} × ${c} ${localizeSource(locale, '列')}`} onMouseEnter={() => { setRows(r); setColumns(c) }} onFocus={() => { setRows(r); setColumns(c) }} onClick={() => insert(r, c)} /> })}</div>
      <div className="insert-table-dimensions"><label><LocalText source="行数" /><input type="number" min={1} max={1000} value={rows} onChange={event => setRows(Number(event.target.value))} /></label><label><LocalText source="列数" /><input type="number" min={1} max={128} value={columns} onChange={event => setColumns(Number(event.target.value))} /></label></div>
      <button className="primary" disabled={!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows > 1000 || columns > 128 || rows * columns > 10000} onClick={() => insert(rows, columns)}><LocalText source="插入" /></button>
    </section></FloatingLayer>}
  </div>
}
