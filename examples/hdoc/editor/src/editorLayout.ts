export type LayoutPreferences = {
  showHeader: boolean
  showToolbar: boolean
  showCollaborators: boolean
  showOutline: boolean
  compact: boolean
}

export const defaultLayout: LayoutPreferences = {
  showHeader: true,
  showToolbar: true,
  showCollaborators: true,
  showOutline: true,
  compact: true,
}

const layoutKey = 'hcd-editor-layout-v1'

function preferenceKey(scope: string, integrated: boolean) {
  return [layoutKey, integrated && 'workbench', scope].filter(Boolean).join('-')
}

export function readLayout(scope = '', integrated = false): LayoutPreferences {
  const defaults = { ...defaultLayout, showOutline: !integrated && (typeof window === 'undefined' || window.innerWidth > 900) }
  try {
    const stored = localStorage.getItem(preferenceKey(scope, integrated))
    const saved = JSON.parse(stored ?? localStorage.getItem(preferenceKey(scope, false)) ?? '{}') as Partial<LayoutPreferences>
    if (integrated && stored === null) delete saved.showOutline
    return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) =>
      [key, typeof saved[key as keyof LayoutPreferences] === 'boolean' ? saved[key as keyof LayoutPreferences] : fallback])) as LayoutPreferences
  } catch { return defaults }
}

export function saveLayout(layout: LayoutPreferences, scope = '', integrated = false) {
  try { localStorage.setItem(preferenceKey(scope, integrated), JSON.stringify(layout)) } catch { /* Storage may be unavailable in embedded/private contexts. */ }
}
