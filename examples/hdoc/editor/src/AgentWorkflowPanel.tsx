import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronDown, Files, GitBranch, LoaderCircle, Plus, RotateCcw, Square, X } from 'lucide-react'
import { api, type Session } from './api.ts'
import { readCapabilities } from './capabilities.ts'
import { useWorkflowWorkspace, workflowService } from './WorkflowWorkspace.tsx'
import { WorkflowContentPicker } from './WorkflowContentPicker.tsx'
import { assertWorkflowPosition, readWorkflowBookmarks, requireWorkflowProtocol, saveWorkflowBookmark, workflowBookmarkKey, workflowError, workflowHeaders, workflowPosition, workflowProtocol, type Workflow, type WorkflowContent, type WorkflowPlan, type WorkflowReview, type WorkflowStep, type WorkflowSummary } from './agentWorkflow.ts'
import './agent-workflow.css'

type DraftStep = Omit<WorkflowStep, 'produces'> & { output?: WorkflowContent }
type DraftFact = WorkflowContent & { key: string }
const statuses: Record<string, string> = { ready: '待核对', pending: '待处理', starting: '正在启动', running: '执行中', stopping: '正在停止', cancelling: '正在停止', completed: '已完成', interrupted: '已中断', failed: '未完成', cancelled: '已停止', compensating: '正在补偿', compensated: '已补偿' }
const isActive = (status: string) => ['running', 'stopping', 'compensating'].includes(status)
const title = (session: Session) => session.title || session.documentId
function sharedText(value: unknown): string {
  if (value === null) return '空内容'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every(item => item && typeof item.text === 'string')) return value.map(item => item.text).join('')
  return '结构化内容，可通过 MCP 查看完整数据。'
}

