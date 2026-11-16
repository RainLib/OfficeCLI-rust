import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ImagePlus, LoaderCircle, Sparkles, X } from 'lucide-react'
import { api, type Session } from './api.ts'
import type { AgentRun } from './AgentTasks.tsx'
import './image-production.css'

export type ImageJob = { jobId: string; documentId: string; status: string; prompt: string; width: number; height: number; model: string; assetHash?: string; error?: string; runId?: string }
const Images = createContext<{ session: Session; jobs: ImageJob[]; model: string; available: boolean; refresh: () => Promise<void> } | null>(null)
export function ImageProductionProvider({ session, children }: { session: Session; children: ReactNode }) {
  const [jobs, setJobs] = useState<ImageJob[]>([]), [model, setModel] = useState(''), [available, setAvailable] = useState(false)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (session.hostIntegration) return
    const data = await (await api(session, '/image-jobs', { signal })).json()
    setJobs(old => JSON.stringify(old) === JSON.stringify(data.jobs) ? old : data.jobs); setModel(data.model); setAvailable(data.available)
  }, [session])
  useEffect(() => {
    if (session.hostIntegration) return
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const poll = async () => { try { await refresh(controller.signal) } catch { /* The editor stays available offline. */ } if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1100) }
    void poll(); return () => { controller.abort(); clearTimeout(timer) }
  }, [refresh, session.hostIntegration])
  return <Images.Provider value={{ session, jobs, model, available, refresh }}>{children}</Images.Provider>
}

/** WebGL owns its animation clock; React updates only for real job changes. */
export function GeneratingImage({ active, width = 1536, height = 1024, label = '正在构建画面' }: { active: boolean; width?: number; height?: number; label?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    if (!el || !active) return
    const gl = el.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' })
    if (!gl) return
    const shader = (type: number, source: string) => { const value = gl.createShader(type)!; gl.shaderSource(value, source); gl.compileShader(value); if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) { gl.deleteShader(value); return null } return value }
    const vs = shader(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}')
    const fs = shader(gl.FRAGMENT_SHADER, `precision mediump float;uniform vec2 resolution;uniform float time;
      void main(){vec2 uv=gl_FragCoord.xy/resolution;vec2 p=(uv-.5)*vec2(resolution.x/resolution.y,1.);
      float wave=sin(p.x*6.+sin(p.y*5.+time*.55)*1.2+time*.4)*.5+.5;
      float cloud=exp(-length(p-vec2(sin(time*.23)*.23,cos(time*.17)*.16))*2.4);
      vec3 ink=mix(vec3(.85,.90,.88),vec3(.36,.59,.53),wave*.28+cloud*.35);
      float sweep=pow(max(0.,1.-abs(fract(uv.x*.7+uv.y*.3-time*.11)*2.-1.)),12.);
      gl_FragColor=vec4(ink+sweep*.10,1.);}`)
    if (!vs || !fs) { if (vs) gl.deleteShader(vs); if (fs) gl.deleteShader(fs); return }
    const program = gl.createProgram()!; gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); gl.deleteShader(vs); gl.deleteShader(fs); return }
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW)
    gl.useProgram(program); const location = gl.getAttribLocation(program, 'p'); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    const time = gl.getUniformLocation(program, 'time'), resolution = gl.getUniformLocation(program, 'resolution')
    let frame = 0, visible = true, lost = false, last = 0
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const draw = (now: number) => {
      frame = 0; if (!visible || document.hidden || lost) return
      if (now - last > 32 || motion.matches) { last = now; const rect = el.getBoundingClientRect(); const w = Math.min(900, Math.max(1, Math.round(rect.width))), h = Math.max(1, Math.round(w * height / width)); if (el.width !== w) el.width = w; if (el.height !== h) el.height = h; gl.viewport(0, 0, el.width, el.height); gl.uniform2f(resolution, el.width, el.height); gl.uniform1f(time, motion.matches ? 0 : now / 1000); gl.drawArrays(gl.TRIANGLES, 0, 6) }
      if (!motion.matches) frame = requestAnimationFrame(draw)
    }
    const resume = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw) }
    const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; resume() }); observer.observe(el)
    const onLost = (event: Event) => { event.preventDefault(); lost = true; cancelAnimationFrame(frame) }
    document.addEventListener('visibilitychange', resume); motion.addEventListener('change', resume); el.addEventListener('webglcontextlost', onLost); resume()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('visibilitychange', resume); motion.removeEventListener('change', resume); el.removeEventListener('webglcontextlost', onLost); gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vs); gl.deleteShader(fs) }
  }, [active, width, height])
  return <div className="image-generation-placeholder" data-generating={active} style={{ aspectRatio: `${width}/${height}` }}><canvas ref={canvas} aria-hidden="true" /><div><Sparkles size={20} /><span>{label}</span><small>{width} × {height}</small></div></div>
}

