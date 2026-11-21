/** Paginate away from the visible canvas. Only the prepared DOM is reconciled
 * into the visible, script-free frame; its Document never navigates on edits. */
export async function prepareWordPreview(source: string, signal: AbortSignal): Promise<string> {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-same-origin allow-scripts')
  frame.setAttribute('aria-hidden', 'true'); frame.inert = true
  frame.style.cssText = 'position:fixed;left:-100000px;top:0;width:1600px;height:1px;visibility:hidden;pointer-events:none;border:0'
  let cleanup = () => {}
  try {
    await new Promise<void>((resolve, reject) => {
      let observer: MutationObserver | undefined
      const abort = () => reject(new DOMException('Aborted', 'AbortError'))
      const timer = window.setTimeout(() => reject(new Error('分页预览准备超时')), 20_000)
      const check = () => {
        const body = frame.contentDocument?.body
        if (body?.dataset.hcdPaginationError) reject(new Error(body.dataset.hcdPaginationError))
        else if (body?.dataset.hcdPageCount) resolve()
      }
      frame.onload = () => {
        const body = frame.contentDocument?.body
        if (body) { observer = new MutationObserver(check); observer.observe(body, { attributes: true }) }
        check()
      }
      signal.addEventListener('abort', abort, { once: true })
      cleanup = () => { clearTimeout(timer); observer?.disconnect(); signal.removeEventListener('abort', abort); frame.onload = null }
      if (signal.aborted) { abort(); return }
      frame.srcdoc = source; document.body.append(frame)
    })
    const prepared = frame.contentDocument!
    prepared.querySelectorAll('script').forEach(script => script.remove())
    return '<!doctype html>' + prepared.documentElement.outerHTML
  } finally { cleanup(); frame.remove() }
}
