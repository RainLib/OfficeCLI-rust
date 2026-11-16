import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { useAppearance } from './Appearance.tsx'
import { useI18n } from './i18n.tsx'

/** Body portal escapes transformed/overflowing document canvases while keeping
 * the embedded workspace's appearance and language. */
export function FloatingLayer({ children }: { children: ReactNode }) {
  const { theme } = useAppearance()
  const { locale } = useI18n()
  return createPortal(<div className="hcd-surface hcd-floating-layer" data-theme={theme} lang={locale}>{children}</div>, document.body)
}
