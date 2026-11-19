import { useEffect, useRef, useState } from 'react'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'

export function WordTableDialog({ onCancel, onInsert }: {
  onCancel: () => void
  onInsert: (rows: number, columns: number) => void
}) {
  const { locale } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const [rows, setRows] = useState('3')
  const [columns, setColumns] = useState('3')
  const count = Number(rows) * Number(columns)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="hcd-dialog hcd-table-dialog" aria-label={localizeSource(locale, '插入表格')}
    onCancel={event => { event.preventDefault(); onCancel() }}>
    <form onSubmit={event => { event.preventDefault(); if (count <= 1024) onInsert(Number(rows), Number(columns)) }}>
      <h2><LocalText source="插入表格" /></h2>
      <div className="hcd-table-dimensions">
        <label><LocalText source="行数" /><input autoFocus type="number" required min={1} max={256} value={rows} onChange={event => setRows(event.target.value)} /></label>
        <label><LocalText source="列数" /><input type="number" required min={1} max={64} value={columns} onChange={event => setColumns(event.target.value)} /></label>
      </div>
      {count > 1024 && <p role="alert"><LocalText source="新表格最多支持 1024 个单元格。" /></p>}
      <div className="hcd-dialog-actions">
        <button type="button" onClick={onCancel}><LocalText source="取消" /></button>
        <button className="primary" disabled={count > 1024}><LocalText source="插入" /></button>
      </div>
    </form>
  </dialog>
}
