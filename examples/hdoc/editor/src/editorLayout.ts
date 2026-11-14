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

export function readLayout(scope = ''): LayoutPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(scope ? `${layoutKey}-${scope}` : layoutKey) || '{}') as Partial<LayoutPreferences>
    return Object.fromEntries(Object.entries(defaultLayout).map(([key, fallback]) =>
      [key, typeof saved[key as keyof LayoutPreferences] === 'boolean' ? saved[key as keyof LayoutPreferences] : key === 'showOutline' && typeof window !== 'undefined' && window.innerWidth <= 900 ? false : fallback])) as LayoutPreferences
  } catch { return defaultLayout }
}

export function saveLayout(layout: LayoutPreferences, scope = '') {
  try { localStorage.setItem(scope ? `${layoutKey}-${scope}` : layoutKey, JSON.stringify(layout)) } catch { /* Storage may be unavailable in embedded/private contexts. */ }
}