export function AgentWorkflowPanel({ session, active, requestedId }: { session: Session; active: boolean; requestedId?: string }) {
  const workspace = useWorkflowWorkspace()
  const eligible = workspace?.sessions.filter(item => !item.hostIntegration && item.userId && item.userId === session.userId && workflowService(item) === workflowService(session) && ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'html', 'txt'].includes(item.format)) || []
  const documents = [session, ...eligible.filter(item => item.documentId !== session.documentId)]
  const [selected, setSelected] = useState([session.documentId]), [name, setName] = useState('跨文档协作')
  const [facts, setFacts] = useState<DraftFact[]>([]), [steps, setSteps] = useState<DraftStep[]>([])
  const [picker, setPicker] = useState<{ documentId: string; stepId?: string } | null>(null)
  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]), [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [readIds, setReadIds] = useState<string[]>([]), [review, setReview] = useState<WorkflowReview | null>(null)
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [compensation, setCompensation] = useState(false), [compensationAccepted, setCompensationAccepted] = useState(false)
  const latest = useRef({ documents, workspace, selected, readIds, workflow })
  latest.current = { documents, workspace, selected, readIds, workflow }
  const pending = useRef(false), lifetime = useRef(true), counter = useRef(0)
  const bookmarkKey = workflowBookmarkKey(session, workflowService(session))
  const label = (id: string) => documents.find(item => item.documentId === id)?.title || id
  const bookmarks = readWorkflowBookmarks(bookmarkKey)
  const headersFor = (ids: string[]) => workflowHeaders(session, ids, latest.current.documents, workflowService)
  const selectedDocuments = selected.map(id => documents.find(item => item.documentId === id)).filter((item): item is Session => !!item)
  const writable = selectedDocuments.filter(item => item.scope === 'write')

  async function guarded(action: string, run: () => Promise<void>) {
    if (pending.current) return
    pending.current = true; setBusy(action); setError(''); setNotice('')
    try { await run() } catch (cause) { if (lifetime.current) setError(workflowError(cause)) }
    finally { pending.current = false; if (lifetime.current) setBusy('') }
  }
  const refreshList = useCallback(async (signal?: AbortSignal) => {
    const capabilities = await readCapabilities(session)
    requireWorkflowProtocol(capabilities)
    const result = await (await api(session, '/agent-workflows', { signal })).json() as { protocolVersion: string; workflows: WorkflowSummary[] }
    if (result.protocolVersion !== workflowProtocol) throw new Error('工作流协议不兼容。')
    if (!signal?.aborted) { setReady(true); setSummaries(previous => JSON.stringify(previous) === JSON.stringify(result.workflows) ? previous : result.workflows.sort((a, b) => b.updatedAtEpochMs - a.updatedAtEpochMs)) }
  }, [session])
  useEffect(() => {
    lifetime.current = true
    return () => { lifetime.current = false }
  }, [])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        await refreshList(controller.signal)
        const current = latest.current
        if (current.workflow) {
          const response = await api(session, `/agent-workflows/${encodeURIComponent(current.workflow.workflowId)}`, { headers: workflowHeaders(session, current.readIds, current.documents, workflowService), signal: controller.signal })
          const value = await response.json() as Workflow
          if (!controller.signal.aborted && !pending.current && latest.current.workflow?.workflowId === value.workflowId) {
            setWorkflow(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value)
            setReview(previous => previous && previous.workflow.updatedAtEpochMs === value.updatedAtEpochMs ? previous : null)
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) { setError(workflowError(cause)); setReview(null); if (/401:|403:|404:/.test(String(cause))) setWorkflow(null) }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1500)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [active, refreshList, session])

  async function participating(ids: string[], prepare: boolean) {
    const current = latest.current
    headersFor(ids)
    const opened = ids.map(id => current.documents.find(item => item.documentId === id)!)
    if (prepare) await current.workspace?.prepare(opened)
    const snapshots = await Promise.all(opened.map(async document => ({ document, ...await workflowPosition(document) })))
    if (snapshots.some(item => item.auth.userId !== session.userId)) throw new Error('所有参与文档必须使用同一用户身份。')
    return snapshots
  }
  async function loadRecord(id: string, knownIds?: string[]) {
    await guarded('读取记录', async () => {
      const ids = knownIds || readWorkflowBookmarks(bookmarkKey).find(item => item.workflowId === id)?.documentIds || latest.current.selected
      setReview(null); setWorkflow(null); setCompensation(false); setCompensationAccepted(false)
      const value = await (await api(session, `/agent-workflows/${encodeURIComponent(id)}`, { headers: headersFor(ids) })).json() as Workflow
      if (!lifetime.current) return
      setReadIds(value.plan.documents.map(item => item.documentId)); setWorkflow(value)
      saveWorkflowBookmark(bookmarkKey, { workflowId: value.workflowId, name: value.plan.name, documentIds: value.plan.documents.map(item => item.documentId) })
    })
  }
  useEffect(() => { if (active && requestedId) void loadRecord(requestedId) }, [active, requestedId])
  function addStep() {
    const target = writable[0]
    if (!target) { setError('请先选择一份可编辑的目标文档。'); return }
    const stepId = `step-${++counter.current}`
    setSteps(previous => [...previous, { stepId, documentId: target.documentId, task: '', dependsOn: previous.length ? [previous.at(-1)!.stepId] : [], consumes: facts.map(fact => fact.key), agentCount: 1, mode: 'edit', generateImages: true }])
  }
  function updateStep(id: string, update: Partial<DraftStep>) {
    const removeOutput = update.mode === 'rebuild' || Object.hasOwn(update, 'output') && !update.output
    if (removeOutput && picker?.stepId === id) setPicker(null)
    setSteps(previous => previous.map(step => {
      const next = step.stepId === id ? { ...step, ...update, ...(removeOutput ? { output: undefined } : {}) } : step
      return { ...next, consumes: removeOutput ? next.consumes.filter(key => key !== `output-${id}`) : next.consumes }
    }))
  }
  function removeStep(id: string) {
    setSteps(previous => previous.filter(step => step.stepId !== id).map(step => ({ ...step, dependsOn: step.dependsOn.filter(dep => dep !== id), consumes: step.consumes.filter(key => key !== `output-${id}`) })))
    if (picker?.stepId === id) setPicker(null)
  }
  async function createPlan() {
    await guarded('保存计划', async () => {
      if (!name.trim() || selected.length < 2 || selected.length > 16 || !steps.length || steps.some(step => !step.task.trim())) throw new Error('请填写计划名称、至少两份文档和每一步的任务。')
      const snapshots = await participating(selected, true)
      for (const content of [...facts, ...steps.flatMap(step => step.output ? [step.output] : [])]) {
        const snapshot = snapshots.find(item => item.document.documentId === content.selection.documentId)
        if (!snapshot) throw new Error('共享内容的来源不在参与文档中。')
        assertWorkflowPosition(content.position, snapshot.position)
      }
      const plan: WorkflowPlan = {
        name: name.trim(),
        documents: snapshots.map(item => {
          const access = steps.some(step => step.documentId === item.document.documentId) ? 'write' : 'read'
          if (access === 'write' && item.auth.scope !== 'write') throw new Error(`「${title(item.document)}」没有编辑权限。`)
          return { documentId: item.document.documentId, access, expectedRevision: item.position.revision, collaborationEpoch: item.position.epoch }
        }),
        facts: facts.map(fact => ({ ...fact.selection, key: fact.key })),
        steps: steps.map((step, index) => {
          const { output, ...rest } = step
          const previousSameDocument = steps.slice(0, index).reverse().find(item => item.documentId === step.documentId)
          const producers = steps.slice(0, index).filter(item => step.consumes.includes(`output-${item.stepId}`))
          return { ...rest, task: step.task.trim(), dependsOn: [...new Set([...step.dependsOn, ...producers.map(item => item.stepId), ...(previousSameDocument ? [previousSameDocument.stepId] : [])])], produces: output ? [{ ...output.selection, key: `output-${step.stepId}` }] : [] }
        }),
      }
      const capabilities = await readCapabilities(session)
      requireWorkflowProtocol(capabilities)
      const headers = headersFor(selected); headers.set('x-hcd-protocol-fingerprint', capabilities.protocolFingerprint)
      const value = await (await api(session, '/agent-workflows', { method: 'POST', headers, body: JSON.stringify(plan) })).json() as Workflow
      saveWorkflowBookmark(bookmarkKey, { workflowId: value.workflowId, name: plan.name, documentIds: selected })
      if (!lifetime.current) return
      setWorkflow(value); setReadIds([...selected]); setReview(null); setCompensation(false); setNotice('计划已保存，尚未启动 Agent。请核对后授权执行。')
      await refreshList()
    })
  }
  async function reviewPlan(compensate = false) {
    const current = workflow
    if (!current) return
    await guarded('核对计划', async () => {
      setReview(null); setCompensationAccepted(false)
      await participating(readIds, true)
      const value = await (await api(session, `/agent-workflows/${encodeURIComponent(current.workflowId)}/review`, { headers: headersFor(readIds) })).json() as WorkflowReview
      if (!lifetime.current || latest.current.workflow?.workflowId !== current.workflowId) return
      setWorkflow(value.workflow); setReview(value); setCompensation(compensate)
    })
  }
  async function execute(action: 'continue' | 'compensate') {
    if (!workflow || !review || (action === 'compensate' && !compensationAccepted)) return
    const current = workflow, approval = review
    await guarded('提交授权', async () => {
      setReview(null)
      await participating(readIds, true)
      const value = await (await api(session, `/agent-workflows/${encodeURIComponent(current.workflowId)}/actions`, { method: 'POST', headers: headersFor(readIds), body: JSON.stringify({ action, fingerprint: approval.fingerprint, authorize: true }) })).json() as Workflow
      if (lifetime.current) { setWorkflow(value); setCompensationAccepted(false) }
    })
  }
  const missing = selected.filter(id => !documents.some(document => document.documentId === id))
  const currentPicker = picker && documents.find(document => document.documentId === picker.documentId)
  return <section className="agent-workflows" aria-label="多文档工作流" aria-busy={!!busy}>
    <div className="workflow-intro"><span><GitBranch size={18} /></span><div><h3>让文档一起工作</h3><p>选择内容，安排步骤，共享每一步的成果。</p></div></div>
    {error && <p className="workflow-error" role="alert">{error}</p>}{notice && <p className="workflow-caption" role="status">{notice}</p>}
    {workflow ? <>
      <div className="workflow-record-heading"><strong>{workflow.plan.name}</strong><span data-workflow-status={workflow.status}>{isActive(workflow.status) && <LoaderCircle size={12} className="agent-spinner" />}{statuses[workflow.status] || workflow.status}</span></div>
      <div className="workflow-document-chips">{workflow.plan.documents.map(document => <button type="button" key={document.documentId} onClick={() => workspace?.activate(document.documentId)}><Files size={12} /><span>{label(document.documentId)}</span><small>{document.access === 'read' ? '读取' : '编辑'}</small></button>)}</div>
      <ol className="workflow-progress">{workflow.plan.steps.map((step, index) => {
        const progress = workflow.progress[step.stepId]
        return <li key={step.stepId} data-workflow-step={step.stepId} data-step-status={progress?.status || 'pending'}><span className="workflow-step-number">{progress?.status === 'completed' ? <Check size={13} /> : progress?.status === 'running' ? <LoaderCircle size={13} className="agent-spinner" /> : index + 1}</span><div><button type="button" className="workflow-document-link" onClick={() => workspace?.activate(step.documentId)}>{label(step.documentId)}<ArrowRight size={12} /></button><p>{step.task}</p><small>{statuses[progress?.status || 'pending'] || progress?.status} · {step.agentCount || 1} Agent{step.dependsOn.length ? ` · 等待步骤 ${step.dependsOn.map(id => workflow.plan.steps.findIndex(item => item.stepId === id) + 1).join('、')}` : ' · 可独立开始'}{progress?.committedRevisions.length ? ` · ${progress.committedRevisions.length} 次提交` : ''}</small>{progress?.result && <details><summary>查看步骤结果</summary><p>{progress.result}</p></details>}</div></li>
      })}</ol>
      {!!Object.keys(workflow.facts).length && <details className="workflow-facts"><summary><ChevronDown size={13} />已共享内容 <small>{Object.keys(workflow.facts).length}</small></summary>{Object.entries(workflow.facts).map(([key, fact]) => <div key={key}><strong>{label(fact.selection.documentId)} · r{fact.revision}</strong><p>{sharedText(fact.value)}</p></div>)}</details>}
      <p className="workflow-caption" role="status">{workflow.message}</p>
      {review && <div className="workflow-review" aria-label="工作流核对结果"><strong>{compensation ? '核对补偿范围' : '核对剩余工作'}</strong>{workflow.plan.documents.map(document => <p key={document.documentId}>{label(document.documentId)} <small>r{review.positions[document.documentId]?.revision} · {document.access === 'read' ? '只读来源' : '编辑目标'}</small></p>)}<p>{compensation ? review.compensationReason || '按逆依赖顺序创建恢复修订，保留版本历史。人工介入后停止补偿。' : review.continueReason || '保留已完成的步骤，继续剩余任务。'}</p>{compensation && review.canCompensate && <label><input type="checkbox" checked={compensationAccepted} onChange={event => setCompensationAccepted(event.target.checked)} />我了解补偿会恢复本计划的文档修改，并创建新修订。</label>}<p className="workflow-caption">{review.message}</p><button type="button" className="primary" disabled={!!busy || (compensation ? !review.canCompensate || !compensationAccepted : !review.canContinue)} onClick={() => void execute(compensation ? 'compensate' : 'continue')}>{compensation ? '授权补偿已提交修改' : '授权执行剩余步骤'}</button></div>}
      <div className="workflow-actions">{isActive(workflow.status) ? <button type="button" disabled={!!busy || workflow.status === 'stopping'} onClick={() => void guarded('停止工作流', async () => { const value = await (await api(session, `/agent-workflows/${encodeURIComponent(workflow.workflowId)}`, { method: 'DELETE', headers: headersFor(readIds) })).json() as Workflow; setWorkflow(value); setReview(null) })}><Square size={12} />停止工作流</button> : <>{!['completed', 'compensated'].includes(workflow.status) && <button type="button" disabled={!!busy} onClick={() => void reviewPlan()}><Check size={13} />{review && !compensation ? '重新核对' : '核对并继续'}</button>}{workflow.status !== 'compensated' && Object.values(workflow.progress).some(item => item.committedRevisions.length) && <button type="button" disabled={!!busy} onClick={() => void reviewPlan(true)}><RotateCcw size={13} />核对补偿</button>}</>}<button type="button" disabled={!!busy} onClick={() => { setWorkflow(null); setReview(null); setNotice(''); setError('') }}>返回计划列表</button></div>
    </> : <>
      <details className="workflow-history" open={summaries.length ? true : undefined}><summary><Files size={13} />已保存的工作流 <small>{summaries.length}</small></summary>{summaries.map(item => <button type="button" key={item.workflowId} disabled={!!busy} onClick={() => void loadRecord(item.workflowId)}><span>{bookmarks.find(bookmark => bookmark.workflowId === item.workflowId)?.name || '待核对的工作流'}<small>{new Date(item.updatedAtEpochMs).toLocaleString()}</small></span><small>{statuses[item.status] || item.status}</small></button>)}{!summaries.length && <p className="workflow-caption">尚未保存计划。</p>}<p className="workflow-caption">其他客户端创建的计划，请先在下方选齐参与文档再打开。缺少授权时不会读取计划内容。</p></details>
      <form onSubmit={event => { event.preventDefault(); void createPlan() }}>
        <fieldset disabled={!!busy || !ready}>
          <label className="workflow-field">计划名称<input aria-label="工作流名称" value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label>
          <div className="workflow-section-heading"><h4>参与文档</h4><small>{selected.length}/16</small></div>
          <div className="workflow-document-list">{documents.map(document => <label key={document.documentId}><input type="checkbox" aria-label={`参与 ${title(document)}`} checked={selected.includes(document.documentId)} disabled={document.documentId === session.documentId || !selected.includes(document.documentId) && selected.length >= 16} onChange={event => {
            if (event.target.checked) setSelected(previous => [...previous, document.documentId])
            else { setSelected(previous => previous.filter(id => id !== document.documentId)); setFacts(previous => previous.filter(fact => fact.selection.documentId !== document.documentId)); const removed = steps.filter(step => step.documentId === document.documentId).map(step => step.stepId); for (const id of removed) removeStep(id); setSteps(previous => previous.map(step => ({ ...step, consumes: step.consumes.filter(key => !facts.some(fact => fact.selection.documentId === document.documentId && fact.key === key)) }))); if (picker?.documentId === document.documentId) setPicker(null) }
          }} /><Files size={14} /><span>{title(document)}<small>{document.format.toUpperCase()} · {document.scope === 'read' ? '只读' : '可编辑'}{document.documentId === session.documentId ? ' · 当前' : ''}</small></span></label>)}</div>
          {missing.length > 0 && <p className="workflow-error">请重新打开：{missing.join('、')}</p>}
          {documents.length < 2 && <p className="workflow-caption">在工作台打开其他同身份的文档，即可加入计划。独立图片和宿主集成会话暂不参与。</p>}
          <div className="workflow-section-heading"><h4>共享内容</h4><small>{facts.length} 项</small></div>
          {facts.map(fact => <div className="workflow-selected-content" key={fact.key}><span><strong>{label(fact.selection.documentId)}</strong><small>{fact.label}</small><p>{fact.preview}</p></span><button type="button" aria-label={`移除共享内容 ${fact.label}`} onClick={() => { setFacts(previous => previous.filter(item => item.key !== fact.key)); setSteps(previous => previous.map(step => ({ ...step, consumes: step.consumes.filter(key => key !== fact.key) }))) }}><X size={13} /></button></div>)}
          <label className="workflow-field">添加内容来源<select aria-label="添加内容来源" value={picker && !picker.stepId ? picker.documentId : ''} onChange={event => setPicker(event.target.value ? { documentId: event.target.value } : null)}><option value="">选择文档中的实际内容</option>{selectedDocuments.map(document => <option key={document.documentId} value={document.documentId}>{title(document)}</option>)}</select></label>
          {picker && !picker.stepId && currentPicker && <WorkflowContentPicker key={currentPicker.documentId} session={currentPicker} onSelect={content => { if (facts.length >= 64) { setError('共享内容最多 64 项。'); return } const key = `shared-${++counter.current}`; setFacts(previous => [...previous, { ...content, key }]); setSteps(previous => previous.map(step => ({ ...step, consumes: [...step.consumes, key] }))); setPicker(null) }} />}
          <div className="workflow-section-heading"><h4>执行步骤</h4><button type="button" disabled={!writable.length || steps.length >= 32} onClick={addStep}><Plus size={13} />添加步骤</button></div>
          {steps.map((step, index) => <article key={step.stepId} className="workflow-draft-step" aria-label={`步骤 ${index + 1}`}><div className="workflow-section-heading"><strong>步骤 {index + 1}</strong><button type="button" aria-label={`移除步骤 ${index + 1}`} onClick={() => removeStep(step.stepId)}><X size={13} /></button></div><label className="workflow-field">编辑文档<select aria-label={`步骤 ${index + 1} 编辑文档`} value={step.documentId} onChange={event => { updateStep(step.stepId, { documentId: event.target.value, output: undefined, mode: 'edit' }); if (picker?.stepId === step.stepId) setPicker(null) }}>{writable.map(document => <option key={document.documentId} value={document.documentId}>{title(document)}</option>)}</select></label><label className="workflow-field">任务<textarea aria-label={`步骤 ${index + 1} 任务`} rows={3} maxLength={4000} placeholder="说明这一步要完成的具体修改…" value={step.task} onChange={event => updateStep(step.stepId, { task: event.target.value })} /></label>
            <div className="workflow-step-settings"><label>Agent 数量<select aria-label={`步骤 ${index + 1} Agent 数量`} value={step.agentCount} onChange={event => updateStep(step.stepId, { agentCount: Number(event.target.value) })}>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count}</option>)}</select></label>{documents.find(item => item.documentId === step.documentId)?.format === 'pptx' && <label>任务方式<select aria-label={`步骤 ${index + 1} 任务方式`} value={step.mode} onChange={event => updateStep(step.stepId, { mode: event.target.value as 'edit' | 'rebuild' })}><option value="edit">编辑内容</option><option value="rebuild">整份 PPT 重做</option></select></label>}</div>
            <label className="workflow-checkbox"><input type="checkbox" checked={step.generateImages} onChange={event => updateStep(step.stepId, { generateImages: event.target.checked })} />允许生成配图</label>
            {index > 0 && <details className="workflow-dependencies"><summary>开始条件与共享输入<ChevronDown size={12} /></summary>{steps.slice(0, index).map((previous, previousIndex) => <label key={previous.stepId}><input type="checkbox" checked={step.dependsOn.includes(previous.stepId)} onChange={event => updateStep(step.stepId, { dependsOn: event.target.checked ? [...step.dependsOn, previous.stepId] : step.dependsOn.filter(id => id !== previous.stepId) })} />等待步骤 {previousIndex + 1}</label>)}{[...facts.map(fact => ({ key: fact.key, label: fact.label })), ...steps.slice(0, index).filter(previous => previous.output).map(previous => ({ key: `output-${previous.stepId}`, label: `步骤 ${steps.indexOf(previous) + 1} 的产出` }))].map(input => <label key={input.key}><input type="checkbox" checked={step.consumes.includes(input.key)} onChange={event => updateStep(step.stepId, { consumes: event.target.checked ? [...step.consumes, input.key] : step.consumes.filter(key => key !== input.key) })} />使用：{input.label}</label>)}<p className="workflow-caption">同一文档按步骤顺序编辑；使用前一步的产出时自动等待该步骤。其他文档可并行执行，共享最多 4 个 Agent。</p></details>}
            {step.output ? <div className="workflow-selected-content"><span><strong>共享给后续步骤</strong><small>{step.output.label}</small></span><button type="button" aria-label={`移除步骤 ${index + 1} 产出`} onClick={() => { updateStep(step.stepId, { output: undefined }); setSteps(previous => previous.map(item => ({ ...item, consumes: item.consumes.filter(key => key !== `output-${step.stepId}`) }))) }}><X size={13} /></button></div> : <button type="button" className="workflow-add-output" disabled={step.mode === 'rebuild'} onClick={() => setPicker({ documentId: step.documentId, stepId: step.stepId })}><Plus size={12} />选择完成后共享的文字</button>}
            {picker?.stepId === step.stepId && currentPicker && <WorkflowContentPicker key={`${step.stepId}:${currentPicker.documentId}`} session={currentPicker} output onSelect={output => { updateStep(step.stepId, { output }); setPicker(null) }} />}
          </article>)}
          {!steps.length && <p className="workflow-caption">先添加步骤，再选择编辑目标、协同人数与依赖。</p>}
          <button type="submit" className="primary workflow-save" disabled={selected.length < 2 || !!missing.length || !steps.length || !name.trim() || steps.some(step => !step.task.trim())}>保存计划并核对</button>
          <p className="workflow-caption">保存计划不会调用模型。文档逐份提交，失败保留已有结果；补偿前会重新核对人工修改。</p>
        </fieldset>
      </form>
    </>}
    {!!busy && <p className="workflow-busy" role="status"><LoaderCircle size={13} className="agent-spinner" />{busy}…</p>}
  </section>
}
