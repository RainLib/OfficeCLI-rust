import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'

export type Appearance = 'system' | 'light' | 'dark'
const storageKey = 'hcd-appearance-v1'
const valid = (value: unknown): value is Appearance => ['system', 'light', 'dark'].includes(value as string)
const AppearanceContext = createContext({ preference: 'system' as Appearance, theme: 'light' as 'light' | 'dark', setPreference: (_value: Appearance) => {} })

/** Appearance is scoped to the workspace, including floating menus. It never
 * changes a document's own theme or remounts a collaboration/editor runtime. */
export function AppearanceProvider({ children, initialAppearance, appearance, onAppearanceChange, persist = false }: {
  children: ReactNode; initialAppearance?: Appearance; appearance?: Appearance
  onAppearanceChange?: (value: Appearance) => void; persist?: boolean
}) {
  const [saved, setSaved] = useState<Appearance>(() => {
    if (valid(initialAppearance)) return initialAppearance
    try { const value = persist && localStorage.getItem(storageKey); if (valid(value)) return value } catch { /* Optional storage. */ }
    return 'system'
  })
  const [systemDark, setSystemDark] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const preference = appearance ?? saved
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemDark(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!persist) return
    const update = (event: StorageEvent) => { if (event.key === storageKey) setSaved(valid(event.newValue) ? event.newValue : 'system') }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [persist])
  const setPreference = (value: Appearance) => {
    setSaved(value); onAppearanceChange?.(value)
    if (persist) try { localStorage.setItem(storageKey, value) } catch { /* Optional storage. */ }
  }
  const theme = preference === 'system' ? systemDark ? 'dark' : 'light' : preference
  return <AppearanceContext.Provider value={{ preference, theme, setPreference }}>{children}</AppearanceContext.Provider>
}

export const useAppearance = () => useContext(AppearanceContext)

export function AppearanceSelect() {
  const { preference, setPreference } = useAppearance()
  const { locale } = useI18n()
  const label = localizeSource(locale, '界面主题')
  const Icon = preference === 'system' ? Monitor : preference === 'dark' ? Moon : Sun
  return <label className="appearance-control" title={label}><Icon size={15} aria-hidden="true" /><select aria-label={label} value={preference} onChange={event => setPreference(event.target.value as Appearance)}>
    <option value="system"><LocalText source="跟随系统" /></option><option value="light"><LocalText source="浅色" /></option><option value="dark"><LocalText source="深色" /></option>
  </select></label>
}
