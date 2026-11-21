import { useEffect, useRef, useState } from 'react'
import { FileText, Table2, X } from 'lucide-react'
import { api, type Session } from '../api.ts'
import { useEmbeddedWorkspace, type ResourcePreset } from '../EmbeddedWorkspace'
import type { Projection } from '../schema.ts'
import { useWorkflowWorkspace } from '../WorkflowWorkspace.tsx'
import { useResourceWorkspace } from './ResourceWorkspace.tsx'
import { RESOURCE_SCHEMA, sameResourceWorkspace, sheetResource, textResource, columnName, parseRange, rangeAnchors, readSheet, resourceService, sheetChoices, sheetPresentations, type ResourceReference, type SheetPresentation } from './resourceReference.ts'

export function ResourcePicker({ owner, preset, disabled = false, onInsert, onClose }: { owner: Session; preset?: ResourcePreset; disabled?: boolean; onInsert: (ref: ResourceReference, size:{width:number;height:number}) => Promise<void>; onClose: () => void }) {
  const workspace = useResourceWorkspace(), workflow = useWorkflowWorkspace()
  const group = useEmbeddedWorkspace()
  const open = workspace?.sessions.filter(s => sameResourceWorkspace(s, owner)) || []
  const sources = (group?.files || open).filter(s => s.documentId !== owner.documentId && (textResource(s.format) || sheetResource(s.format)))
  const [id, setId] = useState(preset?.sourceId || sources[0]?.documentId || ''), [blockId, setBlockId] = useState(''), [sheetId, setSheetId] = useState(''), [range, setRange] = useState('B2:F7')
  const [presentation, setPresentation] = useState<SheetPresentation>('table')
  const [blocks, setBlocks] = useState<Projection['blocks']>([]), [sheets, setSheets] = useState<{ sheetId: string; sheetName: string }[]>([])
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [loaded, setLoaded] = useState<Session | null>(null)
  const mounted = open.find(s => s.documentId === id), source = mounted || (loaded?.documentId === id ? loaded : null)
  const resolve = workspace?.resolve, selected = useRef(group?.selection), prepare = useRef(workflow?.prepare), lifetime = useRef(0)
  selected.current = group?.selection; prepare.current = workflow?.prepare
  useEffect(() => { if (!id && sources[0]) setId(sources[0].documentId) }, [id, sources[0]?.documentId])
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
    if (!id) return
    const controller = new AbortController(), ticket = ++lifetime.current
    setLoading(true); setLoaded(null); setError(''); setBlocks([]); setSheets([]); setBlockId(''); setSheetId(''); setRange('B2:F7')
    void (async () => {
      if (mounted?.scope === 'write') await prepare.current?.([mounted])
      const source = mounted || await resolve?.(id)
      if (!source || !sameResourceWorkspace(source, owner)) throw new Error('无法访问所选源文件。')
      const selection = selected.current?.(id)
      if (sheetResource(source.format)) {
        const data = await sheetChoices(source, controller.signal)
        if (controller.signal.aborted) return
        const target = selection?.revision === data.revision && selection.target.kind === 'sheet' ? selection.target : null
        setSheets(data.sheets); setSheetId((preset?.sourceId === id && preset.sheetId) || target?.sheetId || data.sheets[0]?.sheetId || '')
        if (preset?.sourceId === id && preset.range) setRange(preset.range)
        else if (target) setRange(columnName(target.left) + (target.top + 1) + ':' + columnName(target.right) + (target.bottom + 1))
      } else {
        const data = await (await api(source, '/editor', { signal: controller.signal })).json() as Projection
        if (controller.signal.aborted) return
        setBlocks(data.blocks)
        if (preset?.sourceId === id && preset.blockId && data.blocks.some(b => b.blockId === preset.blockId)) setBlockId(preset.blockId!)
        else if (selection?.revision === data.revision && selection.target.kind === 'document') setBlockId(selection.target.spans[0]?.blockId || '')
      }
      setLoaded(source)
    })().catch(cause => { if (!controller.signal.aborted && ticket === lifetime.current) setError(String(cause)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); lifetime.current++ }
  }, [id, mounted, resolve, owner.documentId, owner.userId, owner.serviceId, preset])
  async function insert() {
    if (!source || busy || disabled) return
    setBusy(true); setError('')
    try {
      if (mounted?.scope === 'write') await prepare.current?.([mounted])
      const anchor: ResourceReference['anchor'] = sheetResource(source.format) ? { kind: 'sheet-range', sheetId, range: range.trim().toUpperCase(), cells: rangeAnchors(await readSheet(source, sheetId), range) } : { kind: 'document', ...(blockId ? { blockId } : {}) }
      let width=384, height=80
      if (anchor.kind === 'sheet-range') {
        const bounds=parseRange(anchor.range)
        width=presentation === 'table' ? Math.min(720,56+96*(bounds.endColumn-bounds.column+1)) : 540
        height=presentation === 'table' ? Math.min(480,4+38*(bounds.endRow-bounds.row+2)) : 240
      } else {
        const lines=blocks.filter(b=>!blockId || b.blockId===blockId).map(b=>b.content.inlines?.map(inline=>inline.text || '').join('') || '')
        height=Math.min(420,Math.max(58,30+lines.reduce((total,line)=>total+Math.max(1,Math.ceil(line.length/22))*26,0)))
      }
      await onInsert({ schemaVersion: RESOURCE_SCHEMA, documentId: source.documentId, service: resourceService(source), anchor,
        ...(anchor.kind === 'sheet-range' && presentation !== 'table' ? { presentation } : {}) },{width,height})
      onClose()
    } catch (cause) { setError(String(cause)); setBusy(false) }
  }
  return <div className="resource-picker-backdrop"><section ref={dialog} role="dialog" aria-modal="true" aria-label="插入资源引用" className="resource-picker">
    <header><h2>插入资源引用</h2><button type="button" aria-label="关闭资源选择" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    <p>选择源文件及引用范围。卡片跟随原文更新。</p>
    {!sources.length ? <p role="status">请先打开一份文档或表格，再回到白板插入引用。</p> : <>
      <label>源文件<select aria-label="引用源文件" value={id} disabled={busy} onChange={e => setId(e.target.value)}>{sources.map(s => <option key={s.documentId} value={s.documentId}>{s.title || s.documentId} · {s.format.toUpperCase()}</option>)}</select></label>
      {loading ? <p role="status">正在读取源文件…</p> : sheetResource(source?.format || '') ? <>
        <label>工作表<select aria-label="引用工作表" value={sheetId} disabled={busy} onChange={e => setSheetId(e.target.value)}>{sheets.map(s => <option key={s.sheetId} value={s.sheetId}>{s.sheetName}</option>)}</select></label>
        <label>表格区域<input aria-label="引用表格区域" value={range} maxLength={25} disabled={busy} onChange={e => setRange(e.target.value)} placeholder="B2:F7" /></label>
        <label>呈现方式<select aria-label="呈现方式" value={presentation} disabled={busy} onChange={e => setPresentation(e.target.value as SheetPresentation)}>
          {Object.entries(sheetPresentations).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <small>最多 200 个单元格。表格和图表会跟随源单元格更新及移位。</small>
      </> : <label>引用内容<select aria-label="引用段落" value={blockId} disabled={busy} onChange={e => setBlockId(e.target.value)}><option value="">整份文档摘要</option>{blocks.map((block, i) => <option key={block.blockId} value={block.blockId}>{i + 1}. {block.content.inlines.map(t => t.text).join('').slice(0, 70) || '内容块'}</option>)}</select></label>}
      {error && <p role="alert" className="resource-error">{error}</p>}
      <footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="resource-primary" disabled={disabled || loading || busy || !loaded || !source || sheetResource(source.format) && !sheetId} onClick={() => void insert()}>{sheetResource(source?.format || '') ? <Table2 size={15} /> : <FileText size={15} />}{busy ? '正在插入…' : '插入白板'}</button></footer>
    </>}
  </section></div>
}
