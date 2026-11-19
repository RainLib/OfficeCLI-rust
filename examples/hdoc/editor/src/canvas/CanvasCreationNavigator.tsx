import { useEffect, useMemo, useState } from 'react'
import { Brush, ChevronLeft, ChevronRight, LocateFixed, Pause, Play } from 'lucide-react'
import type { ArtBrush, CanvasElement } from './model.ts'
import { handBrush, isBrush, type HandBrush } from './materialCatalog.ts'

function workBrush(heading: CanvasElement): HandBrush | null {
  const brush = (heading.customData as { officeBrush?: { kind?: ArtBrush; color?: string } } | undefined)?.officeBrush
  if (!brush?.kind || !isBrush(brush.kind) || typeof brush.color !== 'string' || !/^#[\da-f]{6}$/i.test(brush.color)) return null
  return handBrush(brush.kind, undefined, brush.color)
}
export function CanvasCreationNavigator({ elements, selectedIds, onLocate, onDraw, motion }: {
  elements: CanvasElement[]
  selectedIds?: string[]
  onLocate: (id: string, section?: number) => void
  onDraw?: (brush: HandBrush) => void
  motion?: { paused: boolean; toggle: () => void }
}) {
  const [chosen, setChosen] = useState(''), [step, setStep] = useState(-1)
  const works = useMemo(() => elements.filter(e => !e.isDeleted && e.id.endsWith('-heading') && (e.customData as { officeComposition?: unknown } | undefined)?.officeComposition).map(heading => {
    const id = heading.id.slice(0, -'-heading'.length)
    const sections = elements.flatMap(e => {
      const meta = (e.customData as { officeDiagram?: { id: string; layout: string; section?: number; sectionTitle: string } } | undefined)?.officeDiagram
      return !e.isDeleted && meta?.id === id && meta.layout === 'lesson' && typeof meta.section === 'number' ? [{ index: meta.section, title: meta.sectionTitle }] : []
    }).sort((a, b) => a.index - b.index)
    return { id, title: String(heading.originalText || heading.text || '生成内容').replaceAll('\n', ''), sections, brush: workBrush(heading) }
  }), [elements])
  const selectedWork = selectedIds?.length ? works.find(work => selectedIds.every(id => id.startsWith(work.id + '-')))?.id : undefined
  useEffect(() => {
    if (selectedWork) { setChosen(selectedWork); setStep(-1) }
  }, [selectedWork])
  const current = works.find(work => work.id === chosen) || works.at(-1)
  if (!current) return motion ? <nav className="canvas-creation-nav canvas-motion-only" aria-label="贴纸播放">
    <button type="button" aria-label={motion.paused ? '播放贴纸动画' : '暂停贴纸动画'} title={motion.paused ? '播放贴纸动画' : '暂停贴纸动画'} onClick={motion.toggle}>{motion.paused ? <Play size={14} /> : <Pause size={14} />}</button>
  </nav> : null
  const brush = current.brush
  const safeStep = chosen === current.id && step < current.sections.length ? step : -1
  const locate = (next: number) => { setChosen(current.id); setStep(next); onLocate(current.id, current.sections[next]?.index) }
  return <nav className="canvas-creation-nav" aria-label="生成作品导览">
    <div><select aria-label="生成作品" value={current.id} onChange={event => { setChosen(event.target.value); setStep(-1); onLocate(event.target.value) }}>{works.map(work => <option key={work.id} value={work.id}>{work.title}</option>)}</select><button type="button" aria-label="定位生成作品" title="定位生成作品" onClick={() => locate(-1)}><LocateFixed size={16} /></button>
      {brush && onDraw && <button type="button" aria-label={`沿用${brush.label}手绘`} title={`沿用${brush.label}手绘`} onClick={() => onDraw(brush)}><Brush size={15} /></button>}
      {motion && <button type="button" aria-label={motion.paused ? '播放贴纸动画' : '暂停贴纸动画'} title={motion.paused ? '播放贴纸动画' : '暂停贴纸动画'} onClick={motion.toggle}>{motion.paused ? <Play size={14} /> : <Pause size={14} />}</button>}
    </div>
    {!!current.sections.length && <div className="canvas-lesson-steps"><button type="button" aria-label="上一讲解步骤" disabled={safeStep < 0} onClick={() => locate(safeStep - 1)}><ChevronLeft size={16} /></button><span>{safeStep < 0 ? `课程全览 · ${current.sections.length} 步` : `${safeStep + 1}/${current.sections.length} ${current.sections[safeStep].title}`}</span><button type="button" aria-label="下一讲解步骤" disabled={safeStep >= current.sections.length - 1} onClick={() => locate(safeStep + 1)}><ChevronRight size={16} /></button></div>}
  </nav>
}
