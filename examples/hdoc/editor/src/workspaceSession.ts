import { api, type Session } from './api.ts'

export const workspaceSessionKey = 'hcd-editor-workspace-v1'
export type SavedTab = { documentId: string; token: string; title?: string }
export type SavedWorkspace = { version: 1; tabs: SavedTab[]; activeDocument: string | null }

/** Credentials stay in this tab's sessionStorage, like the existing manual
 * connection form. Cached scope, epoch and format are never authorization. */
export function readWorkspaceSession(): SavedWorkspace | null {
  try {
    const raw = sessionStorage.getItem(workspaceSessionKey)
    if (!raw || raw.length > 1024 * 1024) return null
    const saved = JSON.parse(raw) as SavedWorkspace
    if (saved.version !== 1 || !Array.isArray(saved.tabs) || saved.tabs.length > 50) return null
    const ids = new Set<string>()
    const tabs: SavedTab[] = []
    for (const tab of saved.tabs) {
      if (!tab || typeof tab.documentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tab.documentId)
        || typeof tab.token !== 'string' || !tab.token || tab.token.length > 16_384 || ids.has(tab.documentId)) continue
      ids.add(tab.documentId)
      tabs.push({ documentId: tab.documentId, token: tab.token, ...(typeof tab.title === 'string' ? { title: tab.title.slice(0, 256) } : {}) })
    }
    return { version: 1, tabs, activeDocument: ids.has(saved.activeDocument || '') ? saved.activeDocument : null }
  } catch { return null }
}

export function saveWorkspaceSession(tabs: SavedTab[], activeDocument: string | null) {
  try {
    const saved: SavedWorkspace = { version: 1, tabs: tabs.slice(0, 50).map(({ documentId, token, title }) => ({ documentId, token, title })), activeDocument }
    sessionStorage.setItem(workspaceSessionKey, JSON.stringify(saved))
  } catch { /* Editing still works when browser storage is unavailable. */ }
}

export async function authenticateWorkspaceTab(tab: SavedTab, signal?: AbortSignal): Promise<Session> {
  const draft: Session = { documentId: tab.documentId.trim(), token: tab.token.trim(), scope: 'read', format: '' }
  const [auth, manifest] = await Promise.all([api(draft, '/auth', { signal }), api(draft, '', { signal })])
  const access = await auth.json() as { scope: 'read' | 'write'; userId?: string; displayName?: string; collaborationEpoch: number; hostIntegration?: boolean; operations?: string[] }
  const metadata = await manifest.json() as { source: { format: string } }
  if (!['read', 'write'].includes(access.scope) || !Number.isSafeInteger(access.collaborationEpoch) || access.collaborationEpoch < 0
    || !['docx', 'xlsx', 'pptx', 'pdf', 'html', 'md', 'txt', 'png', 'jpg', 'jpeg', 'webp'].includes(metadata.source.format)) throw new Error('文档访问响应无效。')
  return { ...draft, title: tab.title, scope: access.scope, format: metadata.source.format,
    userId: access.userId || undefined, displayName: access.displayName || undefined, collaborationEpoch: access.collaborationEpoch,
    hostIntegration: access.hostIntegration, operations: access.operations }
}
