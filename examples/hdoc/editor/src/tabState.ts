import type { Session } from './api.ts'

export type TargetVersion = { revision: number; collaborationEpoch: number }
const memoryFallback = new Map<string, string | null>()

export const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function sameTargetVersion(saved: TargetVersion | undefined, revision: unknown, epoch: unknown) {
  return !!saved && isIndex(saved.revision) && isIndex(saved.collaborationEpoch)
    && saved.revision === revision && saved.collaborationEpoch === epoch
}

export function workspaceIdentity(session: Session) {
  if (!session.serviceId || !session.userId) return null
  const endpoint = new URL(session.apiUrl || '/v1/documents', window.location.href).href.replace(/\/$/, '')
  return [endpoint, session.serviceId, session.userId]
}

export function tabStateKey(session: Session, field: string) {
  const identity = workspaceIdentity(session)
  return identity && JSON.stringify(['hcd-tab-state-v1', ...identity, session.documentId, field])
}

export function readTabState<T>(key: string | null): T | undefined {
  if (key === null) return
  try {
    const stored = memoryFallback.has(key) ? memoryFallback.get(key) : sessionStorage.getItem(key)
    if (stored && stored.length <= 65_536) return JSON.parse(stored) as T
  } catch { /* A malformed or unavailable browser cache does not prevent opening the tab. */ }
}

export function writeTabState<T>(key: string | null, value?: T) {
  if (key === null) return
  let encoded: string | null
  try {
    encoded = value === undefined ? null : JSON.stringify(value) ?? null
  } catch { return }
  if (encoded !== null && encoded.length > 65_536) return
  memoryFallback.delete(key)
  try {
    if (encoded === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, encoded)
  } catch {
    // Reopening within the current page still works if storage is blocked.
    memoryFallback.set(key, encoded)
    if (memoryFallback.size > 256) {
      const oldest = memoryFallback.keys().next()
      if (!oldest.done) memoryFallback.delete(oldest.value)
    }
  }
}
