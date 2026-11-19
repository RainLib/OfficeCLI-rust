import { api, type Session } from './api.ts'
import { inlineTableEditing } from './inlineTableEditing.ts'
import { HcdOpaque, type Projection } from './schema.ts'

export type WordTableAction = 'insertRow' | 'deleteRow' | 'insertColumn' | 'deleteColumn'
export type WordTableCommand = { blockId: string } & (
  { op: 'table.edit'; action: WordTableAction; index: number }
  | { op: 'table.cell.activate'; row: number; column: number }
)
export type WordTableFocus = { nodeId: string; firstCell: boolean }

export function wordTableView(session: Session, label: (text: string) => string, focus: { current: WordTableFocus | null }) {
  let source: Promise<{ projection: Projection; styles: string }> | undefined
  const load = () => {
    source ??= Promise.all([
      api(session, '/editor').then(response => response.json() as Promise<Projection>),
      api(session, '/styles').then(response => response.text()),
    ]).then(([projection, styles]) => ({ projection, styles })).catch(error => { source = undefined; throw error })
    return source
  }
  return HcdOpaque.extend({
    addNodeView() {
      return ({ editor, node: initial, getPos }) => {
        let node = initial
        const dom = document.createElement('div')
        dom.className = 'hcd-opaque'
        dom.contentEditable = 'false'
        if (!node.attrs.hcdTable) {
          dom.textContent = node.attrs.preview || '▣'
          return { dom }
        }
        dom.classList.add('hcd-word-table')
        dom.setAttribute('aria-busy', 'true')
        const frame = document.createElement('iframe')
        frame.title = label('文档表格')
        frame.setAttribute('sandbox', 'allow-same-origin')
        frame.referrerPolicy = 'no-referrer'
        dom.append(frame)
        const urls: string[] = []
        const abort = new AbortController()
        let editing: ReturnType<typeof inlineTableEditing> | undefined
        let resize: ResizeObserver | undefined
        let releaseControls: (() => void) | undefined
        frame.onload = async () => {
          const doc = frame.contentDocument
          if (!doc?.getElementById('word-table')) return
          try {
            const { projection, styles } = await load()
            const block = projection.blocks.find(block => block.blockId === node.attrs.hcdBlockId)
            if (!block?.readOnlyHtml) throw new Error(label('表格加载失败'))
            let html = block.readOnlyHtml
            const hashes = Array.from(new Set(Array.from(html.matchAll(/asset:\/\/sha256\/([a-f0-9]{64})/g), match => match[1])))
            for (const hash of hashes.slice(0, 32)) {
              const blob = await (await api(session, `/assets/${hash}?revision=${projection.revision}`, { signal: abort.signal })).blob()
              if (abort.signal.aborted) return
              const url = URL.createObjectURL(blob)
              urls.push(url)
              html = html.replaceAll(`asset://sha256/${hash}`, url)
            }
            if (abort.signal.aborted) return
            doc.querySelector('style')!.textContent = styles
            const content = doc.getElementById('word-table')!
            content.innerHTML = html
            editing = inlineTableEditing({ editor, getNode: () => node, getPos, doc,
              editableIds: block.editableTextNodeIds ?? [], label: (cell, paragraph) => `${label('单元格')} ${cell} · ${label('段落')} ${paragraph}`,
            })
            if (block.editableTableLayout && session.scope === 'write') {
              const table = content.querySelector('table')!
              const command = (detail: WordTableCommand) => {
                if (editor.isEditable) editor.view.dom.dispatchEvent(new CustomEvent('hcd-word-table-edit', { detail }))
              }
              const emptyButtons = (block.editableEmptyCells ?? []).flatMap(([row, column]) => {
                const paragraph = table.rows[row]?.cells[column]?.querySelector('p')
                if (!paragraph) return []
                const button = doc.createElement('button')
                button.type = 'button'
                button.className = 'hcd-empty-cell-edit'
                button.textContent = '＋'
                button.setAttribute('aria-label', label('编辑空白单元格'))
                button.title = label('编辑空白单元格')
                button.onclick = () => command({ op: 'table.cell.activate', blockId: block.blockId, row, column })
                paragraph.append(button)
                return [button]
              })
              const controls = document.createElement('div')
              controls.className = 'hcd-word-table-controls'
              controls.setAttribute('role', 'group')
              controls.setAttribute('aria-label', label('表格行列'))
              const coordinate = document.createElement('span')
              coordinate.textContent = label('选择单元格以调整行列')
              controls.append(coordinate)
              let selected: HTMLTableCellElement | null = null
              const actions: Array<[WordTableAction, string]> = [['insertRow', '下方插入行'], ['deleteRow', '删除所在行'], ['insertColumn', '右侧插入列'], ['deleteColumn', '删除所在列']]
              const buttons = actions.map(([action, text]) => {
                const button = document.createElement('button')
                button.type = 'button'
                button.textContent = label(text)
                button.onclick = () => {
                  if (!selected || !editor.isEditable) return
                  const row = selected.parentElement as HTMLTableRowElement
                  const index = action === 'insertRow' ? row.rowIndex + 1 : action === 'deleteRow' ? row.rowIndex
                    : action === 'insertColumn' ? selected.cellIndex + 1 : selected.cellIndex
                  command({ op: 'table.edit', blockId: block.blockId, action, index })
                }
                controls.append(button)
                return button
              })
              const update = () => {
                for (const button of emptyButtons) button.hidden = !editor.isEditable
                buttons.forEach((button, index) => {
                  button.disabled = !selected || !editor.isEditable || index === 1 && table.rows.length < 2 || index === 3 && table.rows[0].cells.length < 2
                })
              }
              const select = (event: Event) => {
                selected = (event.target as Element | null)?.closest<HTMLTableCellElement>('td,th') ?? null
                if (selected) {
                  const row = selected.parentElement as HTMLTableRowElement
                  coordinate.textContent = label('第 {row} 行 · 第 {column} 列')
                    .replace('{row}', String(row.rowIndex + 1)).replace('{column}', String(selected.cellIndex + 1))
                }
                update()
              }
              doc.addEventListener('focusin', select)
              doc.addEventListener('click', select)
              editor.on('transaction', update)
              editor.on('update', update)
              dom.prepend(controls)
              update()
              releaseControls = () => {
                doc.removeEventListener('focusin', select)
                doc.removeEventListener('click', select)
                editor.off('transaction', update)
                editor.off('update', update)
              }
            }
            const measure = () => { frame.style.height = `${Math.ceil(content.getBoundingClientRect().height) + 9}px` }
            resize = new ResizeObserver(measure)
            resize.observe(content)
            measure()
            const target = focus.current
            if (target && block.editableTextNodeIds?.includes(target.nodeId)) {
              const paragraph = target.firstCell
                ? content.querySelector<HTMLElement>('[data-hcd-inline-table-text]')
                : content.querySelector(`[data-hcd-id="${CSS.escape(target.nodeId)}"]`)?.closest<HTMLElement>('[data-hcd-inline-table-text]')
              if (paragraph) {
                dom.scrollIntoView({ block: 'nearest' })
                requestAnimationFrame(() => {
                  if (abort.signal.aborted || focus.current !== target || !editor.isEditable) return
                  focus.current = null
                  paragraph.focus()
                })
              }
            }
          } catch (error) {
            if (!abort.signal.aborted) {
              const message = document.createElement('div')
              message.setAttribute('role', 'alert')
              message.textContent = `${label('表格加载失败')} · ${String(error)}`
              dom.append(message)
            }
          } finally { dom.setAttribute('aria-busy', 'false') }
        }
        frame.srcdoc = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style></style><style>body{margin:3px;font:12pt 'Times New Roman',serif}td,th{outline:1px solid #e0e5ee}[contenteditable=plaintext-only]:focus{background:#e8f1ff;outline:1px solid #1769e8!important}[contenteditable=plaintext-only]{min-height:1em}.hcd-table{max-width:100%}.hcd-empty-cell-edit{border:0;background:transparent;color:#385983;font:13px system-ui;cursor:pointer;padding:0 5px}.hcd-empty-cell-edit:hover,.hcd-empty-cell-edit:focus-visible{background:#e8f1ff}</style></head><body><main id="word-table"></main></body></html>`
        return {
          dom,
          ignoreMutation: () => true,
          stopEvent: () => true,
          update(next) {
            if (next.type !== node.type || next.attrs.hcdBlockId !== node.attrs.hcdBlockId || next.attrs.hcdTable !== node.attrs.hcdTable) return false
            node = next
            editing?.sync()
            return true
          },
          destroy() {
            abort.abort()
            frame.onload = null
            editing?.destroy()
            releaseControls?.()
            resize?.disconnect()
            urls.forEach(url => URL.revokeObjectURL(url))
          },
        }
      }
    },
  })
}
