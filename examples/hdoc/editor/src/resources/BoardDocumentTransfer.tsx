import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, FileText, X } from 'lucide-react'
import { api, ApiResponseError, type Session } from '../api'
import type { CanvasElement, Snapshot } from '../canvas/model'
import type { BoardTag } from '../canvas/boardObjects'
import { useEmbeddedWorkspace } from '../EmbeddedWorkspace'
import { useWorkflowWorkspace } from '../WorkflowWorkspace'
import type { BoardExcerpt } from '../public'
import type { BlockContent, Projection } from '../schema'
import { readResource, referenceFrom, sameResourceWorkspace, textResource } from './resourceReference'

type Section = BoardExcerpt & { table?: string[][] }
type Preview = { sections: Section[]; epoch: number }
type Resolve = (id: string) => Promise<Session>
const boardTag = (element: CanvasElement) => (element.customData as { officeBoard?: BoardTag } | undefined)?.officeBoard
const tableLines = (table: string[][]) => table.map(row => row.join('\t'))

async function readSelection(owner: Session, ids: string[], resolve: Resolve): Promise<Preview> {
  const [snapshot, auth] = await Promise.all([
    api(owner, '/canvas').then(r => r.json()) as Promise<Snapshot>,
    api(owner, '/auth').then(r => r.json()),
  ])
  if (!auth.operations?.includes('document.copy')) throw Error('当前白板未授权复制内容。')
  const selected = new Set(ids)
  const live = snapshot.scene.elements.filter(e => !e.isDeleted)
  const roots = live.filter(e => selected.has(e.id))
  if (roots.length !== selected.size) throw Error('部分选中对象已删除，请重新选择。')
  const groups = new Set(roots.flatMap(e => Array.isArray(e.groupIds) ? e.groupIds : []))
  const elements = live.filter(e => selected.has(e.id) || selected.has(String(e.containerId)) ||
    Array.isArray(e.groupIds) && e.groupIds.some(g => groups.has(g))).sort((a, b) => a.y - b.y || a.x - b.x)
  const selectedTables = new Map<string, { id: string; cells: { row: number; col: number; text: string }[] }>()
  const labels = new Map(live.filter(e => e.type === 'text' && typeof e.containerId === 'string').map(e => [e.containerId, e]))
  const tableCells = new Set<string>()
  for (const element of elements) {
    const tag = boardTag(element)
    if (tag?.kind !== 'table' || typeof tag.root !== 'string' ||
        !Number.isSafeInteger(tag.row) || tag.row! < 0 || tag.row! >= 1000 ||
        !Number.isSafeInteger(tag.col) || tag.col! < 0 || tag.col! >= 128) continue
    const table = selectedTables.get(tag.root) || { id: element.id, cells: [] }
    const label = labels.get(element.id)
    const text = label?.originalText ?? label?.text
    table.cells.push({ row: tag.row!, col: tag.col!, text: text === '\u00a0' ? '' : typeof text === 'string' ? text : '' })
    selectedTables.set(tag.root, table)
    tableCells.add(element.id)
  }
  const tables = new Map([...selectedTables.values()].map(table => [table.id, table.cells]))
  const sections: Section[] = []
  for (const element of elements) {
    const ref = referenceFrom((element.customData as { officeResource?: unknown } | undefined)?.officeResource)
    if (ref) {
      const source = await resolve(ref.documentId)
      if (!sameResourceWorkspace(source, owner)) throw Error('引用源文件不可访问。')
      const access = await (await api(source, '/auth')).json()
      if (!access.operations?.includes('document.copy')) throw Error('引用源文件未授权复制内容。')
      const preview = await readResource(source, ref)
      sections.push({ id: element.id, documentId: ref.documentId, heading: preview.title + ' · ' + preview.label,
        lines: preview.rows ? [] : (preview.text || '').split('\n'), table: preview.rows })
    } else if (tableCells.has(element.id)) {
      const cells = tables.get(element.id)
      if (!cells) continue
      const top = Math.min(...cells.map(c => c.row)), left = Math.min(...cells.map(c => c.col))
      const height = Math.max(...cells.map(c => c.row)) - top + 1, width = Math.max(...cells.map(c => c.col)) - left + 1
      if (width * height > 10000) throw Error('请选择较小的白板表格。')
      const table = Array.from({ length: height }, () => Array<string>(width).fill(''))
      for (const cell of cells) table[cell.row - top][cell.col - left] = cell.text
      sections.push({ id: element.id, lines: [], table })
    } else {
      if (element.type === 'text' && typeof element.containerId === 'string' && tableCells.has(element.containerId)) continue
      const value = element.originalText || element.text || element.name
      if (typeof value === 'string' && value.trim()) sections.push({ id: element.id, lines: value.trim().split('\n') })
    }
  }
  if (!sections.length) throw Error('请选择包含文字的白板对象、文档段落或表格引用。')
  return { sections, epoch: snapshot.collaborationEpoch }
}

