/** Navigation-only update for a running older preview, without changing its
 * document API, authentication, Office capabilities or persisted user files. */
import { installCanvasInput } from '../src/canvas/canvasInput'

const installed = new Map<HTMLElement, () => void>()
const synchronize = () => {
  for (const [root, dispose] of installed) if (!root.isConnected) { dispose(); installed.delete(root) }
  for (const root of document.querySelectorAll<HTMLElement>('.canvas-workspace .canvas-surface')) {
    if (!root.dataset.canvasInputBound && root.querySelector('canvas.excalidraw__canvas.interactive')) installed.set(root, installCanvasInput(root))
  }
}
const observer = new MutationObserver(synchronize)
observer.observe(document.body, { childList: true, subtree: true })
synchronize()
window.addEventListener('pagehide', () => { observer.disconnect(); for (const dispose of installed.values()) dispose(); installed.clear() }, { once: true })
