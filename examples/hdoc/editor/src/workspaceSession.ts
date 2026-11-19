import { api, type Session } from './api.ts'
import { isIndex } from './tabState.ts'

export const workspaceSessionKey = 'hcd-editor-workspace-v1'
export const maxWorkspaceTabs = 50
export const maxRecentTabs = 8
export type SavedTab = { documentId: string; token: string; title?: string }
export type TabGroup = { id: string; name: string; members: string[]; collapsed: boolean }
export type SavedWorkspace = {
  version: 1
  tabs: SavedTab[]
  activeDocument: string | null
  pinned: string[]
  recent: SavedTab[]
  groups: TabGroup[]
}

function cleanGroups(records: unknown, ids: Set<string>, pinned: string[]): TabGroup[] {
  if (!Array.isArray(records)) return []
  const seenIds = new Set<string>(), assigned = new Set(pinned)
  return records.slice(0, maxWorkspaceTabs).flatMap(group => {
    if (!group || typeof group.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(group.id) || seenIds.has(group.id)
      || typeof group.name !== 'string' || !group.name.trim() || !Array.isArray(group.members)) return []
    seenIds.add(group.id)
    const members = group.members.slice(0, maxWorkspaceTabs).filter((id: string) => {
      if (!ids.has(id) || assigned.has(id)) return false
      assigned.add(id)
      return true
    })
    return members.length ? [{ id: group.id, name: group.name.trim().slice(0, 40), members, collapsed: group.collapsed === true }] : []
  })
}

function cleanTabs(records: unknown, limit: number, ids: Set<string>): SavedTab[] {
  if (!Array.isArray(records)) return []
  const tabs: SavedTab[] = []
  for (const tab of records.slice(0, limit)) {
    if (!tab || typeof tab.documentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tab.documentId)
      || typeof tab.token !== 'string' || !tab.token || tab.token.length > 16_384 || ids.has(tab.documentId)) continue
    ids.add(tab.documentId)
    tabs.push({ documentId: tab.documentId, token: tab.token, ...(typeof tab.title === 'string' ? { title: tab.title.slice(0, 256) } : {}) })
  }
  return tabs
}

/** Credentials stay in this tab's sessionStorage, like the existing manual
 * connection form. Cached scope, epoch and format are never authorization. */
export function readWorkspaceSession(): SavedWorkspace | null {
  try {
    const raw = sessionStorage.getItem(workspaceSessionKey)
    if (!raw || raw.length > 2 * 1024 * 1024) return null
    const saved = JSON.parse(raw) as SavedWorkspace
    if (saved.version !== 1 || !Array.isArray(saved.tabs) || saved.tabs.length > maxWorkspaceTabs) return null
    const ids = new Set<string>()
    const tabs = cleanTabs(saved.tabs, maxWorkspaceTabs, ids)
    const activeDocument = ids.has(saved.activeDocument || '') ? saved.activeDocument : null
    const pinned = Array.isArray(saved.pinned) ? [...new Set(saved.pinned.filter(id => ids.has(id)))] : []
    const groups = cleanGroups(saved.groups, ids, pinned)
    const recent = cleanTabs(saved.recent, maxRecentTabs, ids)
    return { version: 1, tabs, activeDocument, pinned, recent, groups }
  } catch { return null }
}

export function saveWorkspaceSession(tabs: SavedTab[], activeDocument: string | null, pinned: string[], recent: SavedTab[], groups: TabGroup[]) {
  try {
    const ids = new Set<string>()
    const clean = cleanTabs(tabs, maxWorkspaceTabs, ids)
    const saved: SavedWorkspace = {
      version: 1, tabs: clean, activeDocument, pinned: pinned.filter(id => ids.has(id)),
      groups: cleanGroups(groups, ids, pinned), recent: cleanTabs(recent, maxRecentTabs, ids),
    }
    sessionStorage.setItem(workspaceSessionKey, JSON.stringify(saved))
  } catch { /* Editing still works when browser storage is unavailable. */ }
}

export async function authenticateWorkspaceTab(tab: SavedTab, signal?: AbortSignal): Promise<Session> {
  const draft: Session = { documentId: tab.documentId.trim(), token: tab.token.trim(), scope: 'read', format: '' }
  const [auth, manifest] = await Promise.all([api(draft, '/auth', { signal }), api(draft, '', { signal })])
  const access = await auth.json() as { scope: 'read' | 'write'; userId?: string; serviceId?: string; displayName?: string; collaborationEpoch: number; hostIntegration?: boolean; operations?: string[] }
  const metadata = await manifest.json() as { revision: number; source: { format: string } }
  if (!['read', 'write'].includes(access.scope) || !Number.isSafeInteger(access.collaborationEpoch) || access.collaborationEpoch < 0
    || !['docx', 'xlsx', 'pptx', 'pdf', 'html', 'md', 'txt', 'png', 'jpg', 'jpeg', 'webp', 'excalidraw'].includes(metadata.source.format)) throw new Error('文档访问响应无效。')
  return { ...draft, title: tab.title, scope: access.scope, format: metadata.source.format,
    userId: access.userId || undefined, displayName: access.displayName || undefined, collaborationEpoch: access.collaborationEpoch,
    serviceId: typeof access.serviceId === 'string' ? access.serviceId : undefined,
    openedRevision: isIndex(metadata.revision) ? metadata.revision : undefined, hostIntegration: access.hostIntegration, operations: access.operations }
}
