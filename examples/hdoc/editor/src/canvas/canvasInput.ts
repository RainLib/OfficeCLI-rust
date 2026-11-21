/** DOM content floats beside Excalidraw's canvas. Keep navigation in the same
 * input surface while retaining local editor/menu scrolling and ordinary clicks. */
const controls = '[role="toolbar"], .board-dock-shell, .App-menu, .layer-ui__wrapper, .sidebar, [role="dialog"], [role="menu"], .board-block-editor, .board-edge-palette, .spec-edit-rail'
const writable = 'input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]'

function localScroll(target: Element, root: HTMLElement) {
  if (target.closest('select, input[type="number"], input[type="range"]')) return true
  for (let element: Element | null = target; element && element !== root; element = element.parentElement) {
    const style = getComputedStyle(element)
    if (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
      || /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1) return true
  }
  return false
}
function pointer(event: PointerEvent) {
  return new PointerEvent(event.type, { bubbles: true, cancelable: true, composed: true,
    pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: event.isPrimary,
    clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
    button: event.button, buttons: event.buttons, pressure: event.pressure, width: event.width, height: event.height,
    altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
  })
}

export function installCanvasInput(root: HTMLElement) {
  if (root.dataset.canvasInputBound) return () => {}
  root.dataset.canvasInputBound = 'true'
  const view = root.ownerDocument.defaultView!
  const pointers = new Set<number>()
  let space = false, routedSpace = false, clearFrame = 0
  const canvas = () => root.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.interactive')
  const shown = () => root.isConnected && root.getClientRects().length > 0
  const hand = () => !!root.querySelector('.excalidraw--view-mode, .board-tool[aria-label="手形"][aria-pressed="true"], input[value="hand"]:checked')
  const routeSpace = (type: 'keydown' | 'keyup') => {
    routedSpace = type === 'keydown'
    canvas()?.dispatchEvent(new KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, cancelable: true }))
  }
  const begin = (id: number) => {
    cancelAnimationFrame(clearFrame)
    pointers.add(id)
    root.dataset.canvasGesture = 'true'
  }
  const reset = () => {
    if (routedSpace) routeSpace('keyup')
    pointers.clear(); space = false
    cancelAnimationFrame(clearFrame)
    delete root.dataset.canvasGesture
  }
  const end = (event: PointerEvent) => {
    pointers.delete(event.pointerId)
    if (!pointers.size) {
      // Keep hit-testing on the canvas until the associated click has finished.
      clearFrame = requestAnimationFrame(() => { if (!pointers.size) delete root.dataset.canvasGesture })
    }
  }
  const wheel = (event: WheelEvent) => {
    if (!shown() || !(event.target instanceof Element)) return
    const target = event.target, drawing = canvas(), modified = event.ctrlKey || event.metaKey
    if (target === drawing) return // the native non-passive listener owns this path
    if (!modified && localScroll(target, root)) return
    event.preventDefault()
    event.stopPropagation()
    if (!drawing) return
    drawing.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true,
      clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
      deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
      altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
    }))
  }
  const down = (event: PointerEvent) => {
    if (!shown()) return
    const drawing = canvas()
    if (!drawing || !(event.target instanceof Element)) return
    if (event.target === drawing) {
      if (space && !routedSpace) routeSpace('keydown')
      begin(event.pointerId)
      return
    }
    if (event.target.closest(controls)) return
    if (event.button !== 1 && !(event.button === 0 && (space || hand()))) return
    event.preventDefault()
    event.stopPropagation()
    // Space may have been pressed while a sibling DOM control held focus.
    if (space && !routedSpace) routeSpace('keydown')
    // The real pointer remains active: native setPointerCapture can now capture
    // it on the canvas rather than leaving the gesture on a DOM button or SVG.
    drawing.dispatchEvent(pointer(event))
  }
  const keyDown = (event: KeyboardEvent) => {
    if (shown() && event.code === 'Space' && !(event.target instanceof Element && event.target.closest(writable))) space = true
  }
  const keyUp = (event: KeyboardEvent) => {
    if (event.code !== 'Space') return
    space = false
    if (routedSpace) {
      routedSpace = false
      if (!(event.target instanceof Element && event.target.closest('.excalidraw'))) routeSpace('keyup')
    }
  }
  const navigationKey = (event: KeyboardEvent) => {
    if (event.code === 'Space' && event.target instanceof Element
      && !event.target.closest(`${writable}, .excalidraw`)) {
      event.preventDefault(); event.stopPropagation(); routeSpace('keydown')
      return
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !['+', '=', '-', '0'].includes(event.key)
      || !(event.target instanceof Element)) return
    const drawing = canvas()
    if (!drawing || event.target === drawing) return
    event.preventDefault(); event.stopPropagation()
    drawing.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, code: event.code, bubbles: true,
      cancelable: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }))
  }
  // WebKit's native pinch stream must be non-passive at the surface as well.
  // Leave the event bubbling so Excalidraw's existing gesture implementation
  // owns the camera, including its touchscreen handling and zoom bounds.
  const pinch = (event: Event) => { if (shown()) event.preventDefault() }
  const drag = (event: DragEvent) => { if (pointers.size) event.preventDefault() }
  root.addEventListener('wheel', wheel, { capture: true, passive: false })
  root.addEventListener('pointerdown', down, true)
  root.addEventListener('keydown', navigationKey, true)
  root.addEventListener('dragstart', drag, true)
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) root.addEventListener(type, pinch, { capture: true, passive: false })
  view.addEventListener('keydown', keyDown, true)
  view.addEventListener('keyup', keyUp, true)
  view.addEventListener('pointerup', end, true)
  view.addEventListener('pointercancel', end, true)
  view.addEventListener('blur', reset)
  return () => {
    reset()
    delete root.dataset.canvasInputBound
    root.removeEventListener('wheel', wheel, true)
    root.removeEventListener('pointerdown', down, true)
    root.removeEventListener('keydown', navigationKey, true)
    root.removeEventListener('dragstart', drag, true)
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) root.removeEventListener(type, pinch, true)
    view.removeEventListener('keydown', keyDown, true)
    view.removeEventListener('keyup', keyUp, true)
    view.removeEventListener('pointerup', end, true)
    view.removeEventListener('pointercancel', end, true)
    view.removeEventListener('blur', reset)
  }
}
