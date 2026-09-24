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

export async function api(session: Session, route: string, init: RequestInit = {}) {
  const response = await fetch(`${session.apiUrl || '/v1/documents'}/${encodeURIComponent(session.documentId)}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${session.token}`, ...(init.headers || {}) },
  })
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  return response
}
