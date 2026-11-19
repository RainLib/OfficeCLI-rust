import type { Editor } from '@tiptap/core'
import './table-tools.css'

export type TableAction = 'insertRow' | 'deleteRow' | 'insertColumn' | 'deleteColumn' | 'deleteTable'
export type TableActionDetail = { blockId: string; tableIndex: number } & (
  { action: TableAction; index: number } | { action: 'activateCell'; row: number; column: number }
)
type MenuScope = 'row' | 'column' | 'table'
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
  const rowMenu = button('⋮', '行操作', 'table-axis-trigger'), columnMenu = button('⋯', '列操作', 'table-axis-trigger')
  rowMenu.dataset.hcdTableHandle = 'row'; columnMenu.dataset.hcdTableHandle = 'column'
  const trigger = button('⋯', '表格操作', 'table-menu-trigger')
  const triggers = { row: rowMenu, column: columnMenu, table: trigger }
  const menu = owner.createElement('div'); menu.dataset.hcdTableMenu = ''; menu.id = `table-menu-${crypto.randomUUID()}`
  menu.hidden = true; menu.setAttribute('role', 'menu'); layer.append(menu)
  for (const item of Object.values(triggers)) {
    item.setAttribute('aria-expanded', 'false'); item.setAttribute('aria-haspopup', 'menu'); item.setAttribute('aria-controls', menu.id)
  }
  let scope: MenuScope = 'table'
  const actions: Array<[string, TableAction, boolean]> = [
    ['在上方插入行', 'insertRow', false], ['在下方插入行', 'insertRow', true],
    ['在左侧插入列', 'insertColumn', false], ['在右侧插入列', 'insertColumn', true],
    ['删除当前行', 'deleteRow', false], ['删除当前列', 'deleteColumn', false],
    ['删除表格', 'deleteTable', false],
  ]
  const close = () => { menu.hidden = true; for (const item of Object.values(triggers)) item.setAttribute('aria-expanded', 'false') }
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
    // The action button is about to disappear. Keep keyboard undo on the
    // editor without moving the canvas to its old text selection.
    editor.view.dom.focus({ preventScroll: true })
    editor.view.dom.dispatchEvent(new CustomEvent<TableActionDetail>('hcd-table-action', { detail: { blockId, tableIndex, action, index } }))
  }
  row.onclick = () => execute('insertRow', true); column.onclick = () => execute('insertColumn', true)
  const viewport = host.closest('.canvas-viewport')
  const position = () => {
    if (!cell?.isConnected || !editor.isEditable) { hide(); return }
    const rect = cell.getBoundingClientRect(), tableRect = cell.closest('table')!.getBoundingClientRect()
    reach = { left: tableRect.left - 56, top: tableRect.top - 56, right: tableRect.right + 12, bottom: tableRect.bottom + 16 }
    // Frame-local CSS pixels share the host's coordinate system, including
    // canvas zoom. Never clamp negative edges into a cell's text area.
    const left = frame.offsetLeft + frame.clientLeft, top = frame.offsetTop + frame.clientTop
    const frameRect = frame.getBoundingClientRect(), scale = frameRect.width / parseFloat(owner.defaultView!.getComputedStyle(frame).width)
    const viewportRect = viewport?.getBoundingClientRect()
    const visibleTop = viewportRect ? (viewportRect.top - frameRect.top) / scale : tableRect.top - 56
    const visibleBottom = viewportRect ? (viewportRect.bottom - frameRect.top) / scale : tableRect.bottom + 24
    const menuHeight = menu.hidden ? 0 : menu.offsetHeight, hostWidth = host.clientWidth
    // A long table's column controls follow its visible top. Opening a menu
    // must never scroll back to the first row just to reach a corner button.
    const headerTop = Math.min(tableRect.bottom - 22, Math.max(tableRect.top - 26, visibleTop + 30))
    row.style.left = `${left + tableRect.left - 50}px`; row.style.top = `${top + Math.min(rect.bottom - 11, visibleBottom - 24)}px`
    rowMenu.style.left = `${left + tableRect.left - 26}px`; rowMenu.style.top = `${top + Math.max(visibleTop + 6, Math.min((rect.top + rect.bottom) / 2 - 11, visibleBottom - 24))}px`
    column.style.left = `${left + rect.right - 11}px`; column.style.top = `${top + headerTop - 24}px`
    columnMenu.style.left = `${left + Math.max(tableRect.left, (rect.left + rect.right) / 2 - 11)}px`; columnMenu.style.top = `${top + headerTop}px`
    trigger.style.left = `${left + tableRect.left - 26}px`; trigger.style.top = `${top + headerTop}px`
    const anchor = triggers[scope]
    menu.style.left = `${Math.max(0, Math.min(hostWidth - 200, parseFloat(anchor.style.left) + (scope === 'row' ? 26 : 0)))}px`
    menu.style.top = `${top + Math.max(visibleTop + 6, Math.min(parseFloat(anchor.style.top) - top + 26, visibleBottom - menuHeight - 8))}px`
    layer.hidden = false
  }
  const open = (next: MenuScope) => {
    const table = cell?.closest('table'), at = table && cell && address(table, cell)
    if (!editor.isEditable || !table || !at) return
    const wasOpen = !menu.hidden && scope === next
    close(); if (wasOpen) return
    scope = next; menu.replaceChildren()
    const title = owner.createElement('div'); title.className = 'table-menu-title'
    title.textContent = `${label(next === 'row' ? '行操作' : next === 'column' ? '列操作' : '表格操作')}${next === 'table' ? '' : ` · ${next === 'row' ? at.row + 1 : at.column + 1}`}`
    menu.setAttribute('aria-label', title.textContent); menu.append(title)
    for (const [text, action, after] of actions) {
      if (next !== 'table' && !action.endsWith(next === 'row' ? 'Row' : 'Column')) continue
      const item = owner.createElement('button'); item.type = 'button'; item.textContent = label(text); item.setAttribute('role', 'menuitem')
      item.disabled = action === 'deleteRow' && at.rows <= 1 || action === 'deleteColumn' && at.columns <= 1
        || action === 'deleteTable' && (!!table.parentElement?.closest('table') || [...doc.querySelectorAll('.hcd-opaque-content table')].filter(value => !value.parentElement?.closest('table')).length !== 1)
      if (action === 'deleteRow' && at.rows <= 1 || action === 'deleteColumn' && at.columns <= 1) item.title = label('保留最后一行或一列；可通过表格操作删除整表。')
      if (action.startsWith('delete')) item.className = 'table-delete-action'
      if (action === 'deleteTable') item.classList.add('table-delete-all')
      item.addEventListener('click', () => execute(action, after)); item.dataset.action = action; menu.append(item)
    }
    menu.hidden = false; triggers[next].setAttribute('aria-expanded', 'true'); position()
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }
  for (const [next, item] of Object.entries(triggers)) item.onclick = () => open(next as MenuScope)
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
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !layer.hidden) {
      event.preventDefault(); event.stopPropagation()
      if (!menu.hidden) { close(); triggers[scope].focus({ preventScroll: true }) }
      else { hide(); cell?.querySelector<HTMLElement>('[contenteditable="plaintext-only"]')?.focus({ preventScroll: true }) }
    } else if (!menu.hidden && menu.contains(event.target as Node) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const current = items.indexOf(owner.activeElement as HTMLButtonElement)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[index]?.focus({ preventScroll: true })
    } else if (event.key === 'Tab' && !menu.hidden) close()
  }
  const activate = () => { hold(); onFocus() }
  const otherTable = (event: Event) => { if ((event as CustomEvent).detail !== layer) hide() }
  const leaveOwner = (event: MouseEvent) => { if (!event.relatedTarget) scheduleHide() }
  layer.addEventListener('pointerover', hold); layer.addEventListener('focusin', hold); layer.addEventListener('pointerdown', activate)
  layer.addEventListener('pointerout', leave)
  doc.addEventListener('pointerover', show); doc.addEventListener('focusin', show); doc.addEventListener('pointerdown', show)
  doc.addEventListener('pointerout', leave); doc.addEventListener('pointerdown', outside); doc.addEventListener('keydown', keydown)
  doc.addEventListener('pointermove', follow); owner.addEventListener('pointermove', follow); owner.addEventListener('pointerout', leaveOwner)
  owner.addEventListener('pointerdown', outside); owner.addEventListener('keydown', keydown); owner.addEventListener('hcd-table-controls-active', otherTable)
  const blankButtons: HTMLButtonElement[] = []
  if (doc.body.dataset.hcdSourceFormat === 'docx') {
    const tables = [...doc.querySelectorAll('table')]
    for (const [tableIndex, table] of tables.entries()) {
      if (table.hasAttribute('data-hcd-continuation') || table.hasAttribute('data-hcd-table-fragment')) continue
      for (const row of table.rows) for (const cell of row.cells) {
        if (cell.rowSpan !== 1 || cell.colSpan !== 1 || cell.textContent?.trim()
          || cell.querySelector('[data-hcd-node-hash], img, svg, table, object')) continue
        const paragraph = cell.querySelector('p.hcd-empty-paragraph')
        if (!paragraph) continue
        const item = doc.createElement('button')
        item.type = 'button'; item.textContent = '+'; item.className = 'hcd-empty-cell-edit'
        item.setAttribute('aria-label', label('编辑空白单元格')); item.title = label('编辑空白单元格')
        item.style.cssText = 'border:0;background:transparent;color:#385983;cursor:pointer'
        item.addEventListener('click', () => {
          if (!editor.isEditable) return
          const selected = address(table, cell)
          if (selected) editor.view.dom.dispatchEvent(new CustomEvent<TableActionDetail>('hcd-table-action', {
            detail: { blockId, tableIndex, action: 'activateCell', row: selected.row, column: selected.column },
          }))
        })
        paragraph.append(item)
        blankButtons.push(item)
      }
    }
  }
  const sync = () => {
    for (const button of blankButtons) button.hidden = !editor.isEditable
    if (!editor.isEditable) hide()
  }
  sync()
  editor.on('transaction', sync); editor.on('update', sync)
  let scrollFrame: number | undefined
  const scroll = () => { if (!layer.hidden && scrollFrame === undefined) scrollFrame = owner.defaultView!.requestAnimationFrame(() => { scrollFrame = undefined; position() }) }
  viewport?.addEventListener('scroll', scroll, { passive: true })
  const observer = new ResizeObserver(() => { if (!layer.hidden) position() }); observer.observe(doc.querySelector('.hcd-opaque-content')!)
  return { destroy() {
    clearTimeout(hideTimer); if (scrollFrame !== undefined) owner.defaultView!.cancelAnimationFrame(scrollFrame)
    viewport?.removeEventListener('scroll', scroll); observer.disconnect(); editor.off('transaction', sync); editor.off('update', sync); blankButtons.forEach(button => button.remove())
    doc.removeEventListener('pointerover', show); doc.removeEventListener('focusin', show); doc.removeEventListener('pointerdown', show)
    doc.removeEventListener('pointerout', leave); doc.removeEventListener('pointerdown', outside); doc.removeEventListener('keydown', keydown)
    doc.removeEventListener('pointermove', follow); owner.removeEventListener('pointermove', follow); owner.removeEventListener('pointerout', leaveOwner)
    owner.removeEventListener('pointerdown', outside); owner.removeEventListener('keydown', keydown); owner.removeEventListener('hcd-table-controls-active', otherTable)
    layer.remove()
  } }
}
