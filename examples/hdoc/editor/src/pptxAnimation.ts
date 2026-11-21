export const animationKinds = {
  appear: '出现',
  fadeIn: '淡入',
  flyIn: '从左飞入',
  disappear: '消失',
  fadeOut: '淡出',
} as const

export const animationTriggers = {
  onClick: '单击时',
  withPrevious: '与上一动画同时',
  afterPrevious: '上一动画结束后',
} as const

export type AnimationKind = keyof typeof animationKinds
export type AnimationTrigger = keyof typeof animationTriggers
export type SlideAnimation = {
  target: string
  kind: AnimationKind
  trigger: AnimationTrigger
  durationMs: number
  delayMs: number
}
export type AnimationTarget = { id: string; nodeId: string; label: string }
export type SlideAnimationDraft = {
  chunkId: string
  revision: number
  objects: AnimationTarget[]
  effects: SlideAnimation[]
  locked: boolean
  selected?: string
}

export const isExit = (kind: AnimationKind) => kind === 'disappear' || kind === 'fadeOut'
export const isInstant = (kind: AnimationKind) => kind === 'appear' || kind === 'disappear'

export function animationTargetId(element: Element) {
  if (element.getAttribute('data-hcd-pptx-grouped') === 'true') return null
  for (const kind of ['shape', 'picture', 'chart', 'table']) {
    const native = element.getAttribute('data-hcd-' + kind + '-id')
    if (native && /^[1-9]\d*$/.test(native)) return 's' + native
  }
  if (element.hasAttribute('data-hcd-created-image') || element.hasAttribute('data-hcd-created-preset')) {
    return element.getAttribute('data-hcd-id')
  }
  if (element.classList.contains('hcd-slide-shape')) {
    return element.querySelector('[data-hcd-id][data-hcd-node-hash]')?.getAttribute('data-hcd-id') ?? null
  }
  return null
}

export function listAnimationTargets(slides: readonly Element[]): AnimationTarget[] {
  const objects = new Map<string, AnimationTarget>()
  for (const slide of slides) {
    for (const element of slide.children) {
      const id = animationTargetId(element)
      if (!id || objects.has(id)) continue
      const label = element.textContent?.trim().slice(0, 52)
        || element.querySelector('img')?.alt
        || element.getAttribute('data-hcd-shape-name')
        || element.getAttribute('data-hcd-picture-name')
        || element.getAttribute('data-hcd-chart-name')
        || element.getAttribute('data-hcd-table-name')
        || (element.hasAttribute('data-hcd-created-image') ? '图片' : '形状')
      objects.set(id, { id, label, nodeId: element.getAttribute('data-hcd-id') ?? id })
    }
  }
  return [...objects.values()]
}

export function readSlideAnimations(slide: Element | null): SlideAnimation[] {
  const encoded = slide?.getAttribute('data-hcd-pptx-animations')
  if (!encoded) return []
  const effects = JSON.parse(encoded) as SlideAnimation[]
  return effects
}

type TimedAnimation = SlideAnimation & { start: number; end: number }

export function animationSteps(effects: readonly SlideAnimation[]): TimedAnimation[][] {
  const groups: TimedAnimation[][] = [[]]
  for (const effect of effects) {
    if (effect.trigger === 'onClick') groups.push([])
    const group = groups[groups.length - 1]
    const previous = group[group.length - 1]
    const base = effect.trigger === 'afterPrevious' ? previous?.end : previous?.start
    const start = (base ?? 0) + effect.delayMs
    group.push({ ...effect, start, end: start + effect.durationMs })
  }
  return groups
}

export function validAnimationOrder(effects: readonly SlideAnimation[]) {
  const exited = new Map<string, boolean>()
  if (!effects.every(effect => {
    const before = exited.get(effect.target)
    const exit = isExit(effect.kind)
    if (before !== undefined && (before || !exit)) return false
    exited.set(effect.target, exit)
    return true
  })) return false
  return animationSteps(effects).every(step => {
    const end = new Map<string, number>()
    return step.every(effect => {
      const before = end.get(effect.target) ?? 0
      end.set(effect.target, effect.end)
      return before <= effect.start
    })
  })
}

export function playAnimationStep(
  doc: Document, steps: TimedAnimation[][], step: number, animate: boolean, reducedMotion: boolean,
) {
  const objects = new Map<string, HTMLElement[]>()
  const elements = doc.querySelectorAll<HTMLElement>('.hcd-slide > :is(div,figure)')
  const originalVisibility = new Map<HTMLElement, string>()
  for (const element of elements) {
    const id = animationTargetId(element)
    if (!id) continue
    const matches = objects.get(id) ?? []
    matches.push(element)
    objects.set(id, matches)
    originalVisibility.set(element, element.style.visibility)
  }
  const changeVisibility = (target: string, hidden: boolean) => {
    for (const element of objects.get(target) ?? []) {
      element.style.visibility = hidden ? 'hidden' : originalVisibility.get(element) ?? ''
    }
  }
  for (const group of steps) {
    for (const effect of group) {
      if (!isExit(effect.kind)) changeVisibility(effect.target, true)
    }
  }
  const through = animate ? step - 1 : step
  for (const group of steps.slice(0, through + 1)) {
    for (const effect of group) changeVisibility(effect.target, isExit(effect.kind))
  }
  const timers: number[] = []
  const motions: Animation[] = []
  const currentMotion = new Map<HTMLElement, Animation>()
  const play = (effect: TimedAnimation) => {
    const exits = isExit(effect.kind)
    for (const element of objects.get(effect.target) ?? []) {
      currentMotion.get(element)?.cancel()
      element.style.visibility = originalVisibility.get(element) ?? ''
      if (reducedMotion || isInstant(effect.kind)) {
        if (exits) element.style.visibility = 'hidden'
        continue
      }
      const opacity = getComputedStyle(element).opacity
      const frames = effect.kind === 'flyIn'
        ? [{ translate: `-${element.offsetLeft + element.offsetWidth}px 0` }, { translate: '0 0' }]
        : exits ? [{ opacity }, { opacity: 0 }] : [{ opacity: 0 }, { opacity }]
      const motion = element.animate(frames, { duration: effect.durationMs, easing: 'ease-out' })
      motion.onfinish = () => { if (exits) element.style.visibility = 'hidden' }
      currentMotion.set(element, motion)
      motions.push(motion)
    }
  }
  if (animate) {
    for (const effect of [...(steps[step] ?? [])].sort((a, b) => a.start - b.start)) {
      if (effect.start === 0) play(effect)
      else timers.push(window.setTimeout(() => play(effect), effect.start))
    }
  }
  return () => {
    for (const timer of timers) window.clearTimeout(timer)
    for (const motion of motions) motion.cancel()
    for (const [element, visibility] of originalVisibility) element.style.visibility = visibility
  }
}
