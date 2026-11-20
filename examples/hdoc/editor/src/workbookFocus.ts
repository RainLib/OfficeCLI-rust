import type { IEditorService } from '@univerjs/preset-sheets-core'

/** Univer's document input is briefly mounted outside its workbook, so an
 * inert tab alone cannot stop restore/selection callbacks from focusing it.
 * Scope both public editor focus and the render service's direct focus path
 * to this instance. No global DOM prototypes or other editors are changed. */
export function installWorkbookFocusBoundary(service: IEditorService, getHost: () => HTMLElement | null) {
  const register = service.register, focus = service.focus
  const cleanups: Array<() => void> = []
  const guarded = new WeakSet<object>()
  const mayFocus = () => {
    const host = getHost()
    if (!host?.isConnected || !host.getClientRects().length || host.closest('[inert],[hidden]')) return false
    const owner = host.ownerDocument, active = owner.activeElement
    if (!active || active === owner.body || (host.closest('.workspace') ?? host).contains(active)) return true
    // During relocation the instance's own native input may still be outside
    // its host. It can keep focus; a Word selection or global AI input cannot.
    return [...service.getAllEditor().values()].some(editor => editor.docSelectionRenderService.hasFocus())
  }
  const protect = () => {
    for (const editor of service.getAllEditor().values()) {
      const selection = editor.docSelectionRenderService
      if (guarded.has(selection)) continue
      guarded.add(selection)
      const nativeFocus = selection.focus
      selection.focus = function () { if (mayFocus()) nativeFocus.call(this) }
      cleanups.push(() => { selection.focus = nativeFocus })
    }
  }
  service.register = function (config, container) {
    const registered = register.call(this, { ...config, autofocus: false }, container)
    protect()
    return registered
  }
  service.focus = function (id) { if (mayFocus()) focus.call(this, id) }
  protect()
  return () => {
    service.register = register; service.focus = focus
    cleanups.forEach(cleanup => cleanup())
  }
}
