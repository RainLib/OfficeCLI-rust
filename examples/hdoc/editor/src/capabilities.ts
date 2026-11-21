import type { Session } from './api.ts'
import type { GridCalculationResult } from '../../xlsx-univer-viewer/src/hcd.ts'

export type CalculationResult = GridCalculationResult
export type RuntimeCapabilities = {
  protocolVersion: string
  protocolFingerprint: string
  patchSchemas: Record<string, { route: string; operations: string[] }>
  calculation: { contractVersion: string; verifiedFunctions: string[] }
  officeFeatures?: { protocolVersion: string; route: string; operations: string[]; sourceBackedExport: boolean }
  agentWorkflow?: { protocolVersion: string; actions: string[]; selectionIdentityGuard?: boolean }
  nodePatchReview?: { protocolVersion: string; route: string; exactPayloadAndAuthor: boolean }
}

const cache = new WeakMap<Session, { expires: number; value: Promise<RuntimeCapabilities> }>()

export function forgetCapabilities(session: Session) { cache.delete(session) }

export async function readCapabilities(session: Session): Promise<RuntimeCapabilities> {
  const existing = cache.get(session)
  if (existing && existing.expires > Date.now()) return existing.value
  const value = (async () => {
    const response = await fetch(`${session.apiUrl || '/v1/documents'}/${encodeURIComponent(session.documentId)}/capabilities`, {
      headers: { Authorization: `Bearer ${session.accessToken?.() || session.token}` }, signal: AbortSignal.timeout(10_000), cache: 'no-store',
    })
    if (response.status === 404) throw new Error('当前文档服务版本较旧，无法核对编辑能力。请升级服务后重试；本次修改尚未提交。')
    if (!response.ok) throw new Error(`无法核对编辑能力（${response.status}）；本次修改尚未提交。`)
    const result = await response.json() as RuntimeCapabilities
    if (result.protocolVersion !== 'hcd-api/1' || !/^[0-9a-f]{64}$/.test(result.protocolFingerprint)
      || !result.patchSchemas || !Array.isArray(result.calculation?.verifiedFunctions)) {
      throw new Error('文档服务的编辑协议不兼容；本次修改尚未提交。')
    }
    return result
  })()
  cache.set(session, { expires: Date.now() + 5_000, value })
  try { return await value } catch (error) { cache.delete(session); throw error }
}

export function assertPatchSupported(capabilities: RuntimeCapabilities, route: string, patch: unknown) {
  const value = patch as { schemaVersion?: unknown; operations?: Array<{ op?: unknown }> } | null
  const schema = typeof value?.schemaVersion === 'string' ? capabilities.patchSchemas[value.schemaVersion] : undefined
  if (!schema || schema.route !== route) throw new Error('当前服务不支持此编辑版本，请更新服务；本次修改尚未提交。')
  if (!Array.isArray(value?.operations) || value.operations.some(operation => typeof operation?.op !== 'string' || !schema.operations.includes(operation.op))) {
    throw new Error('当前服务尚未支持此操作，请更新服务；本次修改尚未提交。')
  }
}
