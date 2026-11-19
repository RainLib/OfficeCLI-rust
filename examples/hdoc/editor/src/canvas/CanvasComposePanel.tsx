import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Grid2X2, LayoutList, MessageCircle, Sparkles, Workflow, X } from 'lucide-react'
import type { Composition } from './model.ts'
import { BrushSwatch, StickerIllustration } from './CanvasStickers.tsx'
import './composition.css'

const manualLayouts = [
  { id: 'grid', label: '卡片网格', detail: '整理想法与资料', icon: Grid2X2 },
  { id: 'flow', label: '流程分镜', detail: '清楚表达步骤', icon: Workflow },
  { id: 'timeline', label: '纵向路线', detail: '梳理阶段与计划', icon: LayoutList },
] as const
const example = '做一页春日观察手账，记下树梢开花和蝴蝶到访的过程，留出可以补画和写字的地方。'
const kinds = [{ id: 'bubble', label: '对话气泡' }, { id: 'card', label: '简洁卡片' }, { id: 'note', label: '灵感便签' }] as const

export function CanvasComposePanel({ aiAllowed, scoped, motionPaused, onAppend, onAsk, onClose }: {
  aiAllowed: boolean
  scoped: boolean
  motionPaused: boolean
  onAppend: (value: Composition) => Promise<void>
  onAsk: (prompt: string, count: number) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<'manual' | 'ai'>(aiAllowed ? 'ai' : 'manual')
  const [layout, setLayout] = useState<Composition['layout']>('grid')
  const [kind, setKind] = useState<Composition['items'][number]['kind']>('bubble')
  const [title, setTitle] = useState('让想法生长'), [content, setContent] = useState('')
  const [prompt, setPrompt] = useState(''), [count, setCount] = useState(1), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean)
  const items = lines.map(line => {
    const split = line.indexOf('|')
    return { title: (split < 0 ? line : line.slice(0, split)).trim(), body: split < 0 ? '' : line.slice(split + 1).trim(), kind }
  })
  async function submit() {
    setError('')
    if (mode === 'ai') { setBusy(true); try { await onAsk(prompt.trim(), count); onClose() } catch (cause) { setError(String(cause)); setBusy(false) }; return }
    if (!lines.length || lines.length > 12) { setError('请填写 1–12 条内容，每行一条。'); return }
    if (items.some(item => [...item.title].length > 100 || [...item.body].length > 600)) { setError('卡片标题最多 100 字，说明最多 600 字。'); return }
    setBusy(true)
    try { await onAppend({ title: title.trim(), layout, items }); onClose() }
    catch (cause) { setError(String(cause)); setBusy(false) }
  }
  return <dialog ref={dialog} className="canvas-compose-dialog" data-paused={motionPaused} aria-labelledby="canvas-compose-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header><div><span className="compose-eyebrow"><MessageCircle size={14} />让想法生长</span><h2 id="canvas-compose-title">把想法变成一张白板</h2><p>说出你的想法，AI 会安排内容与画面。</p></div><button type="button" className="icon-button" aria-label="关闭排版" disabled={busy} onClick={onClose}><X size={19} /></button></header>
    <div className="compose-body">
      <section className="compose-settings">
        <div className="compose-mode" role="group" aria-label="创作方式">{aiAllowed && <button type="button" aria-pressed={mode === 'ai'} disabled={busy} onClick={() => setMode('ai')}><Sparkles size={14} />AI 创作</button>}<button type="button" aria-pressed={mode === 'manual'} disabled={busy} onClick={() => setMode('manual')}>直接排版</button></div>
        {mode === 'manual' && <label>分区标题<input autoFocus aria-label="分区标题" maxLength={100} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>}
        {mode === 'manual' && <><fieldset disabled={busy}><legend>排版方式</legend><div className="compose-layouts">{manualLayouts.map(option => <button type="button" key={option.id} aria-pressed={layout === option.id} onClick={() => setLayout(option.id)}><option.icon size={19} /><strong>{option.label}</strong><small>{option.detail}</small></button>)}</div></fieldset>
        <fieldset disabled={busy}><legend>内容样式</legend><div className="compose-kinds">{kinds.map(option => <button type="button" key={option.id} aria-pressed={kind === option.id} onClick={() => setKind(option.id)}>{option.label}{kind === option.id && <Check size={13} />}</button>)}</div></fieldset></>}
        {mode === 'manual' ? <label>内容 <small>每行一张卡片。只写说明时以 | 开头，单独一行 | 可留空卡片。</small><textarea aria-label="排版内容" rows={5} placeholder="例如：发现问题 | 从使用者的真实需要出发" maxLength={8500} value={content} disabled={busy} onChange={event => setContent(event.target.value)} /><small>{lines.length}/12 条 · 生成后可逐个编辑</small></label> : <>
          <label>描述你的想法<textarea autoFocus aria-label="追加内容要求" rows={6} maxLength={6000} disabled={busy} placeholder={example} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
          <button type="button" className="compose-example" disabled={busy} onClick={() => setPrompt(example)}>试试这个例子</button>
          <div className="compose-auto-note">AI 会判断适合的内容结构，搭配纸张、笔触与贴纸，安排留白和少量动态点缀。你也可以直接描述喜欢的感觉。</div>
          <details className="compose-advanced"><summary>协作设置</summary><label className="compose-workers">分区协作<select aria-label="排版协同人数" disabled={busy} value={count} onChange={event => setCount(Number(event.target.value))}>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n === 1 ? '1 Agent · 连续创作' : `${n} Agent · 分区并行`}</option>)}</select></label>
          <small className="compose-help">多个 Agent 各自准备分区内容，完成后统一排版。切换标签页仍可在全局 AI 中查看任务。</small></details>
        </>}
      </section>
      <aside className="compose-preview" aria-label="排版样式预览"><span>{mode === 'ai' ? '视觉示意 · AI 会根据你的需求设计' : '版式预览'}</span>{mode === 'ai' ? <div className="compose-journal-preview"><StickerIllustration motif="petals" motion="auto" /><h3><BrushSwatch brush="watercolor" /><span>春日观察手记</span></h3><div className="compose-journal-notes"><div><strong>树梢的第一朵花</strong><p>花心微黄，外缘泛粉。<br />留下今天的颜色。</p></div><div><strong>一只蝴蝶停下来</strong><p>记下它收起翅膀的样子。</p><StickerIllustration motif="butterfly" motion="auto" /></div></div></div> : <div className="compose-preview-board" data-layout={layout} data-kind={kind}><h3>{title.trim() || '新的想法'}</h3><div className="compose-preview-items">{(items.length ? items.slice(0,3) : ['发现','连接','行动'].map(title => ({title,body:''}))).map((item,index) => <div className="compose-preview-card" key={index}>{item.title && <strong>{item.title}</strong>}{item.body && <p>{item.body}</p>}{layout === 'flow' && index + 1 < (items.length || 3) && index < 2 && <ArrowRight size={16} />}</div>)}</div></div>}<p><Check size={15} />自动换行、对齐与留白<br /><Check size={15} />AI 搭配笔触与贴纸<br /><Check size={15} />追加前检查目标空位</p></aside>
    </div>
    {error && <p role="alert" className="compose-error">{error}</p>}
    <footer><small>{scoped ? '追加到框选区域内的空位。' : mode === 'ai' ? '生成后可继续编辑，进度显示在右侧 AI。' : '新增在已有内容右侧，自动避开已有对象。'}</small><button type="button" className="compose-submit primary" disabled={busy || (mode === 'ai' ? !prompt.trim() : !title.trim() || !lines.length)} onClick={() => void submit()}>{mode === 'ai' ? <Sparkles size={15} /> : <MessageCircle size={15} />}{busy ? '正在启动…' : mode === 'ai' ? '生成到白板' : '追加到白板'}<ArrowRight size={15} /></button></footer>
  </dialog>
}
