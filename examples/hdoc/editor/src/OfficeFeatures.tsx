import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import { ArrowRightLeft, BookOpen, FileText, ListTree, Printer, Ruler, X } from 'lucide-react'
import { api, type Session } from './api'
import { readCapabilities } from './capabilities'
import './office-features.css'

export type WordPageLayout = { widthTwips: number; heightTwips: number; topTwips: number; rightTwips: number; bottomTwips: number; leftTwips: number; headerTwips: number; footerTwips: number; gutterTwips: number }
export type WordAnchor = { blockId: string; offset: number; paragraphHash: string; before: string; after: string }
export type WordToc = { title: string; firstLevel: number; lastLevel: number }
export type WordNote = { id: string; number: number; text: string; anchor: WordAnchor | null; anchorChanged: boolean }
export type WordOffice = { sections: { index: number; layout: WordPageLayout; blockIds: string[] }[]; toc: WordToc | null; tocBlockIds: string[]; headings: { blockId: string; level: number; text: string }[]; footnotes: WordNote[] }
export type PrintLayout = { paperSize: number; landscape: boolean; scale: number | null; fitWidth: number; fitHeight: number; leftInches: number; rightInches: number; topInches: number; bottomInches: number; headerInches: number; footerInches: number; printArea: string | null; repeatRows: [number, number] | null; repeatColumns: [number, number] | null; gridlines: boolean; headings: boolean; centerHorizontal: boolean; centerVertical: boolean }
export type SlideTransition = { kind: 'none' | 'fade' | 'push' | 'wipe' | 'cut'; direction: 'left' | 'right' | 'up' | 'down'; durationMs: number; advanceOnClick: boolean; advanceAfterMs: number | null }
export type OfficeSnapshot = { protocolVersion: string; revision: number; word: WordOffice | null; sheets: { sheetId: string; sheetName: string; sheetIndex: number; layout: PrintLayout }[]; slides: { chunkId: string; index: number; transition: SlideTransition; unsupportedNative: boolean }[] }
type Action = { op: 'word.pageLayout.set'; sections: number[]; layout: WordPageLayout } | { op: 'word.toc.set'; settings: WordToc | null } | { op: 'word.footnote.set'; id: string; note: { text: string | null; anchor: WordAnchor | null } } | { op: 'xlsx.printLayout.set'; sheetId: string; layout: PrintLayout } | { op: 'pptx.transition.set'; chunkIds: string[]; transition: SlideTransition }
type Mode = 'margins' | 'toc' | 'footnote' | 'print' | 'transition'
const titles = { margins: '页边距与纸张', toc: '目录', footnote: '脚注', print: '打印布局', transition: '幻灯片转场' }

