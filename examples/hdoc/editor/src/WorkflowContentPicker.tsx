import { useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle, Search } from 'lucide-react'
import { api, type Session } from './api.ts'
import { assertWorkflowPosition, workflowError, workflowPosition, type WorkflowContent, type WorkflowPosition } from './agentWorkflow.ts'

type Choice = { id: string; label: string; preview: string; selection?: WorkflowContent['selection']; nodeId?: string; unavailable?: boolean }
type Sheet = { sheetName: string; cells: { address: string; nodeId: string; text: string; isFormula: boolean; calculation: { status: string; value?: string } }[] }

/** Paged real document content, not model-authored facts or raw JSON input. */
export function WorkflowContentPicker({ session, output = false, onSelect }: { session: Session; output?: boolean; onSelect: (content: WorkflowContent) => void }) {
  const [number, setNumber] = useState(1), [query, setQuery] = useState(''), [choices, setChoices] = useState<Choice[]>([])
  const [position, setPosition] = useState<WorkflowPosition | null>(null), [limit, setLimit] = useState(1), [label, setLabel] = useState('')
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [picking, setPicking] = useState(''), [reload, setReload] = useState(0)
  const generation = useRef(0), pending = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController(), current = ++generation.current
    pending.current?.abort()
    setLoading(true); setError(''); setChoices([]); setPosition(null); setPicking('')
    void (async () => {
      const before = await workflowPosition(session, controller.signal)
      let items: Choice[], group: string
      if (session.format === 'xlsx') {
        const data = await (await api(session, `/sheets/${number - 1}`, { signal: controller.signal })).json() as Sheet
        group = data.sheetName
        items = data.cells.map((cell, index) => ({ id: cell.nodeId || cell.address, label: cell.address, preview: String(cell.calculation.value ?? '计算暂不可用'), selection: { documentId: session.documentId, resource: 'sheet', number: number - 1, pointer: `/cells/${index}/calculation/value`, identity: { pointer: `/cells/${index}/${cell.nodeId ? 'nodeId' : 'address'}`, value: cell.nodeId || cell.address } }, unavailable: cell.calculation.status !== 'calculated' }))
      } else if (['docx', 'txt', 'md', 'html'].includes(session.format)) {
        const data = await (await api(session, '/editor', { signal: controller.signal })).json() as { blocks: { blockId: string; region: string; content: { kind: string; inlines?: { text: string }[] } }[] }
        group = '正文'
        const all = data.blocks.map((block, index) => ({ id: block.blockId, label: `段落 ${index + 1}`, preview: block.content.inlines?.map(inline => inline.text).join('') || '', selection: { documentId: session.documentId, resource: 'editor' as const, pointer: `/blocks/${index}/content/inlines`, identity: { pointer: `/blocks/${index}/blockId`, value: block.blockId } } })).filter(item => item.preview.trim())
        setLimit(Math.max(1, Math.ceil(all.length / 100)))
        items = all.slice((number - 1) * 100, number * 100)
      } else {
        setLimit(Math.max(1, before.manifest.chunkCount)); group = `第 ${number} 组文字`
        const data = await (await api(session, `/chunks/${number - 1}`, { signal: controller.signal })).json() as { html: string; map: { entries: { nodeId: string }[] } }
        const doc = new DOMParser().parseFromString(data.html, 'text/html')
        items = data.map.entries.map(entry => ({ id: entry.nodeId, nodeId: entry.nodeId, label: '文字', preview: doc.querySelector(`[data-hcd-id="${CSS.escape(entry.nodeId)}"]`)?.textContent?.trim() || '' })).filter(item => item.preview)
      }
      const after = await workflowPosition(session, controller.signal)
      assertWorkflowPosition(before.position, after.position)
      if (controller.signal.aborted || current !== generation.current) return
      setChoices(items); setPosition(after.position); setLabel(group)
    })().catch(cause => { if (!controller.signal.aborted) setError(workflowError(cause)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); pending.current?.abort(); generation.current++ }
  }, [session, number, reload, output])
  async function select(choice: Choice) {
    if (!position || picking || choice.unavailable) return
    const current = generation.current, controller = new AbortController()
    pending.current = controller; setPicking(choice.id); setError('')
    try {
      const node = choice.nodeId ? await (await api(session, `/nodes/${encodeURIComponent(choice.nodeId)}`, { signal: controller.signal })).json() as { text: string } : null
      const after = await workflowPosition(session, controller.signal)
      assertWorkflowPosition(position, after.position)
      const preview = node?.text ?? choice.preview
      if (new TextEncoder().encode(JSON.stringify(preview)).length > 8192) throw new Error('这段内容过长，请选择更短的文字或单个单元格。')
      if (controller.signal.aborted || current !== generation.current) return
      onSelect({ label: `${label} · ${choice.label === '文字' ? preview.slice(0, 32) : choice.label}`, preview, position, selection: choice.nodeId
        ? { documentId: session.documentId, resource: 'node', nodeId: choice.nodeId, pointer: '/text' }
        : choice.selection! })
    } catch (cause) { if (!controller.signal.aborted) setError(workflowError(cause)) }
    finally { if (!controller.signal.aborted && current === generation.current) setPicking('') }
  }
  const filtered = choices.filter(choice => `${choice.label} ${choice.preview}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="workflow-content-picker" aria-label={output ? '选择步骤产出' : '选择共享内容'}>
    <div className="workflow-picker-tools"><label>{session.format === 'xlsx' ? '工作表序号' : '内容分组'}<input aria-label={session.format === 'xlsx' ? '工作表序号' : '内容分组'} type="number" min={1} max={session.format === 'xlsx' ? undefined : limit} value={number} onChange={event => { const next = Number(event.target.value); if (Number.isInteger(next) && next > 0 && (session.format === 'xlsx' || next <= limit)) setNumber(next) }} /></label><button type="button" disabled={loading} onClick={() => setReload(value => value + 1)}>刷新内容</button></div>
    <label className="workflow-search"><Search size={13} /><input aria-label="筛选共享内容" placeholder="搜索文字或单元格" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {session.format === 'xlsx' && <p className="workflow-caption">仅共享实际核算的单元格值；步骤产出会在完成后重新计算。</p>}
    {output && <p className="workflow-caption">步骤完成后重新读取所选段落或对象；删除对象或改变其位置会停止下游，请保留此内容位置。</p>}
    {loading ? <p role="status"><LoaderCircle size={13} className="agent-spinner" /> 正在读取内容…</p> : <div className="workflow-content-options">{filtered.slice(0, 150).map(choice => <button type="button" key={choice.id} disabled={!!picking || choice.unavailable} onClick={() => void select(choice)}><span><strong>{choice.label}</strong><small>{choice.preview}</small></span>{picking === choice.id ? <LoaderCircle size={13} className="agent-spinner" /> : <Check size={13} />}</button>)}{filtered.length > 150 && <p className="workflow-caption">还有 {filtered.length - 150} 项，请用搜索缩小范围。</p>}{!filtered.length && !error && <p className="workflow-caption">这一组中没有可选文字，请切换内容分组或工作表。</p>}</div>}
    {error && <p className="workflow-error" role="alert">{error}</p>}
  </div>
}
