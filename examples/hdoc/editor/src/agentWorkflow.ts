import { api, type Session } from './api.ts'
import { readCapabilities } from './capabilities.ts'

export const workflowProtocol = 'hcd-agent-workflow/1'
export type WorkflowSelection = { key: string; documentId: string; resource: 'node' | 'sheet' | 'editor'; nodeId?: string; number?: number; pointer: string; identity?: { pointer: string; value: string } }
export type WorkflowPosition = { revision: number; rootHash: string; epoch: number }
export type WorkflowContent = { label: string; preview: string; selection: Omit<WorkflowSelection, 'key'>; position: WorkflowPosition }
export type WorkflowStep = { stepId: string; documentId: string; task: string; dependsOn: string[]; consumes: string[]; produces: WorkflowSelection[]; agentCount: number; mode: 'edit' | 'rebuild'; generateImages: boolean }
export type WorkflowPlan = { name: string; documents: { documentId: string; access: 'read' | 'write'; expectedRevision: number; collaborationEpoch: number }[]; facts: WorkflowSelection[]; steps: WorkflowStep[] }
export type Workflow = {
  protocolVersion: string; workflowId: string; status: string; message: string; plan: WorkflowPlan
  progress: Record<string, { status: string; runId?: string; result: string; committedRevisions: number[] }>
  facts: Record<string, { selection: WorkflowSelection; revision: number; value: unknown; producedBy?: string }>
  positions: Record<string, WorkflowPosition>; updatedAtEpochMs: number
}
export type WorkflowReview = { protocolVersion: string; workflow: Workflow; positions: Record<string, WorkflowPosition>; fingerprint: string; canContinue: boolean; continueReason?: string; canCompensate: boolean; compensationReason?: string; message: string }
export type WorkflowSummary = { workflowId: string; status: string; updatedAtEpochMs: number }
export type WorkflowBookmark = { workflowId: string; name: string; documentIds: string[] }

export async function workflowPosition(session: Session, signal?: AbortSignal) {
  const [auth, manifest] = await Promise.all([api(session, '/auth', { signal }).then(r => r.json()), api(session, '', { signal }).then(r => r.json())])
  if (auth.hostIntegration || !auth.userId || (session.userId && auth.userId !== session.userId)) throw new Error('文档身份已变化，请重新连接后核对工作流。')
  if (!Number.isSafeInteger(manifest.revision) || !Number.isSafeInteger(auth.collaborationEpoch)) throw new Error('无法核对文档版本。')
  return { auth: auth as { userId: string; scope: 'read' | 'write' }, position: { revision: manifest.revision, rootHash: manifest.rootHash, epoch: auth.collaborationEpoch } as WorkflowPosition, manifest }
}

export function requireWorkflowProtocol(capabilities: Awaited<ReturnType<typeof readCapabilities>>) {
  const workflow = capabilities.agentWorkflow
  if (workflow?.protocolVersion !== workflowProtocol || !workflow.selectionIdentityGuard || !Array.isArray(workflow.actions) || !['create', 'read', 'review', 'continue', 'compensate', 'cancel'].every(action => workflow.actions.includes(action))) {
    throw new Error('当前服务尚未支持此版多文档工作流，请更新服务后重试。')
  }
}

/** Only declared, open documents on this exact API service may supply grants.
 * Resolve live credential getters for every request; never persist grants. */
export function workflowHeaders(anchor: Session, ids: string[], sessions: Session[], service: (s: Session) => string): Headers {
  if (!ids.includes(anchor.documentId) || new Set(ids).size !== ids.length || ids.length < 2) throw new Error('请选择包含当前文档的至少两份文档。')
  const grants: Record<string, string> = Object.create(null)
  for (const id of ids) {
    const document = id === anchor.documentId ? anchor : sessions.find(item => item.documentId === id && service(item) === service(anchor) && item.userId === anchor.userId && !item.hostIntegration)
    if (!document) throw new Error(`请重新打开参与文档「${id}」，再核对工作流。`)
    if (id !== anchor.documentId) grants[id] = document.accessToken?.() || document.token
  }
  const encoded = new TextEncoder().encode(JSON.stringify(grants))
  const headers = new Headers({ 'Content-Type': 'application/json', 'x-hcd-document-grants': btoa(Array.from(encoded, byte => String.fromCharCode(byte)).join('')) })
  if (headers.get('x-hcd-document-grants')!.length > 65_536) throw new Error('参与文档的授权信息过大，请减少文档数量。')
  return headers
}

export function assertWorkflowPosition(before: WorkflowPosition, after: WorkflowPosition) {
  if (before.revision !== after.revision || before.rootHash !== after.rootHash || before.epoch !== after.epoch) throw new Error('选择内容后文档已变化，请重新选择共享内容并保存计划。')
}

export function workflowError(error: unknown) {
  const value = String(error).replace(/^Error: /, '')
  if (/^(401|403):/.test(value)) return '文档授权已过期、缺少参与文档的授权，或身份不一致。请重新连接相关文档后核对。'
  if (/^404:/.test(value)) return '工作流或所选内容不可用，请刷新记录或重新选择内容。'
  return value.slice(0, 900)
}

/** Bookmarks contain names and document IDs only. They help rediscover a plan
 * without weakening the server's per-document authorization on every read. */
export function workflowBookmarkKey(session: Session, service: string) {
  return `hcd-workflow-bookmarks-v1:${JSON.stringify([service, session.userId, session.documentId])}`
}
export function readWorkflowBookmarks(key: string): WorkflowBookmark[] {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw || raw.length > 128 * 1024) return []
    const items: unknown = JSON.parse(raw)
    if (!Array.isArray(items)) return []
    return items.slice(0, 128).filter((item): item is WorkflowBookmark => !!item && typeof item.workflowId === 'string' && item.workflowId.length < 128 && typeof item.name === 'string' && item.name.length <= 120 && Array.isArray(item.documentIds) && item.documentIds.length >= 2 && item.documentIds.length <= 16 && item.documentIds.every((id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))).map(({ workflowId, name, documentIds }) => ({ workflowId, name, documentIds }))
  } catch { return [] }
}
export function saveWorkflowBookmark(key: string, bookmark: WorkflowBookmark) {
  const { workflowId, name, documentIds } = bookmark
  try { sessionStorage.setItem(key, JSON.stringify([{ workflowId, name, documentIds }, ...readWorkflowBookmarks(key).filter(item => item.workflowId !== workflowId)].slice(0, 128))) } catch { /* The authorized server plan remains available. */ }
}
