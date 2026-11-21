import { useLayoutEffect, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { arrangeWordComments, type WordReviewAnchor } from './wordReviewAnchors'

type Layout = { positions: Record<string, number>; height: number; width: number; left: number; compact: boolean; maxCardHeight: number; path: string }
const empty: Layout = { positions: {}, height: 0, width: 0, left: 0, compact: false, maxCardHeight: 800, path: '' }

/** The document and its comments share one scroll surface and zoom transform. */
export function useWordReviewMargin(root: RefObject<HTMLElement | null>, editor: Editor | null | undefined,
  anchors: WordReviewAnchor[], active: string | null, enabled: boolean) {
  const [layout, setLayout] = useState<Layout>(empty)
  useLayoutEffect(() => {
    const panel = root.current, stage = panel?.closest<HTMLElement>('.word-document-layout')
    const viewport = stage?.closest<HTMLElement>('.canvas-viewport')
    const page = stage?.querySelector<HTMLElement>('.word-document-page')
    const rail = panel?.closest<HTMLElement>('.word-review-margin')
    if (!enabled || !panel || !stage || !page || !rail || !viewport) return
    let frame = 0, alive = true
    function measure() {
      frame = 0
      if (!alive || !stage || !panel || !rail || !page || !viewport || !stage.offsetWidth) return
      const bounds = stage.getBoundingClientRect(), visible = viewport.getBoundingClientRect()
      const scale = bounds.width / stage.offsetWidth || 1
      const paper = page.querySelector<HTMLElement>('main.document:not([hidden]), .word-page-preview iframe')
      const compact = viewport.clientWidth < ((paper?.offsetWidth ?? page.offsetWidth) + 360) * scale
      rail.dataset.compact = String(compact)
      stage.dataset.reviewCompact = String(compact)
      const width = Math.min(288, viewport.clientWidth / scale - 24)
      rail.style.setProperty('--word-review-width', Math.max(80, width) + 'px')
      const left = compact ? (visible.left - bounds.left) / scale + viewport.clientWidth / scale - rail.offsetWidth - 12
        : (rail.getBoundingClientRect().left - bounds.left) / scale
      rail.style.left = compact ? left + 'px' : ''
      const visibleTop = (visible.top - bounds.top) / scale
      const visibleBottom = (visible.bottom - bounds.top) / scale
      panel.style.setProperty('--word-review-controls-top', Math.max(8, visibleTop + 8) + 'px')
      const points = new Map<string, { x: number; y: number }>()
      for (const anchor of anchors) {
        let element = page.querySelector<HTMLElement>(`[data-word-comment-id="${CSS.escape(anchor.id)}"]`)
          ?? page.querySelector<HTMLElement>(`[data-hcd-block-id="${CSS.escape(anchor.location.blockId)}"]`)
        let rect = element?.getClientRects()[0]
        if (!rect) for (const iframe of page.querySelectorAll('iframe')) {
          try {
            element = iframe.contentDocument?.querySelector<HTMLElement>(`[data-hcd-block-id="${CSS.escape(anchor.location.blockId)}"],[data-hcd-id="${CSS.escape(anchor.location.blockId)}"]`) ?? null
            const local = element?.getBoundingClientRect()
            if (local) {
              const outer = iframe.getBoundingClientRect(), factor = outer.width / iframe.clientWidth
              rect = new DOMRect(outer.left + local.left * factor, outer.top + local.top * factor, local.width * factor, local.height * factor)
              break
            }
          } catch { /* A preview may be loading; the next layout pass retries. */ }
        }
        if (rect) points.set(anchor.id, { x: (rect.right - bounds.left) / scale, y: (rect.top + rect.height / 2 - bounds.top) / scale })
      }
      const items = [...panel.querySelectorAll<HTMLElement>('[data-review-card]')].map(card => {
        const id = card.dataset.reviewCard!
        return { id, top: points.get(id)?.y ?? 72, height: card.offsetHeight || 100 }
      })
      const arranged = arrangeWordComments(items)
      const positions = Object.fromEntries(arranged.map(item => [item.id, item.top]))
      const chosen = arranged.find(item => item.id === active)
      if (compact && chosen) positions[chosen.id] = Math.max(visibleTop + 100,
        Math.min((points.get(chosen.id)?.y ?? visibleTop + 72) + 16, visibleBottom - chosen.height - 16))
      const point = active && points.get(active)
      const end = active && positions[active] !== undefined ? positions[active] + 26 : 0
      const path = point && end ? `M ${point.x} ${point.y} C ${point.x + 24} ${point.y}, ${left - 24} ${end}, ${left} ${end}` : ''
      const height = Math.max(page.offsetHeight, ...arranged.map(item => item.top + item.height + 24), 120)
      const next = { positions, height, width: stage.offsetWidth, left, compact,
        maxCardHeight: Math.max(140, (visible.height / scale) - 124), path }
      setLayout(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
    }
    const schedule = () => { if (alive && !frame) frame = requestAnimationFrame(measure) }
    const resize = new ResizeObserver(schedule)
    resize.observe(page); resize.observe(viewport)
    panel.querySelectorAll('[data-review-card]').forEach(card => resize.observe(card))
    const mutations = new MutationObserver(schedule)
    mutations.observe(page, { childList: true, characterData: true, subtree: true })
    mutations.observe(viewport, { attributes: true, attributeFilter: ['data-canvas-zoom'] })
    viewport.addEventListener('scroll', schedule, { passive: true })
    page.addEventListener('load', schedule, true)
    editor?.on('transaction', schedule)
    void document.fonts.ready.then(schedule)
    measure()
    return () => {
      alive = false; cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect()
      viewport.removeEventListener('scroll', schedule); page.removeEventListener('load', schedule, true)
      editor?.off('transaction', schedule)
    }
  }, [root, editor, anchors, active, enabled])
  return layout
}
