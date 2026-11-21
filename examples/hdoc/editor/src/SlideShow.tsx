import type { CSSProperties } from 'react'
import type { SlideTransition } from './OfficeFeatures'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { PageThumbnail, type PagePreview } from './PageThumbnail'
import { LocalText, localizeSource } from './sourceLocale'
import { useI18n } from './i18n'
import { animationSteps, playAnimationStep, readSlideAnimations } from './pptxAnimation'

export function SlideShow({ index, total, preview, hasNext, previous, next, close, transition }: {
  index: number; total: number | null; preview?: PagePreview; hasNext: boolean
  transition?: SlideTransition
  previous: () => void; next: () => void; close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null), { locale } = useI18n()
  const nextSlide = useRef(next)
  useEffect(() => { nextSlide.current = next }, [next])
  const [frame, setFrame] = useState<Document | null>(null)
  const [position, setPosition] = useState({ step: 0, animate: true })
  const steps = useMemo(() => animationSteps(readSlideAnimations(frame?.querySelector('.hcd-slide') ?? null)), [frame])
  const canAdvance = !!frame && (position.step + 1 < steps.length || hasNext)
  const canGoBack = position.step > 0 || index > 0
  useLayoutEffect(() => {
    const el = dialog.current
    el?.showModal()
    return () => el?.close()
  }, [])
  useEffect(() => { dialog.current?.focus() }, [index])
  useLayoutEffect(() => {
    if (!frame) return
    return playAnimationStep(frame, steps, position.step, position.animate, matchMedia('(prefers-reduced-motion: reduce)').matches)
  }, [frame, steps, position])
  useEffect(() => {
    if (!frame || !hasNext || transition?.advanceAfterMs == null || position.step + 1 < steps.length) return
    const timeout = setTimeout(() => nextSlide.current(), transition.advanceAfterMs + (transition.kind === 'none' || transition.kind === 'cut' ? 0 : transition.durationMs))
    return () => clearTimeout(timeout)
  }, [frame, hasNext, transition, position.step, steps.length])
  function forward() {
    if (!canAdvance) return
    if (position.step + 1 < steps.length) setPosition({ step: position.step + 1, animate: true })
    else next()
  }
  function backward() {
    if (position.step > 0) setPosition({ step: position.step - 1, animate: false })
    else if (index > 0) previous()
  }
  const ratio = preview ? preview.width / preview.height : 16/9
  return <dialog ref={dialog} className="slide-show" tabIndex={-1} aria-label={localizeSource(locale,'幻灯片放映')}
    onCancel={e=>{e.preventDefault();close()}} onKeyDown={e=>{
      if (['ArrowRight','PageDown'].includes(e.key) || e.key === ' ' && e.target === dialog.current) {
        e.preventDefault(); forward()
      } else if (['ArrowLeft','PageUp'].includes(e.key)) { e.preventDefault(); backward() }
    }}>
    <div className="slide-show-stage" onClick={() => { if (transition?.advanceOnClick !== false) forward() }}>
      <div data-slide-transition={transition?.kind ?? 'none'} className={frame ? `slide-show-transition transition-${transition?.kind ?? 'none'}` : undefined} style={{ '--transition-duration': `${transition?.durationMs ?? 500}ms`, '--transition-x': transition?.direction === 'right' ? '-100%' : transition?.direction === 'left' ? '100%' : '0%', '--transition-y': transition?.direction === 'down' ? '-100%' : transition?.direction === 'up' ? '100%' : '0%', '--wipe-inset': transition?.direction === 'right' ? '0 0 0 100%' : transition?.direction === 'up' ? '100% 0 0 0' : transition?.direction === 'down' ? '0 0 100% 0' : '0 100% 0 0', width:'min(100%, calc((100dvh - 60px) * '+ratio+'))', visibility: preview && !frame ? 'hidden' : undefined} as CSSProperties}>
        {preview ? <PageThumbnail preview={preview} format="pptx" onFrameReady={setFrame}/> : <span role="status"><LocalText source="正在加载幻灯片…" /></span>}
      </div>
    </div>
    <footer>
      <button aria-label={localizeSource(locale, position.step > 0 ? '上一步动画' : '上一页')} disabled={!canGoBack} onClick={backward}><ChevronLeft size={18}/></button>
      <output aria-live="polite">{index+1}{total!==null && ' / '+total}{steps.length > 1 && <small> · <LocalText source="动画" /> {position.step} / {steps.length - 1}</small>}</output>
      <button aria-label={localizeSource(locale, position.step + 1 < steps.length ? '下一步动画' : '下一页')} disabled={!canAdvance} onClick={forward}><ChevronRight size={18}/></button>
      <button aria-label={localizeSource(locale,'结束放映')} onClick={close}><X size={18}/></button>
    </footer>
  </dialog>
}