const snapshots = new WeakMap<Session, { revision: number | undefined; promise: Promise<OfficeSnapshot> }>()
async function loadUncached(session: Session, revision?: number) {
  const capabilities = await readCapabilities(session)
  if (capabilities.officeFeatures?.protocolVersion !== 'office-features/1') throw new Error('当前服务尚未支持 Office 页面设置，请更新服务。')
  return await (await api(session, '/office-features' + (revision === undefined ? '' : `?revision=${revision}`), { signal: AbortSignal.timeout(15000) })).json() as OfficeSnapshot
}
function load(session: Session, revision?: number) {
  const cached = snapshots.get(session)
  if (cached && cached.revision === revision) return cached.promise
  const promise = loadUncached(session, revision)
  snapshots.set(session, { revision, promise })
  void promise.catch(() => { if (snapshots.get(session)?.promise === promise) snapshots.delete(session) })
  return promise
}
export function useOfficeSnapshot(session: Session, revision: number | null) {
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null)
  useEffect(() => {
    if (revision === null || !['docx', 'xlsx', 'pptx'].includes(session.format)) return
    let current = true
    void load(session, revision).then(value => { if (current) setSnapshot(value) }).catch(() => { if (current) setSnapshot(null) })
    return () => { current = false }
  }, [session, revision])
  return snapshot
}
async function captureAnchor(editor: Editor): Promise<WordAnchor> {
  const { $to } = editor.state.selection
  let depth = $to.depth
  while (depth > 0 && !$to.node(depth).attrs.hcdBlockId) depth--
  if (!depth || !$to.node(depth).isTextblock) throw new Error('请先将光标放在正文段落中。')
  const node = $to.node(depth), text = node.textContent, utf16 = $to.pos - $to.start(depth)
  const before = Array.from(text.slice(0, utf16)), after = Array.from(text.slice(utf16))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return { blockId: node.attrs.hcdBlockId, offset: before.length, paragraphHash: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''), before: before.slice(-32).join(''), after: after.slice(0, 32).join('') }
}
export function OfficeFeatureTools({ session, mode, disabled, beforeEdit, afterEdit, editor, sheetId, selectedArea, chunkId }: {
  session: Session; mode: 'layout' | 'references' | 'print' | 'transition'; disabled: boolean
  beforeEdit: () => Promise<number | null>; afterEdit: (revision: number) => void | Promise<void>; editor?: Editor | null
  sheetId?: string; selectedArea?: string; chunkId?: string
}) {
  const [draft, setDraft] = useState<{ mode: Mode; snapshot: OfficeSnapshot; anchor?: WordAnchor } | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const [opening, setOpening] = useState(false), [error, setError] = useState('')
  async function open(mode: Mode) {
    if (disabled || opening) return
    setOpening(true); setError('')
    try {
      const revision = await beforeEdit()
      if (revision === null) throw new Error('请先完成当前编辑。')
      const snapshot = await load(session, revision)
      const anchor = mode === 'footnote' && editor ? await captureAnchor(editor).catch(() => undefined) : undefined
      setDraft({ mode, snapshot, anchor })
    } catch (cause) { setError(String(cause)) } finally { setOpening(false) }
  }
  const button = (kind: Mode, label: string, icon: ReactNode) => <button type="button" disabled={disabled || opening} onClick={() => void open(kind)}>{icon}<span>{label}</span></button>
  return <>
    <div className="office-feature-tools" ref={container}>
      {mode === 'layout' && button('margins', '页边距', <Ruler size={18}/>)}
      {mode === 'references' && <>{button('toc', '目录', <ListTree size={18}/>)}{button('footnote', '插入脚注', <BookOpen size={18}/>)}</>}
      {mode === 'print' && button('print', '打印布局', <Printer size={18}/>)}
      {mode === 'transition' && button('transition', '转场效果', <ArrowRightLeft size={18}/>)}
    </div>
    {error && <div className="office-feature-error" role="alert">{error}<button aria-label="关闭设置错误" onClick={() => setError('')}><X size={14}/></button></div>}
    {draft && <FeatureDialog container={container.current?.closest('.hcd-surface') ?? document.body} title={titles[draft.mode]} onClose={() => setDraft(null)} session={session} snapshot={draft.snapshot} afterEdit={afterEdit}>
      {(submit, busy) => draft.mode === 'margins' && draft.snapshot.word ? <MarginForm word={draft.snapshot.word} editor={editor} submit={submit} busy={busy}/>
        : draft.mode === 'toc' && draft.snapshot.word ? <TocForm word={draft.snapshot.word} submit={submit} busy={busy}/>
        : draft.mode === 'footnote' && draft.snapshot.word ? <FootnoteForm word={draft.snapshot.word} anchor={draft.anchor} submit={submit} busy={busy}/>
        : draft.mode === 'print' ? <PrintForm snapshot={draft.snapshot} sheetId={sheetId} selectedArea={selectedArea} submit={submit} busy={busy}/>
        : draft.mode === 'transition' ? <TransitionForm snapshot={draft.snapshot} chunkId={chunkId} submit={submit} busy={busy}/> : <p>当前文件不支持此设置。</p>}
    </FeatureDialog>}
  </>
}
type Submit = (action: Action) => Promise<void>
function FeatureDialog({ container, title, children, session, snapshot, onClose, afterEdit }: { container: Element; title: string; children: (submit: Submit, busy: boolean) => ReactNode; session: Session; snapshot: OfficeSnapshot; onClose: () => void; afterEdit: (r: number) => void | Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useLayoutEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  async function submit(action: Action) {
    setBusy(true); setError('')
    try {
      const receipt = await (await api(session, '/office-features', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(session.collaborationEpoch ?? 0) }, body: JSON.stringify({ protocolVersion: 'office-features/1', baseRevision: snapshot.revision, patchId: crypto.randomUUID(), action }) })).json() as { revision: number }
      await afterEdit(receipt.revision); onClose()
    } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  return createPortal(<dialog ref={ref} className="office-feature-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header><span className="office-feature-heading"><FileText size={19}/><strong>{title}</strong></span><button type="button" aria-label="关闭页面设置" disabled={busy} onClick={onClose}><X size={18}/></button></header>
    {children(submit, busy)}{error && <p className="office-feature-validation" role="alert">{error}</p>}
  </dialog>, container)
}
function Numeric({ label, value, onChange, min = 0, max = 28, step = .01 }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number }) {
  return <label>{label}<input type="number" aria-label={label} value={Number(value.toFixed(2))} min={min} max={max} step={step} required onChange={event => onChange(event.currentTarget.valueAsNumber)}/></label>
}
const finish = (busy: boolean, label = '应用设置') => <footer><small>设置随文件保存</small><button className="primary" type="submit" disabled={busy}>{busy ? '保存中…' : label}</button></footer>
function MarginForm({ word, editor, submit, busy }: { word: WordOffice; editor?: Editor | null; submit: Submit; busy: boolean }) {
  const blockId = editor?.state.selection.$from.parent.attrs.hcdBlockId
  const section = word.sections.find(s => s.blockIds.includes(blockId)) ?? word.sections[0]
  const [layout, setLayout] = useState(section.layout), [all, setAll] = useState(true)
  const update = (key: keyof WordPageLayout, value: number) => setLayout(old => ({ ...old, [key]: value }))
  const portrait = layout.widthTwips < layout.heightTwips
  return <form onSubmit={e => { e.preventDefault(); void submit({ op: 'word.pageLayout.set', sections: all ? word.sections.map(s => s.index) : [section.index], layout }) }}>
    <div className="office-feature-body office-two-columns"><section><h3>纸张</h3><label>纸张大小<select aria-label="Word 纸张大小" value={Math.max(layout.widthTwips, layout.heightTwips) === 16838 ? 'a4' : Math.max(layout.widthTwips, layout.heightTwips) === 15840 ? 'letter' : 'custom'} onChange={e => { const size = e.target.value === 'a4' ? [11906, 16838] : [12240, 15840]; setLayout(old => ({ ...old, widthTwips: size[portrait ? 0 : 1], heightTwips: size[portrait ? 1 : 0] })) }}><option value="a4">A4 · 21 × 29.7 厘米</option><option value="letter">Letter · 21.59 × 27.94 厘米</option><option value="custom" disabled>原文档自定义纸张</option></select></label>
      <label>方向<select aria-label="Word 纸张方向" value={portrait ? 'portrait' : 'landscape'} onChange={() => setLayout(old => ({ ...old, widthTwips: old.heightTwips, heightTwips: old.widthTwips }))}><option value="portrait">纵向</option><option value="landscape">横向</option></select></label>
      <h3>页边距 <small>厘米</small></h3><div className="office-presets">{[['普通', 1440], ['窄', 720], ['宽', 2160]].map(([label, value]) => <button key={label} type="button" onClick={() => setLayout(old => ({ ...old, topTwips: Number(value), bottomTwips: Number(value), leftTwips: Number(value), rightTwips: Number(value) }))}>{label}</button>)}</div>
      <div className="office-field-grid">{(['topTwips', 'bottomTwips', 'leftTwips', 'rightTwips', 'headerTwips', 'footerTwips', 'gutterTwips'] as const).map((key, i) => <Numeric key={key} label={['上边距', '下边距', '左边距', '右边距', '页眉距边界', '页脚距边界', '装订线'][i]} value={layout[key] / 1440 * 2.54} onChange={v => update(key, Math.round(v / 2.54 * 1440))}/> )}</div>
      {word.sections.length > 1 && <label className="office-check"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)}/>应用到全部 {word.sections.length} 节（取消后仅第 {section.index} 节）</label>}
    </section><section className="office-page-demo"><div style={{ aspectRatio: `${layout.widthTwips}/${layout.heightTwips}`, padding: `${layout.topTwips / layout.widthTwips * 100}% ${layout.rightTwips / layout.widthTwips * 100}% ${layout.bottomTwips / layout.widthTwips * 100}% ${layout.leftTwips / layout.widthTwips * 100}%` }}><span>{Array.from({ length: 12 }, (_, i) => <i key={i}/>)}</span></div><small>页边距示意</small></section></div>{finish(busy)}
  </form>
}
function TocForm({ word, submit, busy }: { word: WordOffice; submit: Submit; busy: boolean }) {
  const [toc, setToc] = useState<WordToc>(word.toc ?? { title: '目录', firstLevel: 1, lastLevel: 3 })
  return <form onSubmit={e => { e.preventDefault(); void submit({ op: 'word.toc.set', settings: toc }) }}><div className="office-feature-body"><label>目录标题<input aria-label="目录标题" maxLength={128} value={toc.title} onChange={e => setToc({ ...toc, title: e.target.value })}/></label><div className="office-field-grid"><Numeric label="起始标题级别" value={toc.firstLevel} onChange={firstLevel => setToc({ ...toc, firstLevel })} min={1} max={9} step={1}/><Numeric label="结束标题级别" value={toc.lastLevel} onChange={lastLevel => setToc({ ...toc, lastLevel })} min={toc.firstLevel} max={9} step={1}/></div>
    <div className="office-toc-preview">{word.headings.filter(h => h.level >= toc.firstLevel && h.level <= toc.lastLevel).map(h => <div key={h.blockId} style={{ paddingLeft: (h.level - toc.firstLevel) * 18 }}>{h.text}</div>)}{!word.headings.length && <p>将正文设为标题，目录会自动读取这些标题。</p>}</div><p className="office-feature-help">插入可跳转的原生 Word 目录域。正文修改后可更新目录；不显示未经排版核对的页码。</p>{word.toc && <button type="button" className="office-danger" disabled={busy} onClick={() => void submit({ op: 'word.toc.set', settings: null })}>删除目录</button>}</div>{finish(busy, word.toc ? '更新目录' : '插入目录')}</form>
}
function FootnoteForm({ word, anchor, submit, busy }: { word: WordOffice; anchor?: WordAnchor; submit: Submit; busy: boolean }) {
  const [id, setId] = useState('new'), [text, setText] = useState('')
  return <form onSubmit={e => { e.preventDefault(); void submit({ op: 'word.footnote.set', id: id === 'new' ? crypto.randomUUID() : id, note: { text, anchor: id === 'new' ? anchor ?? null : null } }) }}><div className="office-feature-body">
    <label>脚注位置<select aria-label="选择脚注" value={id} onChange={e => { setId(e.target.value); setText(word.footnotes.find(n => n.id === e.target.value)?.text ?? '') }}><option value="new" disabled={!anchor}>光标处插入脚注</option>{word.footnotes.map(n => <option key={n.id} value={n.id}>脚注 {n.number} · {n.text.slice(0, 32)}{n.anchorChanged ? ' · 需核对锚点' : ''}</option>)}</select></label>
    {id === 'new' && !anchor && <p role="status">请先将光标放在正文段落，再插入脚注。</p>}
    <label>脚注内容<textarea aria-label="脚注内容" rows={5} maxLength={4096} required value={text} onChange={e => setText(e.target.value)}/></label><p className="office-feature-help">编号跟随正文位置，导出为原生脚注。正文与脚注分别编辑。</p>
    {id !== 'new' && <button className="office-danger" type="button" disabled={busy} onClick={() => void submit({ op: 'word.footnote.set', id, note: { text: null, anchor: null } })}>删除脚注</button>}</div>{finish(busy || id === 'new' && !anchor || !text.trim(), id === 'new' ? '插入脚注' : '保存脚注')}</form>
}
function col(value: number) { let result = ''; while (value) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26) } return result }
function parseColumns(value: string): [number, number] | null { if (!value.trim()) return null; const match = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/.exec(value); if (!match) throw new Error('重复列格式应为 A:C'); const num = (s: string) => Array.from(s.toUpperCase()).reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); return [num(match[1]), num(match[2])] }
function PrintForm({ snapshot, sheetId, selectedArea, submit, busy }: { snapshot: OfficeSnapshot; sheetId?: string; selectedArea?: string; submit: Submit; busy: boolean }) {
  const sheet = snapshot.sheets.find(s => s.sheetId === sheetId) ?? snapshot.sheets[0]
  const [layout, setLayout] = useState(sheet?.layout), [rows, setRows] = useState(sheet?.layout.repeatRows?.join(':') ?? ''), [columns, setColumns] = useState(sheet?.layout.repeatColumns?.map(col).join(':') ?? ''), [validation, setValidation] = useState('')
  if (!sheet || !layout) return <p>当前工作表还未就绪。</p>
  const update = <K extends keyof PrintLayout>(key: K, value: PrintLayout[K]) => setLayout(old => old && ({ ...old, [key]: value }))
  return <form onSubmit={e => { e.preventDefault(); try { const match = /^\$?(\d+):\$?(\d+)$/.exec(rows); if (rows.trim() && !match) throw new Error('重复行格式应为 1:2'); void submit({ op: 'xlsx.printLayout.set', sheetId: sheet.sheetId, layout: { ...layout, repeatRows: match ? [Number(match[1]), Number(match[2])] : null, repeatColumns: parseColumns(columns) } }) } catch (cause) { setValidation(String(cause)) } }}><div className="office-feature-body"><p className="office-feature-help">工作表：{sheet.sheetName}</p><div className="office-field-grid"><label>纸张<select aria-label="打印纸张" value={layout.paperSize} onChange={e => update('paperSize', Number(e.target.value))}>{[[9, 'A4'], [8, 'A3'], [1, 'Letter'], [5, 'Legal'], [11, 'A5']].map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label><label>方向<select aria-label="打印方向" value={String(layout.landscape)} onChange={e => update('landscape', e.target.value === 'true')}><option value="false">纵向</option><option value="true">横向</option></select></label></div>
    <h3>缩放</h3><label>缩放方式<select aria-label="打印缩放方式" value={layout.scale === null ? 'fit' : 'scale'} onChange={e => update('scale', e.target.value === 'fit' ? null : 100)}><option value="fit">调整为指定页数</option><option value="scale">指定缩放百分比</option></select></label><div className="office-field-grid">{layout.scale === null ? <><Numeric label="横向页数（0 为自动）" value={layout.fitWidth} onChange={n => update('fitWidth', n)} max={100} step={1}/><Numeric label="纵向页数（0 为自动）" value={layout.fitHeight} onChange={n => update('fitHeight', n)} max={100} step={1}/></> : <Numeric label="缩放百分比" value={layout.scale} onChange={n => update('scale', n)} min={10} max={400} step={1}/>}</div>
    <h3>打印范围与标题</h3><label>打印区域<input aria-label="打印区域" placeholder="留空则打印已用区域，例如 A1:H20" value={layout.printArea ?? ''} onChange={e => update('printArea', e.target.value.trim() || null)}/></label>{selectedArea && <button type="button" onClick={() => update('printArea', selectedArea)}>使用当前选区 {selectedArea}</button>}<div className="office-field-grid"><label>顶端重复行<input aria-label="顶端重复行" placeholder="1:2" value={rows} onChange={e => setRows(e.target.value)}/></label><label>左端重复列<input aria-label="左端重复列" placeholder="A:B" value={columns} onChange={e => setColumns(e.target.value)}/></label></div>
    <h3>页边距 <small>厘米</small></h3><div className="office-field-grid">{(['topInches', 'bottomInches', 'leftInches', 'rightInches', 'headerInches', 'footerInches'] as const).map((key, i) => <Numeric key={key} label={['打印上边距', '打印下边距', '打印左边距', '打印右边距', '打印页眉距离', '打印页脚距离'][i]} value={layout[key] * 2.54} onChange={n => update(key, n / 2.54)} max={25}/>)}</div><div className="office-field-grid">{(['gridlines', 'headings', 'centerHorizontal', 'centerVertical'] as const).map((key, i) => <label key={key} className="office-check"><input type="checkbox" checked={layout[key]} onChange={e => update(key, e.target.checked)}/>{['打印网格线', '打印行号列标', '水平居中', '垂直居中'][i]}</label>)}</div>{validation && <p role="alert">{validation}</p>}</div>{finish(busy)}</form>
}
export const transitionLabels = { none: '无', fade: '淡化', push: '推进', wipe: '擦除', cut: '切换' }
function TransitionForm({ snapshot, chunkId, submit, busy }: { snapshot: OfficeSnapshot; chunkId?: string; submit: Submit; busy: boolean }) {
  const slide = snapshot.slides.find(s => s.chunkId === chunkId) ?? snapshot.slides[0]
  const [transition, setTransition] = useState(slide?.transition), [all, setAll] = useState(false), [preview, setPreview] = useState(0)
  if (!slide || !transition) return <p>请先选择一张幻灯片。</p>
  const update = <K extends keyof SlideTransition>(key: K, value: SlideTransition[K]) => setTransition(old => old && ({ ...old, [key]: value }))
  return <form onSubmit={e => { e.preventDefault(); void submit({ op: 'pptx.transition.set', chunkIds: all ? snapshot.slides.map(s => s.chunkId) : [slide.chunkId], transition }) }}><div className="office-feature-body">{slide.unsupportedNative && <p className="office-feature-help">此页包含高级原生转场。应用后仅替换转场，保留对象动画。</p>}<div className="office-transition-choices">{Object.entries(transitionLabels).map(([kind, title]) => <button type="button" key={kind} aria-pressed={transition.kind === kind} onClick={() => { update('kind', kind as SlideTransition['kind']); setPreview(p => p + 1) }}><span className={`transition-icon transition-icon-${kind}`}><i/><i/></span>{title}</button>)}</div>
    <div className="office-transition-demo"><div key={preview} className={`office-transition-frame transition-${transition.kind}`} style={{ '--transition-duration': `${transition.durationMs}ms`, '--transition-x': transition.direction === 'right' ? '-100%' : transition.direction === 'left' ? '100%' : '0%', '--transition-y': transition.direction === 'down' ? '-100%' : transition.direction === 'up' ? '100%' : '0%', '--wipe-inset': transition.direction === 'right' ? '0 0 0 100%' : transition.direction === 'up' ? '100% 0 0 0' : transition.direction === 'down' ? '0 0 100% 0' : '0 100% 0 0' } as CSSProperties}>Aa<small>幻灯片 {slide.index}</small></div></div><button type="button" onClick={() => setPreview(p => p + 1)}>预览转场</button>
    <div className="office-field-grid"><label>效果方向<select aria-label="转场方向" disabled={!['push', 'wipe'].includes(transition.kind)} value={transition.direction} onChange={e => update('direction', e.target.value as SlideTransition['direction'])}>{[['left', '向左'], ['right', '向右'], ['up', '向上'], ['down', '向下']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><Numeric label="转场持续时间（秒）" value={transition.durationMs / 1000} onChange={n => update('durationMs', Math.round(n * 1000))} min={.05} max={10} step={.05}/></div>
    <h3>换片方式</h3><label className="office-check"><input type="checkbox" aria-label="单击鼠标换片" checked={transition.advanceOnClick} onChange={e => update('advanceOnClick', e.target.checked)}/>单击鼠标换片</label><label className="office-check"><input type="checkbox" aria-label="自动换片" checked={transition.advanceAfterMs !== null} onChange={e => update('advanceAfterMs', e.target.checked ? 5000 : null)}/>设置自动换片时间</label>{transition.advanceAfterMs !== null && <Numeric label="自动换片间隔（秒）" value={transition.advanceAfterMs / 1000} onChange={n => update('advanceAfterMs', Math.round(n * 1000))} min={.1} max={3600} step={.1}/>}
    <label className="office-check"><input type="checkbox" aria-label="应用到全部幻灯片" checked={all} onChange={e => setAll(e.target.checked)}/>应用到全部 {snapshot.slides.length} 张幻灯片</label></div>{finish(busy)}</form>
}