function GeneratedPicture({ job }: { job: ImageJob }) {
  const context = useContext(Images)!, [src, setSrc] = useState(''), [error, setError] = useState('')
  const host = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(false)
  useEffect(() => { if (!host.current) return; const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '200px' }); observer.observe(host.current); return () => observer.disconnect() }, [])
  useEffect(() => {
    if (job.status !== 'ready' || !visible) return
    const controller = new AbortController(); let objectUrl = ''
    void api(context.session, `/image-jobs/${job.jobId}/content`, { signal: controller.signal }).then(r => r.blob()).then(blob => { if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setSrc(objectUrl) } }).catch(cause => { if (!controller.signal.aborted) setError(String(cause)) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [context.session, job.jobId, job.status, visible])
  return <div ref={host} className="generated-picture-frame" style={{ aspectRatio: `${job.width}/${job.height}` }}>{src ? <img className="generated-picture" src={src} alt={job.prompt} width={job.width} height={job.height} /> : <GeneratingImage active={['queued', 'generating'].includes(job.status)} width={job.width} height={job.height} label={error ? '图片加载失败' : job.error || ({ queued: '等待生成资源', generating: '正在生成图片', ready: '正在加载图片', failed: '图片生成失败', cancelled: '图片生成已停止', interrupted: '图片生成已中断，请核对后重新生成' }[job.status] || '图片占位')} />}</div>
}

export function ImageStudio({ beforeInsert }: { beforeInsert?: () => Promise<unknown> }) {
  const context = useContext(Images)!, { session, jobs, available, model } = context
  const [prompt, setPrompt] = useState(''), [size, setSize] = useState('1536x1024'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [inserted, setInserted] = useState('')
  const [chunks, setChunks] = useState<{ chunkId: string; sequence: number; grid?: { sheetName?: string } }[]>([]), [target, setTarget] = useState('')
  const [placement, setPlacement] = useState({ x: 48, y: 96, width: 360, height: 240 })
  const loadTargets = useCallback(async (signal?: AbortSignal) => {
    const manifest = await (await api(session, '', { signal })).json()
    const pages = await Promise.all(Array.from({ length: manifest.indexPageCount }, (_, i) => api(session, `/index/${i}`, { signal }).then(r => r.json())))
    const all = pages.flatMap(p => p.chunks)
    const descriptors = ['docx', 'md', 'html'].includes(session.format) ? all.filter(c => c.region === 'body').slice(-1) : all
    if (!signal?.aborted) { setChunks(descriptors); setTarget(previous => descriptors.some(c => c.chunkId === previous) ? previous : descriptors[0]?.chunkId || '') }
    return { manifest, descriptors }
  }, [session])
  useEffect(() => { const controller = new AbortController(); void loadTargets(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(String(cause)) }); return () => controller.abort() }, [loadTargets, jobs.length])
  const generate = async () => { setBusy(true); setError(''); try { const [width, height] = size.split('x').map(Number); await api(session, '/image-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, width, height }) }); setPrompt(''); await context.refresh() } catch (cause) { setError(String(cause)) } finally { setBusy(false) } }
  const insert = async (job: ImageJob) => { setBusy(true); setError(''); try {
    await beforeInsert?.()
    const [{ manifest, descriptors }, auth] = await Promise.all([loadTargets(), api(session, '/auth').then(r => r.json())])
    if (!descriptors.some(c => c.chunkId === target)) throw new Error('页面结构已更新，请重新选择插入位置。')
    const emu = ['pptx', 'xlsx'].includes(session.format), scale = emu ? 12700 : 1
    const geometry = { ...Object.fromEntries(Object.entries(placement).map(([key, value]) => [key, value * scale])), unit: emu ? 'emu' : 'pt' }
    await api(session, `/image-jobs/${job.jobId}/insert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: manifest.revision, collaborationEpoch: auth.collaborationEpoch, chunkId: target, geometry, alt: job.prompt.slice(0, 2000) }) }); setInserted(job.jobId)
  } catch (cause) { setError(String(cause)) } finally { setBusy(false) } }
  if (!['docx', 'pdf', 'pptx', 'xlsx', 'md', 'html'].includes(session.format)) return <section className="image-studio"><p>当前格式不支持插图。请使用 DOCX、PDF、XLSX、Markdown、HTML 或 PPTX 文档。</p></section>
  return <section className="image-studio" aria-label="图片资源工作室"><div className="image-studio-intro"><Sparkles size={18} /><h3>从想法到画面</h3><p>为当前文档生成插图，按指定尺寸放置。</p></div>
    {session.scope === 'write' && <><form onSubmit={e => { e.preventDefault(); void generate() }}><label>画面描述<textarea aria-label="图片描述" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={8000} placeholder="描述主体、构图、色调与用途…" /></label><div><select aria-label="图片生成尺寸" value={size} onChange={e => setSize(e.target.value)}><option value="1536x1024">横向 · 1536 × 1024</option><option value="1024x1024">方形 · 1024 × 1024</option><option value="1024x1536">纵向 · 1024 × 1536</option></select><button type="submit" disabled={busy || !available || !prompt.trim()}><ImagePlus size={14} />生成图片</button></div><small>{model || '图片服务未配置'}</small></form>
    <details className="image-placement" onToggle={e => { if (e.currentTarget.open) void loadTargets().catch(cause => setError(String(cause))) }}><summary><ChevronDown size={13} />插入位置与大小</summary>{['docx', 'md', 'html'].includes(session.format) && <p>行内插图添加到文档末尾，随内容排版并保留宽高。</p>}<label>目标页面<select aria-label="图片目标页面" value={target} onChange={e => setTarget(e.target.value)}>{chunks.map(c => <option key={c.chunkId} value={c.chunkId}>{['docx', 'md', 'html'].includes(session.format) ? '文档末尾' : c.grid?.sheetName || `第 ${c.sequence + 1} 页`}</option>)}</select></label><div>{(['x', 'y', 'width', 'height'] as const).filter(key => ['pptx', 'xlsx', 'pdf'].includes(session.format) || ['width', 'height'].includes(key)).map((key) => <label key={key}>{({ x: '左边距', y: '上边距', width: '宽度', height: '高度' })[key]} (pt)<input type="number" aria-label={`图片${key}`} value={placement[key]} min={['width', 'height'].includes(key) ? 1 : 0} onChange={e => setPlacement(p => ({ ...p, [key]: Number(e.target.value) }))} /></label>)}</div></details></>}
    {error && <p role="alert" className="agent-task-error">{error}</p>}
    <div className="image-job-list">{jobs.slice().reverse().map(job => <article key={job.jobId} data-image-job={job.jobId} data-image-status={job.status}><GeneratedPicture job={job} /><p>{job.prompt}</p><footer><small>{job.model} · {job.width} × {job.height}</small>{session.scope === 'write' && (['queued', 'generating'].includes(job.status) ? <button type="button" onClick={() => void api(session, `/image-jobs/${job.jobId}`, { method: 'DELETE' }).then(() => context.refresh()).catch(cause => setError(String(cause)))}>停止</button> : job.status === 'ready' ? <button type="button" disabled={busy || !target || inserted === job.jobId} onClick={() => void insert(job)}>{inserted === job.jobId ? <Check size={13} /> : <ImagePlus size={13} />}{inserted === job.jobId ? '已插入' : '插入文档'}</button> : <button type="button" disabled={busy} onClick={() => { setPrompt(job.prompt); setSize(`${job.width}x${job.height}`) }}>重新生成</button>)}</footer></article>)}</div>
  </section>
}

export function ProductionCanvas({ runs }: { runs: AgentRun[] }) {
  const context = useContext(Images), [collapsedRun, setCollapsedRun] = useState('')
  const run = runs.find(r => r.mode === 'rebuild' && r.team)
  if (!run?.team) return null
  const team = run.team, units = team.units.filter(unit => unit.unitId !== 'commit'), expanded = collapsedRun !== run.runId
  const drafted = units.filter(u => u.draft).length, ready = units.filter(u => ['staged', 'completed'].includes(u.status)).length
  const phase = ['planning', 'drafting', 'reviewing', 'committing'].indexOf(team.phase)
  return <section className="production-board" data-expanded={expanded} aria-label="演示文稿制作管道" data-run-status={run.status}>
    <header><div><span className="production-eyebrow"><Sparkles size={13} />DOCUMENT STUDIO</span><h2>{run.status === 'completed' ? '新稿已完成' : run.status === 'failed' ? '制作未完成' : run.status === 'cancelled' ? '制作已停止' : run.status === 'cancelling' ? '正在停止制作' : '正在构建新的演示文稿'}</h2><p>{units.length ? `${drafted} / ${units.length} 页已起草 · ${ready} 页资源就绪` : '正在规划页面结构'}{team.pageRequirement && ` · 要求 ${team.pageRequirement.min === team.pageRequirement.max ? team.pageRequirement.min : team.pageRequirement.max < 40 ? `${team.pageRequirement.min}–${team.pageRequirement.max}` : `至少 ${team.pageRequirement.min}`} 页`}</p></div><button type="button" onClick={() => setCollapsedRun(expanded ? run.runId : '')}>{expanded ? <X size={14} /> : <Sparkles size={14} />}{expanded ? '查看文档' : '查看制作过程'}</button></header>
    {expanded && <><ol className="production-pipeline">{['规划结构', '制作内容与图片', '整稿验收', '写入与核对'].map((text, i) => <li key={text} data-state={run.status === 'completed' || phase > i ? 'done' : phase === i ? 'active' : 'pending'}>{run.status === 'completed' || phase > i ? <Check size={13} /> : phase === i && run.status === 'running' ? <LoaderCircle size={13} className="agent-spinner" /> : <span>{i + 1}</span>}{text}</li>)}</ol>
      <p className="production-disclosure">{run.status === 'completed' ? '已通过页数、内容及原生导出检查。可切回文档继续编辑。' : '以下是制作中的草稿预览，写入与核对完成后成为可编辑文档。'}</p>
      {!units.length && <GeneratingImage active={run.status === 'running'} label="正在规划完整的页面大纲" />}
      <div className="production-slides">{units.map((unit, index) => { const draft = unit.draft, image = context?.jobs.find(j => j.jobId === unit.imageJobId)
        return <article key={unit.unitId} className={`production-slide layout-${draft?.layout || (index === 0 ? 'cover' : 'split')}`} data-slide-status={unit.status} data-production-agent={unit.status === 'running' ? unit.agentId : undefined} data-production-unit={unit.unitId}><div className="production-slide-text"><small>{String(index + 1).padStart(2, '0')} / {String(units.length).padStart(2, '0')} · {draft?.kicker || '内容构思中'}</small><h3>{draft?.title || unit.title}</h3><div>{draft?.body.map((text, i) => <p key={i}>{text}</p>) || <p className="production-pending">{unit.status === 'pending' ? '等待 Agent 认领制作' : unit.status === 'failed' ? '本页未完成' : 'Agent 正在组织内容与版式…'}</p>}</div><footer>{/^\d+$/.test(unit.agentId.split('-').at(-1) || '') ? `Agent ${unit.agentId.split('-').at(-1)}` : 'Agent'} · {({ pending: '待制作', running: '制作中', staged: '待整稿验收', completed: '已写入', failed: '未完成', cancelled: '已停止' }[unit.status] || unit.status)}</footer></div>{team.generateImages && <div className="production-slide-image">{image ? <GeneratedPicture job={image} /> : <GeneratingImage active={run.status === 'running' && unit.status === 'running'} label={draft ? '图片等待排队' : '已预留插图位置'} />}</div>}</article>
      })}</div>{run.status === 'failed' && <p role="alert" className="agent-task-error">{run.result || '请查看 Agent 面板中的错误信息，修复后重试。'}</p>}</>}
  </section>
}
