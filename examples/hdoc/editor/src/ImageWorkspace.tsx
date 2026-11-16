import { keepHistory } from './editHistory.ts'
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type CSSProperties } from 'react'
import { ArrowDownToLine, ArrowUpRight, Check, CheckCheck, CloudCheck, Crop, Eraser, Expand, FlipHorizontal2, FlipVertical2, Grid2X2, History, Image as ImageIcon, LoaderCircle, LockKeyhole, Maximize, Minus, MousePointer2, PanelRightClose, PanelRightOpen, Paintbrush, Plus, Redo2, RotateCcw, RotateCw, SlidersHorizontal, Sparkles, Undo2, Users, X } from 'lucide-react'
import { api, type Session } from './api.ts'
import { HostPublicationControl, permits } from './HostIntegration.tsx'
import { ExportControl } from './ExportControl.tsx'
import { AppearanceSelect } from './Appearance.tsx'
import { ImageRenderer, blankEdits, base64Blob, downloadImage, imageFileSize, type ImageEdits } from './imageRender.ts'
import { ImageMaskFlow } from './ImageMaskFlow.tsx'
import { InputDraftRecovery, useInputDraft } from './useInputDraft.tsx'
import { type InputDraft } from './inputDraftJournal.ts'
import { parseImageInput, type ImageInput, type ImageStroke as Stroke } from './imageDraft.ts'
import './image-workspace.css'

type Info = { revision: number; width: number; height: number; format: string; bytes: number; sourceBytes: number; hasAlpha: boolean; aiAvailable: boolean; aiReason?: string; imageModel: string; planningModel: string; exportFormats: string[]; maxAgents: number }
type Worker = { name: string; role: string; status: string; message: string; position: [number, number] }
type Job = { jobId: string; sourceRevision: number; owner: string; status: string; prompt: string; agents: Worker[]; region: number[]; error?: string; model: string; planningModel: string; createdAtEpochMs: number }
type Panel = 'info' | 'crop' | 'adjust' | 'ai' | 'inpaint' | 'compare' | 'convert' | 'export' | 'history'
type Copy = { documentId: string; token: string; title: string }
const ongoing = (j: Job) => ['queued', 'planning', 'generating', 'checking'].includes(j.status)
const panelTitle: Record<Panel, string> = { info: '图像', crop: '裁剪与旋转', adjust: '光线与色彩', ai: 'AI 工作台', inpaint: '局部重绘', compare: '候选对比', convert: '转换格式', export: '导出图片', history: '版本记录' }
const stageText: Record<string, string> = { queued: '等待区域', planning: '读取与规划', generating: '正在生成候选', checking: '正在检查边界', ready: '候选已就绪', applying: '正在应用候选', applied: '已应用到当前版本', interrupted: '已中断，区域已释放', failed: '生成失败', cancelled: '已取消，区域已释放', discarded:'候选已丢弃' }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="image-field"><span>{label}</span>{children}</label> }
function Slider({ label, value, min = -100, max = 100, suffix = '', onChange }: { label: string; value: number; min?: number; max?: number; suffix?: string; onChange: (v: number) => void }) { return <label className="image-slider"><span>{label}<output>{value}{suffix}</output></span><input aria-label={label} type="range" min={min} max={max} value={value} onChange={e => onChange(+e.target.value)} /></label> }
function IconButton({ label, children, onClick, disabled }: { label: string; children: React.ReactNode; onClick: () => void; disabled?: boolean }) { return <button type="button" className="im-icon" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button> }

function ImageAgentPointer({ agent, scale, index }: { agent: Worker; scale: number; index: number }) {
  const ref=useRef<HTMLDivElement>(null), position=useRef<[number,number]>([.12+index*.05,.18+index*.04])
  useEffect(()=>{
    const node=ref.current;if(!node || agent.status!=='running')return
    const from=[...position.current],to=agent.position,start=performance.now(),reduced=matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame=0
    const draw=(now:number)=>{const t=reduced?1:Math.min(1,(now-start)/420),u=1-t
      const x=u*u*u*from[0]+3*u*u*t*(from[0]+(to[0]-from[0])*.3)+3*u*t*t*(to[0]-.018)+t*t*t*to[0]
      const y=u*u*u*from[1]+3*u*u*t*(from[1]-.025)+3*u*t*t*(to[1]-.045)+t*t*t*to[1]
      position.current=[x,y];node.style.left=`${x*100}%`;node.style.top=`${y*100}%`;if(t<1)frame=requestAnimationFrame(draw)
    };frame=requestAnimationFrame(draw);return()=>cancelAnimationFrame(frame)
  },[agent.status,agent.position[0],agent.position[1]])
  return <div ref={ref} className="image-agent-pointer" aria-hidden={agent.status!=='running'} style={{ opacity:agent.status==='running'?1:0, '--pointer-scale':1/scale, '--pointer-color':['#8264b8','#27866a','#ad8245','#5865c7'][index%4] } as CSSProperties}><MousePointer2 size={20} fill="currentColor" /><span>{agent.name}</span></div>
}

