import { useEffect, useRef, useState } from 'react'
import { FileText, Table2, X } from 'lucide-react'
import { api, type Session } from '../api.ts'
import type { Projection } from '../schema.ts'
import { useWorkflowWorkspace } from '../WorkflowWorkspace.tsx'
import { useResourceWorkspace } from './ResourceWorkspace.tsx'
import { RESOURCE_SCHEMA, parseRange, rangeAnchors, readSheet, resourceService, sheetChoices, type ResourceReference } from './resourceReference.ts'

export function ResourcePicker({ owner, onInsert, onClose }: { owner: Session; onInsert: (ref: ResourceReference) => Promise<void>; onClose: () => void }) {
  const workspace = useResourceWorkspace(), workflow = useWorkflowWorkspace()
  const sources = workspace?.sessions.filter(s => s.documentId !== owner.documentId && !!s.userId && s.userId === owner.userId && !s.hostIntegration && resourceService(s) === resourceService(owner) && ['docx', 'md', 'txt', 'html', 'xlsx'].includes(s.format)) || []
  const [id, setId] = useState(sources[0]?.documentId || ''), [blockId, setBlockId] = useState(''), [sheetId, setSheetId] = useState(''), [range, setRange] = useState('B2:F7')
  const [blocks, setBlocks] = useState<Projection['blocks']>([]), [sheets, setSheets] = useState<{ sheetId: string; sheetName: string }[]>([])
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const source = sources.find(s => s.documentId === id), prepare = useRef(workflow?.prepare), lifetime = useRef(0)
  prepare.current = workflow?.prepare
  const dialog = useRef<HTMLElement>(null), close = useRef(onClose), inserting = useRef(busy)
  close.current = onClose; inserting.current = busy
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, host = dialog.current
    const controls = () => [...(host?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)') || [])]
    controls()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!inserting.current) close.current() }
      if (event.key !== 'Tab') return
      const items = controls(), first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    host?.addEventListener('keydown', keydown)
    return () => { host?.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    if (!source) return
    const controller = new AbortController(), ticket = ++lifetime.current
    setLoading(true); setError(''); setBlocks([]); setSheets([]); setBlockId(''); setSheetId('')
    void (async () => {
      await prepare.current?.([source])
      if (source.format === 'xlsx') {
        const data = await sheetChoices(source, controller.signal)
        if (!controller.signal.aborted) { setSheets(data.sheets); setSheetId(data.sheets[0]?.sheetId || '') }
      } else {
        const data = await (await api(source, '/editor', { signal: controller.signal })).json() as Projection
        if (!controller.signal.aborted) setBlocks(data.blocks)
      }
    })().catch(cause => { if (!controller.signal.aborted && ticket === lifetime.current) setError(String(cause)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); lifetime.current++ }
  }, [source])
  async function insert() {
    if (!source || busy) return
    setBusy(true); setError('')
    try {
      await prepare.current?.([source])
      const anchor: ResourceReference['anchor'] = source.format === 'xlsx' ? { kind: 'sheet-range', sheetId, range: range.trim().toUpperCase(), cells: rangeAnchors(await readSheet(source, sheetId), range) } : { kind: 'document', ...(blockId ? { blockId } : {}) }
      if (anchor.kind === 'sheet-range') parseRange(anchor.range)
      await onInsert({ schemaVersion: RESOURCE_SCHEMA, documentId: source.documentId, service: resourceService(source), anchor })
      onClose()
    } catch (cause) { setError(String(cause)); setBusy(false) }
  }
  return <div className="resource-picker-backdrop"><section ref={dialog} role="dialog" aria-modal="true" aria-label="插入资源引用" className="resource-picker">
    <header><h2>插入资源引用</h2><button type="button" aria-label="关闭资源选择" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    <p>选择已打开的源文件。卡片会跟随原文更新，访问权限以源文件为准。</p>
    {!sources.length ? <p role="status">请先打开一份文档或表格，再回到白板插入引用。</p> : <>
      <label>源文件<select aria-label="引用源文件" value={id} disabled={busy} onChange={e => setId(e.target.value)}>{sources.map(s => <option key={s.documentId} value={s.documentId}>{s.title || s.documentId} · {s.format.toUpperCase()}</option>)}</select></label>
      {loading ? <p role="status">正在读取源文件…</p> : source?.format === 'xlsx' ? <>
        <label>工作表<select aria-label="引用工作表" value={sheetId} disabled={busy} onChange={e => setSheetId(e.target.value)}>{sheets.map(s => <option key={s.sheetId} value={s.sheetId}>{s.sheetName}</option>)}</select></label>
        <label>表格区域<input aria-label="引用表格区域" value={range} maxLength={25} disabled={busy} onChange={e => setRange(e.target.value)} placeholder="B2:F7" /></label>
        <small>最多 200 个单元格。插入行列使引用位置变化时，需要重新选择区域。</small>
      </> : <label>引用内容<select aria-label="引用段落" value={blockId} disabled={busy} onChange={e => setBlockId(e.target.value)}><option value="">整份文档摘要</option>{blocks.map((block, i) => <option key={block.blockId} value={block.blockId}>{i + 1}. {block.content.inlines.map(t => t.text).join('').slice(0, 70) || '内容块'}</option>)}</select></label>}
      {error && <p role="alert" className="resource-error">{error}</p>}
      <footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="resource-primary" disabled={loading || busy || !source || source.format === 'xlsx' && !sheetId} onClick={() => void insert()}>{source?.format === 'xlsx' ? <Table2 size={15} /> : <FileText size={15} />}{busy ? '正在插入…' : '插入白板'}</button></footer>
    </>}
  </section></div>
}
