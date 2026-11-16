import type { Editor } from '@tiptap/core'
import './table-tools.css'

export type TableAction = 'insertRow' | 'deleteRow' | 'insertColumn' | 'deleteColumn'
export type TableActionDetail = { blockId: string; tableIndex: number; action: TableAction; index: number }
const HIDE_DELAY = 800

/** Logical grid addresses agree with the service, including merged cells. */
function address(table: HTMLTableElement, target: HTMLTableCellElement) {
  const occupied = new Set<string>()
  let found: { row: number; column: number } | undefined, width = 0
  const rows = [...table.rows].filter(row => row.closest('table') === table)
  rows.forEach((row, r) => {
    let c = 0
    for (const cell of [...row.cells]) {
      if (cell.dataset.hcdVMerge === 'continue' && cell.style.display === 'none') continue
      while (occupied.has(`${r}:${c}`)) c++
      if (cell === target) found = { row: r, column: c }
      for (let y = r; y < r + cell.rowSpan; y++) for (let x = c; x < c + cell.colSpan; x++) occupied.add(`${y}:${x}`)
      c += cell.colSpan; width = Math.max(width, c)
    }
  })
  return found && { ...found, rows: rows.length, columns: width }
}

/** Transient affordances live outside canonical content: no cell wrappers or selection boxes. */
export function tableStructureControls({ editor, doc, frame, host, blockId, onFocus, label }: {
  editor: Editor; doc: Document; frame: HTMLIFrameElement; host: HTMLElement;
  blockId: string; onFocus: () => void; label: (value: string) => string;
}) {
  // Keep the controls beside the frame so table edges at (0, 0) do not clip
  // them. Their containing block scrolls and zooms with the canonical table.
  const owner = host.ownerDocument
  const layer = owner.createElement('div')
  layer.dataset.hcdTableControls = ''
  layer.contentEditable = 'false'
  layer.hidden = true
  host.append(layer)
  let cell: HTMLTableCellElement | null = null, hideTimer: ReturnType<typeof setTimeout> | undefined
  let reach: { left: number; top: number; right: number; bottom: number } | undefined
  const button = (text: string, aria: string, className: string) => {
    const item = owner.createElement('button'); item.type = 'button'; item.className = className
    item.textContent = text; item.setAttribute('aria-label', label(aria)); item.title = label(aria)
    layer.append(item); return item
  }
  const row = button('+', '在下方插入行', 'table-plus'), column = button('+', '在右侧插入列', 'table-plus')
  row.dataset.hcdTableAxis = 'row'; column.dataset.hcdTableAxis = 'column'
  const trigger = button('⋯', '表格操作', 'table-menu-trigger')
  trigger.setAttribute('aria-expanded', 'false')
  const menu = owner.createElement('div'); menu.dataset.hcdTableMenu = ''; menu.hidden = true; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', label('表格操作')); layer.append(menu)
  const actions: Array<[string, TableAction, boolean]> = [
    ['在上方插入行', 'insertRow', false], ['在下方插入行', 'insertRow', true],
    ['在左侧插入列', 'insertColumn', false], ['在右侧插入列', 'insertColumn', true],
    ['删除当前行', 'deleteRow', false], ['删除当前列', 'deleteColumn', false],
  ]
  const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false') }
  const hold = () => { clearTimeout(hideTimer); hideTimer = undefined }
  const hide = () => { hold(); close(); layer.hidden = true }
  const scheduleHide = () => {
    // One timer per control group. Repeated pointerout events must not leave
    // older timers behind that can hide buttons after the pointer reaches them.
    if (hideTimer !== undefined || layer.hidden || !menu.hidden || layer.matches(':focus-within')) return
    hideTimer = setTimeout(() => {
      hideTimer = undefined
      if (menu.hidden && !layer.matches(':hover,:focus-within')) hide()
    }, HIDE_DELAY)
  }
  const execute = (action: TableAction, after: boolean) => {
    const table = cell?.closest('table'), at = table && cell && address(table, cell)
    if (!editor.isEditable || !cell || !table || !at) return
    const isRow = action.endsWith('Row')
    const index = (isRow ? at.row : at.column) + (after ? isRow ? cell.rowSpan : cell.colSpan : 0)
    const tableIndex = [...doc.querySelectorAll('.hcd-opaque-content table')].indexOf(table)
    hide()
    editor.view.dom.dispatchEvent(new CustomEvent<TableActionDetail>('hcd-table-action', { detail: { blockId, tableIndex, action, index } }))
  }
  for (const [text, action, after] of actions) {
    const item = owner.createElement('button'); item.type = 'button'; item.textContent = label(text)
    item.addEventListener('click', () => execute(action, after)); item.dataset.action = action; menu.append(item)
  }
  row.onclick = () => execute('insertRow', true); column.onclick = () => execute('insertColumn', true)
  const position = () => {
    if (!cell?.isConnected || !editor.isEditable) { hide(); return }
    const rect = cell.getBoundingClientRect(), tableRect = cell.closest('table')!.getBoundingClientRect()
    reach = { left: tableRect.left - 36, top: tableRect.top - 36, right: tableRect.right + 12, bottom: tableRect.bottom + 16 }
    // Frame-local CSS pixels share the host's coordinate system, including
    // canvas zoom. Never clamp negative edges into a cell's text area.
    const left = frame.offsetLeft + frame.clientLeft, top = frame.offsetTop + frame.clientTop
    row.style.left = `${left + tableRect.left - 26}px`; row.style.top = `${top + rect.bottom - 11}px`
    column.style.left = `${left + rect.right - 11}px`; column.style.top = `${top + tableRect.top - 26}px`
    trigger.style.left = `${left + tableRect.left - 26}px`; trigger.style.top = `${top + tableRect.top - 26}px`
    menu.style.left = `${Math.max(0, Math.min(host.clientWidth - 168, left + tableRect.left))}px`
    menu.style.top = `${top + tableRect.top + 2}px`
    layer.hidden = false
  }
  trigger.onclick = () => {
    const table = cell?.closest('table'), at = table && cell && address(table, cell)
    if (!at) return
    for (const item of menu.querySelectorAll<HTMLButtonElement>('button')) item.disabled = item.dataset.action === 'deleteRow' && at.rows <= 1 || item.dataset.action === 'deleteColumn' && at.columns <= 1
    menu.hidden = !menu.hidden; trigger.setAttribute('aria-expanded', String(!menu.hidden)); position()
  }
  const targetCell = (target: EventTarget | null) => target instanceof doc.defaultView!.Element ? (target as Element).closest<HTMLTableCellElement>('td,th') : null
  const show = (event: Event) => {
    const target = targetCell(event.target)
    if (!target || !editor.isEditable) return
    if (event.type === 'focusin' || event.type === 'pointerdown') onFocus()
    hold()
    // Moving to the corner menu crosses other cells in a long table. Keep its
    // target and actions stable until an explicit click, Escape or dismissal.
    if (!menu.hidden && event.type !== 'pointerdown') return
    if (cell === target && !layer.hidden) return
    if (cell !== target) close()
    cell = target
    owner.dispatchEvent(new CustomEvent('hcd-table-controls-active', { detail: layer }))
    position()
  }
  const leave = (event: MouseEvent) => {
    if (targetCell(event.relatedTarget) || layer.contains(event.relatedTarget as Node | null)) { hold(); return }
    scheduleHide()
  }
  const viewport = host.closest('.canvas-viewport')
  const follow = (event: PointerEvent) => {
    if (layer.hidden || !reach) return
    if (layer.contains(event.target as Node)) { hold(); return }
    let x = event.clientX, y = event.clientY
    if (event.currentTarget === owner) {
      if (viewport && !viewport.contains(event.target as Node)) { scheduleHide(); return }
      const rect = frame.getBoundingClientRect()
      const scale = rect.width / parseFloat(owner.defaultView!.getComputedStyle(frame).width)
      x = (x - rect.left) / scale; y = (y - rect.top) / scale
    }
    // Observe the empty top/left gutters without adding invisible elements
    // that intercept text editing. Crossing the iframe boundary stays safe.
    if (x >= reach.left && x <= reach.right && y >= reach.top && y <= reach.bottom) hold()
    else scheduleHide()
  }
  const outside = (event: Event) => { if (!layer.contains(event.target as Node) && !targetCell(event.target)) hide() }
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !layer.hidden) { hide(); cell?.querySelector<HTMLElement>('[contenteditable="plaintext-only"]')?.focus({ preventScroll: true }) } }
  const activate = () => { hold(); onFocus() }
  const otherTable = (event: Event) => { if ((event as CustomEvent).detail !== layer) hide() }
  const leaveOwner = (event: MouseEvent) => { if (!event.relatedTarget) scheduleHide() }
  layer.addEventListener('pointerover', hold); layer.addEventListener('focusin', hold); layer.addEventListener('pointerdown', activate)
  layer.addEventListener('pointerout', leave)
  doc.addEventListener('pointerover', show); doc.addEventListener('focusin', show); doc.addEventListener('pointerdown', show)
  doc.addEventListener('pointerout', leave); doc.addEventListener('pointerdown', outside); doc.addEventListener('keydown', keydown)
  doc.addEventListener('pointermove', follow); owner.addEventListener('pointermove', follow); owner.addEventListener('pointerout', leaveOwner)
  owner.addEventListener('pointerdown', outside); owner.addEventListener('keydown', keydown); owner.addEventListener('hcd-table-controls-active', otherTable)
  const sync = () => { if (!editor.isEditable) hide() }
  editor.on('transaction', sync)
  const observer = new ResizeObserver(() => { if (!layer.hidden) position() }); observer.observe(doc.querySelector('.hcd-opaque-content')!)
  return { destroy() {
    clearTimeout(hideTimer); observer.disconnect(); editor.off('transaction', sync)
    doc.removeEventListener('pointerover', show); doc.removeEventListener('focusin', show); doc.removeEventListener('pointerdown', show)
    doc.removeEventListener('pointerout', leave); doc.removeEventListener('pointerdown', outside); doc.removeEventListener('keydown', keydown)
    doc.removeEventListener('pointermove', follow); owner.removeEventListener('pointermove', follow); owner.removeEventListener('pointerout', leaveOwner)
    owner.removeEventListener('pointerdown', outside); owner.removeEventListener('keydown', keydown); owner.removeEventListener('hcd-table-controls-active', otherTable)
    layer.remove()
  } }
}
