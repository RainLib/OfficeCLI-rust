export type Session = {
  documentId: string
  token: string
  scope: 'read' | 'write'
  format: string
  apiUrl?: string
  collabUrl?: string
  userId?: string
  displayName?: string
  collaborationEpoch?: number
}

export type RevisionNode = { nodeId: string; text: string; nodeHash: string }
export type RevisionEvent = { revision: number; patchId: string; authorName?: string; nodes: RevisionNode[]; reset?: boolean; nodeHashes?: Record<string, string | null> }
export class ApiError extends Error { constructor(readonly status:number,message:string){super(`${status}: ${message}`)} }

export { watchRevisions } from './revisionWatch.ts'
export type { RevisionConnectionStatus } from './revisionWatch.ts'

export async function api(session: Session, route: string, init: RequestInit = {}) {
  const response = await fetch(`${session.apiUrl || '/v1/documents'}/${encodeURIComponent(session.documentId)}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${session.token}`, ...(init.headers || {}) },
  })
  if (!response.ok) throw new ApiError(response.status,await response.text())
  return response
}