export function ImageWorkspace({ session, onClose, onOpenDocument }: { session: Session; onClose: () => void; onOpenDocument?: (id: string, token: string, title?: string) => void }) {
  const [info, setInfo] = useState<Info | null>(null), [source, setSource] = useState<Blob | null>(null)
  const [edits, setEdits] = useState<ImageEdits>(() => blankEdits(1, 1)), [undo, setUndo] = useState<ImageEdits[]>([]), [redo, setRedo] = useState<ImageEdits[]>([])
  const [editing, setEditing] = useState(false), [panel, setPanel] = useState<Panel>('info'), [panelOpen, setPanelOpen] = useState(true)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(''), [stale, setStale] = useState<number | null>(null)
  const [view, setView] = useState({ scale: .5, x: 0, y: 0 }), [background, setBackground] = useState(false)
  const [aspect, setAspect] = useState('free'), [sizeLocked, setSizeLocked] = useState(true)
  const [brush, setBrush] = useState(48), [feather, setFeather] = useState(8), [erase, setErase] = useState(false), [maskCount, setMaskCount] = useState(0)
  const [prompt, setPrompt] = useState(''), [agentCount, setAgentCount] = useState(3), [jobs, setJobs] = useState<Job[]>([]), [selectedJob, setSelectedJob] = useState<string | null>(null)
  const [sharedMask,setSharedMask]=useState<HTMLCanvasElement|null>(null)
  const [candidate, setCandidate] = useState(''), [compare, setCompare] = useState(50), [showMask, setShowMask] = useState(false)
  const [format, setFormat] = useState('webp'), [quality, setQuality] = useState(90), [transparent, setTransparent] = useState(true), [fill, setFill] = useState('#ffffff')
  const [exportWidth, setExportWidth] = useState(1), [exportHeight, setExportHeight] = useState(1), [convertOriginal, setConvertOriginal] = useState(false), [filename, setFilename] = useState('')
  const [result, setResult] = useState<{ blob: Blob; filename: string; copy?: Copy; width: number; height: number } | null>(null)
  const [cropSelection, setCropSelection] = useState<[number, number, number, number] | null>(null)
  const [maskSequence, setMaskSequence] = useState(0), [conversionPending, setConversionPending] = useState(false)
  const inputProtection = useInputDraft(session, session.collaborationEpoch)
  const protectionRef = useRef(inputProtection); protectionRef.current = inputProtection
  const [revisions, setRevisions] = useState<Array<{ revision: number; authorName?: string }>>([]), [historyRevision, setHistoryRevision] = useState<number | null>(null), [historyUrl, setHistoryUrl] = useState('')
  const viewport = useRef<HTMLDivElement>(null), plane = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), maskDisplay = useRef<HTMLCanvasElement>(null)
  const rawMask = useRef<HTMLCanvasElement | null>(null), strokes = useRef<Stroke[]>([]), renderer = useRef<ImageRenderer | null>(null)
  const infoRef = useRef(info); infoRef.current = info
  const editsRef = useRef(edits); editsRef.current = edits
  const viewRef = useRef(view); viewRef.current = view
  const interacted = useRef(false), space = useRef(false), gestures = useRef(new Map<number, [number, number]>())
  const drag = useRef<{ type: 'pan' | 'paint' | 'crop'; start: [number, number]; view: typeof view; cropStart?: [number, number] } | null>(null)
  const loaded = useRef(false), requestNo = useRef(0), seenReady = useRef(new Set<string>())
  const readOnly = session.scope !== 'write'
  const aiEnabled = !session.hostIntegration && !!info?.aiAvailable
  const hasHistory = permits(session, 'history.view')
  const canExport = permits(session, 'document.download') || permits(session, 'document.export')
  const title = session.title || `${session.documentId}.${session.format}`
  const dirty = !!info && JSON.stringify(edits) !== JSON.stringify(blankEdits(info.width, info.height))
  const hasInput = dirty || strokes.current.length > 0 || !!cropSelection || !!prompt || conversionPending
  const job = jobs.find(j => j.jobId === selectedJob) || jobs.at(-1)
  const running = !!job && ongoing(job), generating = running && job.status !== 'queued'
  const inpaintMode = ['ai', 'inpaint'].includes(panel) && editing
  const canPaint = inpaintMode && !running && !dirty && !readOnly && !busy
  const dimensions = { width: edits.width, height: edits.height }
  const epochHeaders = { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(session.collaborationEpoch ?? 0) }
  const render = useCallback((options: Parameters<ImageRenderer['render']>[0]) => {
    renderer.current ||= new ImageRenderer(); return renderer.current.render(options)
  }, [])
  useEffect(() => () => { renderer.current?.close(); renderer.current = null }, [])
  const fit = useCallback(() => {
    const el = viewport.current, e = editsRef.current
    if (!el || !el.clientWidth || !el.clientHeight) return
    setView({ scale: Math.min(1, Math.max(.02, Math.min((el.clientWidth - (el.clientWidth < 600 ? 16 : 160)) / e.width, (el.clientHeight - (el.clientWidth < 600 ? 32 : 180)) / e.height))), x: 0, y: 0 })
  }, [])
  const liveSession = useRef(session); liveSession.current = session
  const reload = useCallback(async (receipt = protectionRef.current.capture()) => {
    const session = liveSession.current
    const metadata = await (await api(session, '/image')).json() as Info
    const blob = await (await api(session, `/image/content?revision=${metadata.revision}`)).blob()
    const bitmap = await createImageBitmap(blob); bitmap.close()
    if (!protectionRef.current.unchanged(receipt)) { setStale(metadata.revision); throw new Error('读取期间输入已变化；当前草稿已保留，请核对后再读取最新版本。') }
    setInfo(metadata); setSource(blob); setEdits(blankEdits(metadata.width, metadata.height)); setUndo([]); setRedo([]); setStale(null)
    setExportWidth(metadata.width); setExportHeight(metadata.height)
    rawMask.current = document.createElement('canvas'); rawMask.current.width = metadata.width; rawMask.current.height = metadata.height
    strokes.current = []; setMaskCount(0); setMaskSequence(n => n + 1); setCropSelection(null); if(maskDisplay.current)maskDisplay.current.getContext('2d')?.clearRect(0,0,maskDisplay.current.width,maskDisplay.current.height)
  }, [session.documentId, session.apiUrl])
  useEffect(() => { let active = true; void reload().then(() => { if (active) { loaded.current = true; requestAnimationFrame(fit) } }).catch(e => { if (active) setError(String(e)) }); return () => { active = false } }, [reload, fit])
  useEffect(() => {
    if (!info || !source) return
    const input: ImageInput | null = hasInput ? {
      schemaVersion: 'hcd-image-input/1', baseRevision: info.revision, width: info.width, height: info.height,
      edits, strokes: strokes.current, cropSelection, prompt, agentCount, brush, feather, erase,
      conversion: conversionPending ? { format, quality, transparent, fill, width: exportWidth, height: exportHeight, original: convertOriginal, filename } : null,
    } : null
    protectionRef.current.write(input)
  }, [info, source, edits, maskSequence, cropSelection, prompt, agentCount, brush, feather, erase, conversionPending, format, quality, transparent, fill, exportWidth, exportHeight, convertOriginal, filename, hasInput, session.token])
  async function restoreInput(record: InputDraft) {
    if (!info || busy || running || readOnly || hasInput) throw new Error('请先保存或重置当前草稿，再恢复输入')
    setBusy('正在恢复草稿')
    try {
      const input = parseImageInput(record.content), receipt = await inputProtection.validate(record)
      const current = await (await api(session, '/image')).json() as Info
      if (!inputProtection.unchanged(receipt) || current.revision !== info.revision || current.revision !== input.baseRevision || current.width !== input.width || current.height !== input.height) throw new Error('图片版本或尺寸已变化；原草稿已保留，请下载核对')
      await inputProtection.adopt(record)
      strokes.current = input.strokes
      rawMask.current = document.createElement('canvas'); rawMask.current.width = input.width; rawMask.current.height = input.height
      for (const s of input.strokes) for (let i = 0; i < s.points.length; i++) paintSegment(s, s.points[Math.max(0, i - 1)], s.points[i])
      setMaskCount(input.strokes.filter(s => !s.erase).length); setMaskSequence(n => n + 1)
      setEdits(input.edits); setUndo([]); setRedo([]); setCropSelection(input.cropSelection); setPrompt(input.prompt); setAgentCount(input.agentCount); setBrush(input.brush); setFeather(input.feather); setErase(input.erase)
      const c = input.conversion
      setConversionPending(!!c)
      if (c) { setFormat(c.format); setQuality(c.quality); setTransparent(c.transparent); setFill(c.fill); setExportWidth(c.width); setExportHeight(c.height); setConvertOriginal(c.original); setFilename(c.filename) }
      setPanel(c ? 'convert' : input.strokes.length || input.prompt ? 'inpaint' : input.cropSelection ? 'crop' : 'adjust'); setPanelOpen(true); setEditing(true)
      setNotice('已找回图片草稿；尚未保存或重新请求模型。')
    } finally { setBusy('') }
  }
  useEffect(() => {
    if (!source) return
    let active = true; const request = ++requestNo.current
    const timer = setTimeout(() => { void render({ source, edits, preview: true }).then(async blob => {
      const image = await createImageBitmap(blob)
      if (active && request === requestNo.current && canvas.current) { const c = canvas.current; if (c.width !== image.width) c.width = image.width; if (c.height !== image.height) c.height = image.height; const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(image, 0, 0) }
      image.close()
    }).catch(e => { if (active) setError(String(e)) }) }, 32)
    return () => { active = false; clearTimeout(timer) }
  }, [source, edits, render])
  useEffect(() => {
    const node = viewport.current; if (!node) return
    const observer = new ResizeObserver(() => { if (!interacted.current && loaded.current) fit() }); observer.observe(node)
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); interacted.current = true
      const rect = node.getBoundingClientRect(), old = viewRef.current, scale = Math.max(.02, Math.min(8, old.scale * Math.exp(-event.deltaY * .0015)))
      const x = event.clientX - rect.left - rect.width / 2, y = event.clientY - rect.top - rect.height / 2, ratio = scale / old.scale
      setView({ scale, x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio })
    }
    const gesture = (e: Event) => e.preventDefault()
    node.addEventListener('wheel', wheel, { passive: false }); node.addEventListener('gesturestart', gesture, { passive: false }); node.addEventListener('gesturechange', gesture, { passive: false })
    const key = (e: KeyboardEvent) => { if (!(e.target instanceof HTMLElement) || !e.target.closest('input,textarea,select,[contenteditable=true]')) { if (e.code === 'Space') { space.current = e.type === 'keydown'; if (e.type === 'keydown' && document.activeElement === node) e.preventDefault() } } }
    const brushKeys=(e:KeyboardEvent)=>{if(e.target instanceof HTMLElement && e.target.closest('input,textarea,select'))return;if(e.key==='[')setBrush(n=>Math.max(4,n-4));if(e.key===']')setBrush(n=>Math.min(240,n+4))}
    window.addEventListener('keydown',brushKeys)
    const blur = () => { space.current = false; drag.current = null; gestures.current.clear() }
    window.addEventListener('keydown', key); window.addEventListener('keyup', key); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown',brushKeys); observer.disconnect(); node.removeEventListener('wheel', wheel); node.removeEventListener('gesturestart', gesture); node.removeEventListener('gesturechange', gesture); window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); window.removeEventListener('blur', blur) }
  }, [fit])
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const data = session.hostIntegration ? { jobs: [] as Job[] } : await (await api(session, '/image/jobs')).json() as { jobs: Job[] }
        if (!active) return
        setJobs(old => JSON.stringify(old) === JSON.stringify(data.jobs) ? old : data.jobs)
        for (const j of data.jobs) { if (['ready', 'interrupted'].includes(j.status) && !seenReady.current.has(j.jobId)) { seenReady.current.add(j.jobId); setSelectedJob(j.jobId); setNotice(j.status === 'interrupted' ? '服务已重启，图片任务已中断、区域锁已释放；请核对草稿和候选。' : '候选已生成，可对比后应用。') } }
        const meta = await (await api(session, '')).json() as { revision:number }
        if (active && infoRef.current && meta.revision !== infoRef.current.revision) setStale(meta.revision)
      } catch (e) { if (active) setNotice(`协作状态暂时不可用：${String(e)}`) }
      if (active) timer = setTimeout(poll, 1800)
    }
    void poll(); return () => { active = false; clearTimeout(timer) }
  }, [session])
  useEffect(() => {
    if (!job || !['ready', 'applied'].includes(job.status)) { setCandidate(''); return }
    let active = true, url = ''
    void api(session, `/image/jobs/${job.jobId}/content`).then(r => r.blob()).then(blob => { if (active) { url = URL.createObjectURL(blob); setCandidate(url) } }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [session, job?.jobId, job?.status])
  useEffect(()=>{
    setSharedMask(null);if(!job)return
    let active=true
    void api(session,`/image/jobs/${job.jobId}/mask`).then(r=>r.blob()).then(createImageBitmap).then(bitmap=>{if(active){const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;c.getContext('2d')!.drawImage(bitmap,0,0);setSharedMask(c)}bitmap.close()}).catch(e=>{if(active)setError(String(e))})
    return()=>{active=false}
  },[session,job?.jobId])
  useEffect(()=>{
    if(!showMask || panel!=='compare'||!sharedMask||!maskDisplay.current)return
    const c=maskDisplay.current;c.width=sharedMask.width;c.height=sharedMask.height;const ctx=c.getContext('2d')!;ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle='rgba(163,138,201,.48)';ctx.fillRect(0,0,c.width,c.height);ctx.globalCompositeOperation='destination-in';ctx.drawImage(sharedMask,0,0);ctx.globalCompositeOperation='source-over'
  },[showMask,panel,sharedMask])
  useEffect(() => {
    if (panel !== 'history') return
    void api(session, '/revisions').then(r => r.json()).then(data => setRevisions(data.revisions || data.items || [])).catch(e => setError(String(e)))
  }, [panel, session, info?.revision])
  useEffect(() => {
    if (historyRevision === null) { setHistoryUrl(''); return }
    let active = true, url = ''
    void api(session, `/image/content?revision=${historyRevision}`).then(r => r.blob()).then(b => { if (active) { url = URL.createObjectURL(b); setHistoryUrl(url) } }).catch(e => setError(String(e)))
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [historyRevision, session])
  function edit(patch: Partial<ImageEdits>) { if (readOnly || busy || running) return; setUndo(old => keepHistory([...old, edits])); setRedo([]); setEdits(old => ({ ...old, ...patch })); setError('') }
  function undoEdit() { const prev = undo.at(-1); if (prev) { setRedo(old => keepHistory([...old, edits])); setEdits(prev); setUndo(old => old.slice(0, -1)) } }
  function redoEdit() { const next = redo.at(-1); if (next) { setUndo(old => keepHistory([...old, edits])); setEdits(next); setRedo(old => old.slice(0, -1)) } }
  function openPanel(next: Panel) { if (busy || (['ai', 'inpaint', 'compare'].includes(next) && !aiEnabled) || (next === 'history' && !hasHistory) || (['convert', 'export'].includes(next) && session.hostIntegration)) return; if (next !== panel) setResult(null); setPanel(next); setPanelOpen(true); setHistoryRevision(null); if (['crop', 'adjust', 'ai', 'inpaint', 'compare'].includes(next)) setEditing(true); if ((next === 'export' || next === 'convert') && !conversionPending) { setConversionPending(true); setExportWidth(edits.width); setExportHeight(edits.height); setFilename(title.replace(/\.[^.]+$/, '')); } }
  function resize(value: number, axis: 'width' | 'height', exporting = false) {
    if (!Number.isFinite(value) || value < 1 || value > 8192) return
    const ratio = exporting ? exportWidth / exportHeight : edits.width / edits.height
    if (exporting) { if (axis === 'width') { setExportWidth(value); if (sizeLocked) setExportHeight(Math.max(1, Math.round(value / ratio))) } else { setExportHeight(value); if (sizeLocked) setExportWidth(Math.max(1, Math.round(value * ratio))) } }
    else edit({ [axis]: value, ...(sizeLocked ? axis === 'width' ? { height: Math.max(1, Math.round(value / ratio)) } : { width: Math.max(1, Math.round(value * ratio)) } : {}) })
  }
  const task = async (label: string, callback: () => Promise<void>) => { if (busy) return; setBusy(label); setError(''); try { await callback() } catch (e) { setError(String(e)) } finally { setBusy('') } }
  const saveCurrent = async (): Promise<number | null> => {
    if (busy || !info || !source) return null
    if (cropSelection) { setError('请先应用裁剪范围，再保存图片调整。'); return null }
    if (!dirty) return info.revision
    if (readOnly || running) return null
    setBusy('正在保存版本'); setError('')
    const receipt = inputProtection.capture()
    try {
      const blob = await render({ source, edits })
      await api(session, '/image/commit', { method: 'POST', headers: epochHeaders, body: JSON.stringify({ expectedRevision: info.revision, png: await base64Blob(blob) }) })
      await reload(receipt); inputProtection.acknowledge(receipt); setNotice('编辑已保存为新版本。')
      return (await (await api(session, '')).json() as { revision: number }).revision
    } catch (cause) { setError(String(cause)); return null } finally { setBusy('') }
  }
  const save = () => saveCurrent()
  function drawMask() {
    const raw = rawMask.current, target = maskDisplay.current; if (!raw || !target) return
    if (target.width !== raw.width) target.width = raw.width; if (target.height !== raw.height) target.height = raw.height
    const ctx = target.getContext('2d')!; ctx.clearRect(0, 0, target.width, target.height); ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = 'rgba(163,138,201,.48)'; ctx.fillRect(0, 0, target.width, target.height); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(raw, 0, 0); ctx.globalCompositeOperation = 'source-over'
  }
  function paintSegment(stroke: Stroke, from: [number, number], to: [number, number]) {
    const ctx = rawMask.current!.getContext('2d')!; ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'; ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = stroke.size; ctx.beginPath(); ctx.moveTo(...from); ctx.lineTo(...to); ctx.stroke(); ctx.beginPath(); ctx.arc(to[0], to[1], stroke.size / 2, 0, Math.PI * 2); ctx.fill(); drawMask()
  }
  function undoMask() { if (busy) return; strokes.current.pop(); const c = rawMask.current; if (c) { c.getContext('2d')!.clearRect(0, 0, c.width, c.height); for (const s of strokes.current) for (let i = 0; i < s.points.length; i++) paintSegment(s, s.points[Math.max(0, i - 1)], s.points[i]); drawMask() } setMaskCount(strokes.current.filter(s => !s.erase).length); setMaskSequence(n => n + 1) }
  function clearMask() { strokes.current = []; const c = rawMask.current; if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height); drawMask(); setMaskCount(0); setMaskSequence(n => n + 1) }
  function point(event: ReactPointerEvent): [number, number] { const rect = plane.current!.getBoundingClientRect(); return [Math.max(0, Math.min(edits.width, (event.clientX - rect.left) / view.scale)), Math.max(0, Math.min(edits.height, (event.clientY - rect.top) / view.scale))] }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (busy) return
    if ((event.target as HTMLElement).closest('input,button')) return
    event.currentTarget.setPointerCapture(event.pointerId); gestures.current.set(event.pointerId, [event.clientX, event.clientY]); interacted.current = true
    if (gestures.current.size > 1) { drag.current = null; return }
    if (event.button === 1 || space.current || !editing || !['crop', 'ai', 'inpaint'].includes(panel) || running) { drag.current = { type: 'pan', start: [event.clientX, event.clientY], view }; return }
    if (canPaint) { const p = point(event); if (!rawMask.current || p[0] === 0 || p[1] === 0 || p[0] === edits.width || p[1] === edits.height) return; const s = { points: [p], size: brush, erase }; strokes.current.push(s); paintSegment(s, p, p); setMaskSequence(n => n + 1); drag.current = { type: 'paint', start: p, view }; return }
    if (panel === 'crop' && !readOnly && !busy && !edits.crop && edits.rotation === 0 && !edits.flipX && !edits.flipY) { setUndo(old => keepHistory([...old, edits])); setRedo([]); drag.current = { type: 'crop', start: [event.clientX, event.clientY], view, cropStart: [point(event)[0] / edits.width * (info?.width || edits.width), point(event)[1] / edits.height * (info?.height || edits.height)] } }
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const previous = gestures.current.get(event.pointerId)
    if (previous && gestures.current.size === 2) {
      const other = [...gestures.current.entries()].find(([id]) => id !== event.pointerId)![1], oldDistance = Math.hypot(previous[0] - other[0], previous[1] - other[1]), newDistance = Math.hypot(event.clientX - other[0], event.clientY - other[1])
      gestures.current.set(event.pointerId, [event.clientX, event.clientY]); if (oldDistance > 0) setView(v => ({ ...v, scale: Math.max(.02, Math.min(8, v.scale * newDistance / oldDistance)) })); return
    }
    const d = drag.current; if (!d) return
    if (d.type === 'pan') setView({ ...d.view, x: d.view.x + event.clientX - d.start[0], y: d.view.y + event.clientY - d.start[1] })
    if (d.type === 'paint') { const s = strokes.current.at(-1)!; const p = point(event); paintSegment(s, s.points.at(-1)!, p); s.points.push(p); setMaskSequence(n => n + 1) }
    if (d.type === 'crop' && d.cropStart && info) {
      // Selection stays in source coordinates. Applying it is a separate action.
      const rect = plane.current!.getBoundingClientRect(), x = Math.max(0, Math.min(info.width, (event.clientX - rect.left) / rect.width * info.width)), y = Math.max(0, Math.min(info.height, (event.clientY - rect.top) / rect.height * info.height))
      let w = Math.abs(x - d.cropStart[0]), h = Math.abs(y - d.cropStart[1])
      if (aspect !== 'free') { const [a, b] = aspect.split(':').map(Number); h = Math.min(h, w * b / a); w = h * a / b }
      const left=Math.round(x<d.cropStart[0]?d.cropStart[0]-w:d.cropStart[0]),top=Math.round(y<d.cropStart[1]?d.cropStart[1]-h:d.cropStart[1]);const next: [number, number, number, number] = [left,top,Math.max(1,Math.min(info.width-left,Math.round(w))),Math.max(1,Math.min(info.height-top,Math.round(h)))]
      setCropSelection(next)
    }
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) { gestures.current.delete(event.pointerId); if (drag.current?.type === 'paint') { setMaskCount(strokes.current.filter(s => !s.erase).length) } drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }
  function cropApply() { if (cropSelection) { edit({ crop: cropSelection, width: cropSelection[2], height: cropSelection[3] }); setCropSelection(null); clearMask() } }
  const generate = () => task('正在提交局部重绘', async () => {
    if (!info || !rawMask.current || dirty) return
    const blob = await new Promise<Blob>((resolve, reject) => rawMask.current!.toBlob(b => b ? resolve(b) : reject(new Error('蒙版编码失败')), 'image/png'))
    const response = await api(session, '/image/jobs', { method: 'POST', headers: epochHeaders, body: JSON.stringify({ expectedRevision: info.revision, mask: await base64Blob(blob), prompt, agents: agentCount, feather }) })
    const next = await response.json() as Job; setJobs(old => [...old, next]); setSelectedJob(next.jobId); setNotice('任务已提交，候选生成后可对比。')
  })
  const applyCandidate = () => task('正在应用候选', async () => {
    if (!job || !info) return
    const receipt = inputProtection.capture()
    await api(session, `/image/jobs/${job.jobId}/apply`, { method: 'POST', headers: epochHeaders, body: JSON.stringify({ expectedRevision: info.revision }) }); await reload(receipt); inputProtection.acknowledge(receipt); setPrompt(''); setPanel('info'); setEditing(false); setNotice('局部重绘已保存为新版本。')
  })
  const convert = () => task('正在编码图片', async () => {
    if (!info || !source) return
    let input = source, params = edits
    if (convertOriginal) { input = await (await api(session, '/image/content?revision=0')).blob(); const bitmap = await createImageBitmap(input); params = blankEdits(bitmap.width, bitmap.height); bitmap.close() }
    const blob = await render({ source: input, edits: { ...params, width: exportWidth, height: exportHeight }, format: `image/${format}`, quality, transparent, background: fill })
    // Decode the actual output before offering success or a new tab.
    const bitmap = await createImageBitmap(blob), width = bitmap.width, height = bitmap.height; bitmap.close()
    if (width !== exportWidth || height !== exportHeight) throw new Error('输出图片尺寸不一致')
    const name = `${filename.trim().replace(/\.[^.]+$/, '') || '图片'}${panel === 'convert' ? '-转换' : '-副本'}.${format === 'jpeg' ? 'jpg' : format}`
    setResult({ blob, filename: name, width, height })
    if (!readOnly) { const copy = await (await api(session, '/image/copies', { method: 'POST', headers: epochHeaders, body: JSON.stringify({ filename: name, data: await base64Blob(blob) }) })).json() as Copy; setResult({ blob, filename: name, width, height, copy }) }
    setNotice('已核对输出编码与尺寸，原文件保留。')
  })
  const reset = () => { if (info) { edit(blankEdits(info.width, info.height)); setCropSelection(null) } }
  function discardCurrent() {
    if (!info || busy || running || readOnly) return
    setEdits(blankEdits(info.width, info.height)); setUndo([]); setRedo([]); setCropSelection(null); clearMask(); setPrompt(''); setConversionPending(false); setResult(null)
    inputProtection.write(null); setNotice('已舍弃当前图片草稿。')
  }
  const setZoom = (scale: number) => { interacted.current = true; setView(v => ({ ...v, scale: Math.max(.02, Math.min(8, scale)) })) }
  const cropStyle = cropSelection ? { left: `${cropSelection[0] / (info?.width || edits.width) * 100}%`, top: `${cropSelection[1] / (info?.height || edits.height) * 100}%`, width: `${cropSelection[2] / (info?.width || edits.width) * 100}%`, height: `${cropSelection[3] / (info?.height || edits.height) * 100}%` } : undefined
  const compareVisible = panel === 'compare' && !!candidate, historicalVisible = panel === 'history' && !!historyUrl
  return <section className="image-workspace" aria-label="图片工作台">
    <header className="image-header">
      <button className="im-collection" onClick={onClose}><PanelRightOpen size={16} /><span>图片集</span></button>
      <div className="im-title"><strong>{title}</strong><small>工作空间 / 品牌素材 <CloudCheck size={13} />{busy || (dirty ? '编辑草稿' : `原图已保留 · r${info?.revision ?? '…'}`)}</small></div>
      <div className="im-mode"><button aria-pressed={editing} onClick={() => { if (!readOnly) { setEditing(true); if (panel === 'info') openPanel('crop') } }} disabled={readOnly}>编辑</button><button aria-pressed={!editing} onClick={() => { setEditing(false); setPanel('info'); setHistoryRevision(null) }}>预览</button></div>
      <div className="im-header-actions"><details className="im-profile-menu"><summary aria-label="界面与主题"><span>{session.displayName?.slice(0,1)||'我'}</span></summary><div><AppearanceSelect /></div></details><HostPublicationControl session={session} revision={info?.revision ?? null} beforeSave={saveCurrent} />{aiEnabled && <button onClick={() => openPanel('ai')} className="im-collaborate"><Users size={16} /><span>协作 · {running ? job.agents.length : agentCount}</span></button>}{hasHistory && <IconButton label="版本记录" onClick={() => openPanel('history')}><History size={17} /></IconButton>}{canExport && (session.hostIntegration ? <ExportControl session={session} revision={info?.revision ?? null} beforeExport={saveCurrent} /> : <button className="im-dark" onClick={() => openPanel('export')}><ArrowUpRight size={16} />导出</button>)}<button className="im-panel-toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen(v => !v)}>{panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}<span>面板</span></button></div>
    </header>
    <div className="image-input-recovery"><InputDraftRecovery protection={inputProtection} disabled={!info || readOnly || !!busy || running || hasInput} onRestore={restoreInput} onError={setError} />{hasInput && !readOnly && <div className="image-draft-status"><span role="status" aria-label="图片草稿保护状态" data-protection={inputProtection.status}>{({ loading: '正在准备本地保护', writing: '正在保护图片草稿', protected: '图片草稿已保存在此浏览器', failed: '图片草稿尚未受到保护' })[inputProtection.status]}</span><button disabled={!!busy || running} onClick={discardCurrent}>舍弃当前图片草稿</button></div>}</div>
    <div className="image-body">
      <main className="image-stage-panel">
        <nav className="image-toolbar" aria-label="图片工具" inert={!!busy}>
          {!editing ? <><button className="im-soft" onClick={() => { interacted.current = false; fit() }}><Maximize size={15} />适合窗口</button><button onClick={() => setZoom(1)}><Expand size={15} />原始大小</button><span className="im-spacer" />{!session.hostIntegration && <button onClick={() => openPanel('convert')}><Grid2X2 size={15} />转换格式</button>}<IconButton label="切换透明背景" onClick={() => setBackground(v => !v)}><Grid2X2 size={15} /></IconButton><button className="im-dark" onClick={() => openPanel('crop')} disabled={readOnly}><SlidersHorizontal size={15} />开始编辑</button></> : inpaintMode ? <><button className="im-soft" onClick={() => openPanel('inpaint')}><Paintbrush size={15} />局部重绘</button><button className={!erase ? 'im-soft' : ''} aria-pressed={!erase} onClick={() => setErase(false)} disabled={running}><Paintbrush size={15} />涂抹</button><button aria-pressed={erase} className={erase ? 'im-soft' : ''} onClick={() => setErase(true)} disabled={running}><Eraser size={15} />擦除</button><IconButton label="撤销蒙版" onClick={undoMask} disabled={!maskCount || running}><Undo2 size={15} /></IconButton><span className="im-spacer" /><button onClick={clearMask} disabled={!maskCount || running}><RotateCcw size={15} />清空蒙版</button></> : <><button className={panel === 'crop' ? 'im-soft' : ''} onClick={() => openPanel('crop')}><Crop size={15} />裁剪与旋转</button><button className={panel === 'adjust' ? 'im-soft' : ''} onClick={() => openPanel('adjust')}><SlidersHorizontal size={15} />光线与色彩</button>{aiEnabled && <button className={panel === 'ai' ? 'im-soft' : ''} onClick={() => openPanel('ai')}><Sparkles size={15} />AI 修图</button>}<span className="im-spacer" /><IconButton label="撤销编辑" onClick={undoEdit} disabled={!undo.length || !!busy || running}><Undo2 size={15} /></IconButton><IconButton label="重做编辑" onClick={redoEdit} disabled={!redo.length || !!busy || running}><Redo2 size={15} /></IconButton></>}
        </nav>
        <div className={`image-canvas-viewport${background ? ' im-checker' : ''}${canPaint ? ' im-painting' : ''}`} ref={viewport} role="region" tabIndex={0} aria-label="图片画布，滚轮缩放，空格拖动" onDoubleClick={() => { if (!canPaint) { interacted.current = false; fit() } }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
          {!source && <div className="im-loading" role="status"><LoaderCircle size={22} />正在载入原图…</div>}
          <div className="image-pixel-plane" ref={plane} data-image-plane="true" style={{ width: dimensions.width, height: dimensions.height, transform: `translate(calc(-50% + ${view.x}px),calc(-50% + ${view.y}px)) scale(${view.scale})` }}>
            <canvas ref={canvas} className="image-pixels" aria-label="当前图片" />
            {historicalVisible && <img src={historyUrl} className="image-candidate" alt={`版本 ${historyRevision}`} style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }} />}
            {compareVisible && <img src={candidate} className="image-candidate" alt="局部重绘候选" style={{ clipPath: `inset(0 0 0 ${compare}%)` }} />}
            {(compareVisible || historicalVisible) && <div className="image-compare-line" style={{ left: `${compare}%` }}><button className="image-compare-handle" aria-label="拖动图像对比" style={{ transform: `scale(${1 / view.scale})` }} onPointerDown={e=>{e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId)&&plane.current){const r=plane.current.getBoundingClientRect();setCompare(Math.max(0,Math.min(100,(e.clientX-r.left)/r.width*100)))}}} onPointerUp={e=>{e.stopPropagation();if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)}}>↔</button></div>}
            <canvas ref={maskDisplay} className="image-mask" hidden={!(inpaintMode || showMask) || generating} />
            <ImageMaskFlow mask={sharedMask || rawMask.current} active={generating} />
            {panel === 'crop' && cropSelection && <div className="image-crop-selection" style={cropStyle}><i /><i /><i /><i /></div>}
            {running && job.agents.map((a, index) => <ImageAgentPointer key={`${job.jobId}:${a.name}`} agent={a} scale={view.scale} index={index} />)}
          </div>
        </div>
        {(compareVisible || historicalVisible) && <label className="image-compare-control"><span>{historicalVisible ? `r${historyRevision}` : '原图'}</span><input type="range" aria-label="拖动对比分割线" min={0} max={100} value={compare} onChange={e => setCompare(+e.target.value)} /><span>{historicalVisible ? '当前版本' : '候选'}</span></label>}
        <div className="image-stage-caption"><span><ImageIcon size={14} />{title}</span><small>{inpaintMode ? '涂抹需要修改的位置 · [ / ] 调整画笔 · 空格平移' : panel === 'crop' && !edits.crop ? '拖动框选裁剪区域 · 空格平移' : '滚轮缩放 · 空格拖动 · 双击适合窗口'}</small></div>
      </main>
      <aside className="image-drawer" hidden={!panelOpen} aria-label={panelTitle[panel]}>
        <div className="image-drawer-head"><h2>{panelTitle[panel]}</h2><IconButton label="收起图片面板" onClick={() => setPanelOpen(false)}><PanelRightClose size={17} /></IconButton></div>
        <div className="image-drawer-scroll" inert={!!busy}>
        {panel === 'info' && <>
          <nav className="im-segments"><button aria-pressed onClick={() => openPanel('info')}>信息</button><button disabled={readOnly} onClick={() => openPanel('crop')}>编辑</button><button disabled={readOnly} onClick={() => openPanel('ai')}>AI 修图</button></nav>
          <h3 className="im-editorial">每一处细节，都清晰。</h3><p>查看原图，或直接开始编辑。<br />你的原始图片始终保留。</p>
          <dl className="image-metadata"><dt>尺寸</dt><dd>{info?.width} × {info?.height} px</dd><dt>格式</dt><dd>{info?.format.toUpperCase()}</dd><dt>源文件大小</dt><dd>{imageFileSize(info?.sourceBytes || 0)}</dd><dt>工作色彩空间</dt><dd>sRGB</dd><dt>透明通道</dt><dd>{info?.hasAlpha ? '支持透明区域' : '不含透明通道'}</dd></dl>
          <hr /><p>快速操作</p><div className="im-quick-actions"><button onClick={() => openPanel('crop')} disabled={readOnly}><Crop size={16} />裁剪与旋转</button><button onClick={() => openPanel('convert')}><Expand size={16} />调整大小与画质</button><button onClick={() => openPanel('adjust')} disabled={readOnly}><SlidersHorizontal size={16} />色彩与光线</button></div>
        </>}
        {panel === 'crop' && <><p>保留构图，让画面恰到好处。</p><Field label="裁剪比例"><select aria-label="裁剪比例" value={aspect} onChange={e => setAspect(e.target.value)}><option value="free">自由裁剪</option>{['1:1', '4:3', '3:2', '16:9', '9:16'].map(v => <option key={v}>{v}</option>)}</select></Field><p className="im-note">在图片上拖动选择范围，再应用裁剪。</p><button className="im-soft im-wide" onClick={cropApply} disabled={!cropSelection || readOnly}>应用裁剪范围</button>{edits.crop && <button className="im-wide" onClick={reset}>重置裁剪</button>}<hr /><h3>旋转与翻转</h3><div className="im-transform-buttons"><IconButton label="逆时针旋转" onClick={() => { edit({ rotation: (edits.rotation + 270) % 360, width: edits.height, height: edits.width }); clearMask() }} disabled={readOnly || running}><RotateCcw size={19} /></IconButton><IconButton label="顺时针旋转" onClick={() => { edit({ rotation: (edits.rotation + 90) % 360, width: edits.height, height: edits.width }); clearMask() }} disabled={readOnly || running}><RotateCw size={19} /></IconButton><IconButton label="水平翻转" onClick={() => { edit({ flipX: !edits.flipX }); clearMask() }} disabled={readOnly || running}><FlipHorizontal2 size={19} /></IconButton><IconButton label="垂直翻转" onClick={() => { edit({ flipY: !edits.flipY }); clearMask() }} disabled={readOnly || running}><FlipVertical2 size={19} /></IconButton></div><hr /><h3>图像尺寸</h3><div className="im-dimensions"><Field label="宽度 px"><input type="number" aria-label="图片宽度" value={edits.width} onChange={e => resize(+e.target.value, 'width')} /></Field><span>×</span><Field label="高度 px"><input type="number" aria-label="图片高度" value={edits.height} onChange={e => resize(+e.target.value, 'height')} /></Field></div><label className="im-checkbox"><input type="checkbox" checked={sizeLocked} onChange={e => setSizeLocked(e.target.checked)} />锁定宽高比例</label></>}
        {panel === 'adjust' && <><p>轻一点调整，留下真实质感。</p><h3>光线</h3>{([['exposure', '曝光'], ['contrast', '对比度'], ['highlights', '高光'], ['shadows', '阴影']] as const).map(([key, label]) => <Slider key={key} label={label} value={edits[key]} onChange={v => edit({ [key]: v })} />)}<hr /><h3>色彩</h3>{([['warmth', '色温'], ['saturation', '饱和度']] as const).map(([key, label]) => <Slider key={key} label={label} value={edits[key]} onChange={v => edit({ [key]: v })} />)}<button className="im-wide" onClick={reset} disabled={readOnly || running}><RotateCcw size={15} />重置调整</button></>}
        {['ai', 'inpaint'].includes(panel) && <>
          <p>{running ? '原图、蒙版和提示词已共享给当前任务。' : '涂抹想修改的位置，描述新的效果。'}</p>{panel==='ai'&&!running&&<div className="im-ai-intro"><Sparkles size={22}/><h3>想怎么处理这张图片？</h3><p>选择区域，描述想法。候选会先呈现给你。</p><div><button className="im-soft" onClick={()=>openPanel('inpaint')}><Paintbrush size={14}/>局部重绘</button><button onClick={()=>openPanel('adjust')}><SlidersHorizontal size={14}/>调整光线</button></div></div>}
          {running && <div className="im-shared-task"><p>{job.prompt}</p><small>{job.planningModel} · {job.model} · {job.agents.length} Agent</small></div>}
          <div hidden={running}>
          <Field label="重绘内容"><textarea aria-label="重绘内容" rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述涂抹区域的新效果，例如：将花瓶改为鼠尾草绿釉，保留纹理与反光。" disabled={running || readOnly} /></Field>
          <hr /><h3>画笔与蒙版</h3><Slider label="画笔大小" value={brush} min={4} max={240} suffix=" px" onChange={setBrush} /><Slider label="边缘羽化" value={feather} min={0} max={64} suffix=" px" onChange={setFeather} /><div className="im-assurance"><Check size={15} />只修改涂抹区域</div>
          <dl className="image-metadata"><dt>画面匹配</dt><dd>自动匹配光线与纹理</dd></dl><hr /><dl className="image-metadata"><dt>规划模型</dt><dd>{info?.planningModel}</dd><dt>图像模型</dt><dd>{info?.imageModel}</dd></dl>
          <div className="im-agent-count"><Users size={15} /><span>协作 Agent</span><IconButton label="减少协作 Agent" onClick={() => setAgentCount(n => Math.max(1, n - 1))} disabled={running || agentCount <= 1}><Minus size={13} /></IconButton><output>{agentCount}</output><IconButton label="增加协作 Agent" onClick={() => setAgentCount(n => Math.min(info?.maxAgents || 4, n + 1))} disabled={running || agentCount >= (info?.maxAgents || 4)}><Plus size={13} /></IconButton></div>
          {dirty && <div className="im-notice">请先应用当前编辑，再在新尺寸上涂抹蒙版。<button onClick={() => void save()}>应用当前编辑</button></div>}
          {!info?.aiAvailable && <p className="im-notice">{info?.aiReason || '图像服务尚未就绪'}</p>}
          </div>
          {!!jobs.length && !running && <div className="im-job-history"><h3>当前文档 · 任务记录</h3>{jobs.slice(-6).reverse().map(j => <button className={job?.jobId === j.jobId ? 'selected' : ''} key={j.jobId} onClick={() => { setSelectedJob(j.jobId); if (j.status === 'ready') openPanel('compare') }}><span>{j.prompt}</span><small>{stageText[j.status] || j.status}</small></button>)}</div>}
          {job && <section className="im-team" aria-label="协作任务过程"><strong>{stageText[job.status]}</strong>{job.agents.map(a => <article key={a.name} data-status={a.status}><span>{a.status === 'running' ? <LoaderCircle size={14} /> : a.status === 'done' ? <CheckCheck size={14} /> : <span className="im-step-dot" />}</span><div><b>{a.name}</b><small>{a.role} · {a.status === 'waiting' ? '待操作' : a.status === 'running' ? '操作中' : a.status === 'done' ? '已完成' : '已停止'}</small><p>{a.message}</p></div></article>)}{running && <div className="im-lock"><LockKeyhole size={13} />{job.status === 'queued' ? '等待重叠区域释放' : '区域写入锁 · 完成后自动释放'}</div>}{job.error && <p role="alert">{job.error}</p>}</section>}
        </>}
        {panel === 'compare' && <><p>只改变你选中的部分。</p><div className="im-assurance"><Check size={15} />蒙版外像素保持不变</div><p>{job?.prompt}</p><label className="im-checkbox"><input type="checkbox" checked={showMask} onChange={e => setShowMask(e.target.checked)} />查看涂抹蒙版</label><h3>候选版本</h3><div className="im-candidate-thumbs">{jobs.filter(j => ['ready', 'applied'].includes(j.status)).map((j, i) => <button aria-pressed={j.jobId === job?.jobId} key={j.jobId} onClick={() => setSelectedJob(j.jobId)}><ImageIcon size={20} />候选 {i + 1}<small>基于 r{j.sourceRevision}</small></button>)}</div><hr /><dl className="image-metadata"><dt>来源修订</dt><dd>r{job?.sourceRevision}</dd><dt>图像模型</dt><dd>{job?.model}</dd><dt>结果</dt><dd>尚未覆盖当前文档</dd></dl><button className="im-wide" onClick={() => openPanel('inpaint')}><Paintbrush size={15} />继续局部重绘</button></>}
        {(panel === 'convert' || panel === 'export') && <>
          {result ? <div className="im-conversion-result"><div className="im-success-icon"><Check size={23} /></div><h3>转换完成。</h3><p>原文件保留，新的图片已经就绪。</p><div className="im-result-card"><ImageIcon size={28} /><strong>{result.filename}</strong><span>{result.width} × {result.height} px · {result.blob.type.split('/')[1].toUpperCase()}</span><small>{imageFileSize(result.blob.size)} · 已验证实际编码与尺寸</small></div><button className="im-dark im-wide" onClick={() => downloadImage(result.blob, result.filename)}><ArrowDownToLine size={16} />下载图片</button><button className="im-soft im-wide" disabled={!result.copy || !onOpenDocument} onClick={() => { if (result.copy) onOpenDocument?.(result.copy.documentId, result.copy.token, result.copy.title) }}><ArrowUpRight size={16} />在新标签打开</button><button className="im-wide" disabled={!!busy} onClick={() => setResult(null)}>继续转换</button></div> : <>
            <p>{panel === 'convert' ? '换一种格式，保留每一处细节。' : '将此刻的画面，带到下一个地方。'}</p><div className="im-convert-route"><span>{info?.format.toUpperCase()}</span><ArrowUpRight size={18} /><strong>{format.toUpperCase()}</strong></div>
            <Field label="转换来源"><select aria-label="转换来源" value={convertOriginal ? 'original' : 'current'} onChange={e => setConvertOriginal(e.target.value === 'original')}><option value="current">当前编辑版本</option><option value="original">原图</option></select></Field><h3>目标格式</h3><div className="im-format-options">{(info?.exportFormats || ['png', 'jpeg', 'webp']).map(f => <button key={f} aria-pressed={format === f} onClick={() => setFormat(f)}>{f.toUpperCase()}</button>)}</div>
            <Field label="文件名"><input aria-label="导出文件名" value={filename} onChange={e => setFilename(e.target.value)} /><small>.{format === 'jpeg' ? 'jpg' : format}</small></Field><hr /><h3>图片尺寸</h3><div className="im-dimensions"><Field label="宽度 px"><input type="number" aria-label="导出宽度" value={exportWidth} min={1} max={8192} onChange={e => resize(+e.target.value, 'width', true)} /></Field><span>×</span><Field label="高度 px"><input type="number" aria-label="导出高度" value={exportHeight} min={1} max={8192} onChange={e => resize(+e.target.value, 'height', true)} /></Field></div><label className="im-checkbox"><input type="checkbox" checked={sizeLocked} onChange={e => setSizeLocked(e.target.checked)} />锁定宽高比例</label><hr />
            {format !== 'png' && <Slider label="画质" min={1} max={100} value={quality} suffix="%" onChange={setQuality} />}
            {format === 'jpeg' ? <Field label="透明区域的背景填充"><input aria-label="JPEG 背景颜色" type="color" value={fill} onChange={e => setFill(e.target.value)} /><small>JPEG 不支持透明，将使用此颜色填充。</small></Field> : <label className="im-checkbox"><input type="checkbox" checked={transparent} onChange={e => setTransparent(e.target.checked)} />保留透明区域</label>}
            <div className="im-assurance"><Check size={15} />另存副本 · 原文件保留</div><p className="im-note">实际大小在编码后显示。PNG 无损；WebP 与 JPEG 根据画质设置压缩。</p>
          </>}
        </>}
        {panel === 'history' && <><p>点击版本，在中间预览并与当前版本对比。</p>{[...revisions].sort((a, b) => b.revision - a.revision).map(r => <button className={`im-version${historyRevision === r.revision ? ' selected' : ''}`} key={r.revision} onClick={() => setHistoryRevision(r.revision)}><History size={15} /><span>版本 r{r.revision}<small>{r.authorName || (r.revision === 0 ? '原图' : '图片编辑')}</small></span>{r.revision === info?.revision && <small>当前版本</small>}</button>)}<button className="im-version" onClick={() => setHistoryRevision(0)}><ImageIcon size={15} />原图 · r0</button></>}
        </div>
        <div className="image-drawer-bottom">
          {panel === 'info' && <><small><History size={14} />原图保留 · 编辑可随时撤销</small>{aiEnabled && <button className="im-dark im-wide" onClick={() => openPanel('ai')} disabled={readOnly}><Sparkles size={16} />用 AI 处理这张图片</button>}</>}
          {['crop', 'adjust'].includes(panel) && <><small>应用后形成一个新版本，原图保留。</small><button className="im-dark im-wide" onClick={() => void save()} disabled={!dirty || !!busy || readOnly || running}>{busy ? <LoaderCircle size={16} /> : <Check size={16} />}{busy || '应用编辑'}</button><button className="im-wide" onClick={reset} disabled={!!busy || !dirty}>重置调整</button></>}
          {['ai', 'inpaint'].includes(panel) && <><small>{running ? '生成期间可切换标签，任务会继续执行。' : '先生成候选，确认后应用到当前版本。'}</small>{running ? <button className="im-wide" onClick={() => void task('正在取消', async () => { await api(session, `/image/jobs/${job.jobId}`, { method: 'DELETE' }); setNotice('已取消，区域锁已释放。') })}>取消生成</button> : <button className="im-dark im-wide" disabled={!maskCount || !prompt.trim() || !info?.aiAvailable || !!busy || dirty || readOnly} onClick={() => void generate()}><Sparkles size={16} />生成局部重绘候选</button>}{candidate && <button className="im-soft im-wide" onClick={() => openPanel('compare')}>对比候选</button>}</>}
          {panel === 'compare' && <><small>应用前会核对来源修订，避免覆盖协作者。</small><button className="im-dark im-wide" disabled={!candidate || !!busy || readOnly || dirty || job?.status !== 'ready' || job.sourceRevision !== info?.revision} onClick={() => void applyCandidate()}><Check size={16} />{busy || '应用候选版本'}</button><button className="im-wide" onClick={() => void task('正在丢弃候选',async()=>{if(!job)return;await api(session,`/image/jobs/${job.jobId}`,{method:'DELETE'});setJobs(old=>old.map(j=>j.jobId===job.jobId?{...j,status:'discarded'}:j));setCandidate('');setPanel('inpaint');setShowMask(false)})} disabled={readOnly || job?.status!=='ready'}>丢弃候选</button></>}
          {['convert', 'export'].includes(panel) && !result && <><small>{readOnly ? '下载副本' : '转换后可下载，或在新标签继续编辑。'}</small><button className="im-dark im-wide" onClick={() => void convert()} disabled={!!busy || !source}><ArrowUpRight size={16} />{busy || (panel === 'convert' ? '转换为副本' : '导出副本')}</button></>}
          {panel === 'history' && historyRevision !== null && <button className="im-dark im-wide" disabled={readOnly || !permits(session, 'history.restore') || !!busy || running || hasInput || historyRevision === info?.revision} onClick={() => void task('正在恢复', async () => { await api(session, `/restore/${historyRevision}`, { method: 'POST', headers: epochHeaders, body: JSON.stringify({ expectedRevision: info?.revision }) }); await reload(); setHistoryRevision(null); setNotice('已恢复为新版本。') })}>恢复此版本</button>}
        </div>
      </aside>
    </div>
    {(error || notice || stale !== null) && <div className={`image-feedback${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || (stale !== null ? `协作者已更新至 r${stale}，你的草稿仍保留。` : notice)}</span>{stale !== null && <button onClick={() => { if (!hasInput || window.confirm('读取最新版本会清除当前图片草稿，是否继续？')) void task('读取最新版本', async () => { const receipt = inputProtection.capture(); await reload(receipt); inputProtection.acknowledge(receipt); setPrompt(''); setConversionPending(false) }) }}>读取最新版本</button>}<IconButton label="关闭提示" onClick={() => { setError(''); setNotice('') }}><X size={14} /></IconButton></div>}
    <footer className="image-statusbar"><span><i />{editing ? '编辑模式' : '预览模式'}　{info ? `${edits.width} × ${edits.height} px · ${info.format.toUpperCase()} · ${imageFileSize(info.sourceBytes)}` : '载入中'}</span><span className="im-spacer" /><small>空格拖动 · 滚轮缩放画布</small><IconButton label="缩小图片" onClick={() => setZoom(view.scale / 1.15)}><Minus size={13} /></IconButton><button onClick={() => setZoom(1)} aria-label="图片缩放比例">{Math.round(view.scale * 100)}%</button><IconButton label="放大图片" onClick={() => setZoom(view.scale * 1.15)}><Plus size={13} /></IconButton><IconButton label="适合窗口" onClick={() => { interacted.current = false; fit() }}><Expand size={14} /></IconButton></footer>
  </section>
}
