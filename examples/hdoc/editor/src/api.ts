import { assertPatchSupported, forgetCapabilities, readCapabilities } from './capabilities.ts'

export type Session = {
  documentId: string
  title?: string
  token: string
  /** Live credential getter for an embedded session renewed without remounting. */
  accessToken?: () => string
  scope: 'read' | 'write'
  format: string
  apiUrl?: string
  collabUrl?: string
  userId?: string
  displayName?: string
  collaborationEpoch?: number
  hostIntegration?: boolean
  operations?: string[]
}

export async function api(session: Session, route: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${session.accessToken?.() || session.token}`)
  if ((route === '/patch' || route === '/node-patch' || route === '/node-patch-review') && init.method?.toUpperCase() === 'POST') {
    const capabilities = await readCapabilities(session)
    if (typeof init.body !== 'string') throw new Error('无法核对编辑内容；本次修改尚未提交。')
    if (route === '/node-patch-review' && (capabilities.nodePatchReview?.protocolVersion !== 'hcd-node-patch-review/1'
      || capabilities.nodePatchReview.route !== route || !capabilities.nodePatchReview.exactPayloadAndAuthor)) throw new Error('当前服务不支持核对提交回执，请更新服务；草稿已保留。')
    assertPatchSupported(capabilities, route === '/node-patch-review' ? '/node-patch' : route, JSON.parse(init.body))
    headers.set('x-hcd-protocol-fingerprint', capabilities.protocolFingerprint)
  }
  const response = await fetch(`${session.apiUrl || '/v1/documents'}/${encodeURIComponent(session.documentId)}${route}`, {
    ...init,
    headers,
  })
  if (response.status === 409) forgetCapabilities(session)
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  return response
}
