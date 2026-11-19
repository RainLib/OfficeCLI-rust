export type FileEntry = {
  id: string
  name: string
  format: string
  canDelegateSelection: boolean
  ownerName: string
  createdAt: string
  modifiedAt: string
  size: number
  operations: string[]
}
export type Account = {
  user: { id: string; displayName: string; role: string }
  csrf: string
  workspace: {
    name?: string
    tenantId: string
    appId: string
    workbenchModel?: string
    selectionMcp: boolean
  }
  demoAgent?: { model: string | null }
}
export type Launch = {
  token: string
  documentId: string
  expiresAt: number
  fileName: string
  collabUrl: string
}
export const query = new URLSearchParams(location.search)
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const result = await fetch('/workspace/api' + path, {
    ...options,
    credentials: 'same-origin',
  })
  if (result.status === 204) return undefined as T
  const json = await result.json()
  if (!result.ok) throw new Error(json.error || '工作区请求失败。')
  return json as T
}
export function mutation(
  csrf: string,
  data: unknown,
  method = 'POST',
): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Workspace-CSRF': csrf },
    body: JSON.stringify(data),
  }
}