export function BoardDocumentTransfer({ owner, ids, onClose }: { owner: Session; ids: string[]; onClose: () => void }) {
  const group = useEmbeddedWorkspace()!, workflow = useWorkflowWorkspace()
  const targets = group.files.filter(f => textResource(f.format) && f.writable)
  const [targetId, setTargetId] = useState(targets[0]?.documentId || '')
  const textOnly = targets.find(target => target.documentId === targetId)?.format === 'txt'
  const [draft, setDraft] = useState<Section[] | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState('')
  const [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [receipt, setReceipt] = useState<number | null>(null)
  const attempt = useRef<{ body: string; epoch: number } | null>(null)
  const locked = useRef(false), dialog = useRef<HTMLDialogElement>(null)
  const prepare = useRef(workflow)
  prepare.current = workflow
  const { resolve } = group
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    let alive = true
    setPreview(null); setDraft(null); setError('')
    void readSelection(owner, ids, resolve).then(result => { if (alive) setPreview(result) }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [owner.documentId, ids, resolve, reload])
  async function organize() {
    if (!preview || !group.organize || locked.current) return
    locked.current = true; setBusy(true); setError('')
    try {
      const originals = new Map(preview.sections.map(section => [section.id, section]))
      const inputs = preview.sections.map(({ table, lines, ...source }) => ({ ...source, lines: table ? [...lines, ...tableLines(table)] : lines }))
      const organized = await group.organize(owner.documentId, inputs)
      setDraft(organized.map(section => ({ ...section, table: originals.get(section.id)?.table })))
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { locked.current = false; setBusy(false) }
  }
  async function apply() {
    if (!preview || !targetId || locked.current) return
    locked.current = true; setBusy(true); setError('')
    try {
      const sourceIds = [owner.documentId, targetId, ...preview.sections.flatMap(s => s.documentId || [])]
      const open = prepare.current?.sessions.filter(s => s.scope === 'write' && sourceIds.includes(s.documentId)) || []
      await prepare.current?.prepare(open)
      const target = await resolve(targetId)
      if (!sameResourceWorkspace(target, owner) || target.scope !== 'write') throw Error('目标文档不可写。')
      if (!attempt.current) {
        const latest = await readSelection(owner, ids, resolve)
        if (JSON.stringify(preview) !== JSON.stringify(latest)) {
          setPreview(latest); setDraft(null); throw Error('所选内容已更新，请核对新预览后再写入。')
        }
        const [manifest, auth] = await Promise.all([api(target, '').then(r => r.json()), api(target, '/auth').then(r => r.json())])
        if (!manifest.capabilities?.structurePatch) {
          try {
            await api(target, '/project', {method: 'POST', headers: {'Content-Type': 'application/json',
              'X-HCD-Collaboration-Epoch': String(auth.collaborationEpoch)}, body: JSON.stringify({expectedRevision: manifest.revision})})
          } catch (cause) {
            if (!(cause instanceof ApiResponseError) || ![400, 409].includes(cause.status) ||
                !(await (await api(target, '')).json()).capabilities?.structurePatch) throw cause
          }
        }
        const data = await (await api(target, '/editor')).json() as Projection
        const afterBlockId = data.blocks.filter(b => b.region === 'body').at(-1)?.blockId || null
        type Operation =
          | { op: 'block.insert'; afterBlockId: string | null; block: BlockContent }
          | { op: 'table.insert'; afterBlockId: string | null; rows: number; columns: number; values: string[][] }
        const operations: Operation[] = []
        const insert = (block: BlockContent) => operations.push({ op: 'block.insert', afterBlockId, block })
        for (const section of draft || preview.sections) {
          if (section.heading) insert(target.format === 'txt' ? { kind: 'paragraph', inlines: [{text: section.heading}] } : { kind: 'heading', level: 2, inlines: [{text: section.heading}] })
          for (const text of section.lines) insert({kind: 'paragraph', inlines: [{text}]})
          const values = section.table
          if (values && target.format === 'txt') {
            for (const text of tableLines(values)) insert({kind: 'paragraph', inlines: [{text}]})
          } else if (values) {
            operations.push({ op: 'table.insert', afterBlockId, rows: values.length, columns: values[0].length, values })
          }
          const link = group.sourceLink(owner.documentId, section.id)
          insert({kind: 'paragraph', inlines: [target.format === 'txt' ? {text: link} : {text: '查看白板来源', link}]})
        }
        // A shared anchor puts each insert directly after it. Emit in reverse to preserve reading order.
        operations.reverse()
        attempt.current = { epoch: auth.collaborationEpoch, body: JSON.stringify({schemaVersion: 'hcd-patch/4', documentId: targetId,
          baseRevision: data.revision, patchId: 'board-document-' + crypto.randomUUID(), operations}) }
      }
      const result = await (await api(target, '/patch', {method: 'POST', headers: { 'Content-Type': 'application/json',
        'X-HCD-Collaboration-Epoch': String(attempt.current.epoch) }, body: attempt.current.body})).json()
      setReceipt(result.revision)
    } catch (e) {
      if (e instanceof ApiResponseError && [400, 403, 409, 412, 422].includes(e.status)) attempt.current = null
      setError(e instanceof Error ? e.message : String(e))
    } finally { locked.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} className="resource-picker board-document-transfer" aria-label="整理为文档" onCancel={e => { e.preventDefault(); if (!busy) onClose() }}>
    <header><h2>整理为文档</h2><button aria-label="关闭整理" disabled={busy} onClick={onClose}><X size={16}/></button></header>
    <label>目标文档<select aria-label="整理目标文档" disabled={busy || receipt !== null || !!attempt.current} value={targetId} onChange={e => setTargetId(e.target.value)}>
      {targets.map(f => <option key={f.documentId} value={f.documentId}>{f.title}</option>)}</select></label>
    {!targets.length && <p>请先在首页创建一份可编辑的文档。</p>}
    {preview && <div className="board-document-preview" aria-label="写入预览">{(draft || preview.sections).map(s => <section key={s.id}>{s.heading && <strong>{s.heading}</strong>}
      {s.lines.map((line, i) => <p key={i}>{line}</p>)}
      {s.table && (textOnly ? tableLines(s.table).map((line, i) => <p key={i}>{line}</p>) :
        <table><tbody>{s.table.map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j}>{value}</td>)}</tr>)}</tbody></table>)}
    </section>)}</div>}
    {!preview && !error && <p role="status">正在读取白板选区…</p>}
    {error && <p role="alert">{error}</p>}
    <footer>{group.organize && preview && receipt === null && <button disabled={busy || !!attempt.current} onClick={() => draft ? setDraft(null) : void organize()}>{draft ? '使用原文' : 'AI 整理'}</button>}
      {!preview && error && <button onClick={() => setReload(i => i + 1)}>重新读取</button>}
      {receipt === null ? <button className="resource-primary" disabled={busy || !preview || !targetId} onClick={() => void apply()}><FileText size={15}/>{busy ? '正在写入…' : '写入文档'}</button> :
      <><span role="status">已写入 · r{receipt}</span><button className="resource-primary" onClick={() => { group.activate(targetId); onClose() }}>查看文档<ArrowUpRight size={14}/></button></>}</footer>
  </dialog>
}
