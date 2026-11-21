import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertWorkflowPosition, readWorkflowBookmarks, requireWorkflowProtocol, saveWorkflowBookmark, workflowHeaders } from './agentWorkflow.ts'
import type { RuntimeCapabilities } from './capabilities.ts'
import type { Session } from './api.ts'

const document = (id: string, userId = 'owner', apiUrl = 'https://service.test/v1/documents'): Session => ({ documentId: id, userId, apiUrl, format: 'txt', scope: 'write', token: `${id}-credential` })
const service = (session: Session) => session.apiUrl!

test('workflow grants use current credentials and include only exactly declared documents', () => {
  const anchor = document('anchor'), source = { ...document('source'), accessToken: () => 'renewed-credential' }
  const headers = workflowHeaders(anchor, ['anchor', 'source'], [anchor, source, document('unselected')], service)
  const grants = JSON.parse(atob(headers.get('x-hcd-document-grants')!))
  assert.deepEqual(grants, { source: 'renewed-credential' })
  assert(!JSON.stringify(grants).includes('anchor-credential'))
  for (const invalid of [document('source', 'another-owner'), document('source', 'owner', 'https://another.test/v1/documents'), { ...source, hostIntegration: true }]) {
    assert.throws(() => workflowHeaders(anchor, ['anchor', 'source'], [anchor, invalid], service), /重新打开/)
  }
  assert.throws(() => workflowHeaders(anchor, ['source', 'missing'], [source], service), /当前文档/)
  assert.throws(() => workflowHeaders(anchor, ['anchor', 'source', 'source'], [anchor, source], service), /当前文档/)
})

test('workflow UI refuses services without the negotiated identity selection guard before posting a plan', () => {
  const capabilities = { agentWorkflow: { protocolVersion: 'hcd-agent-workflow/1', actions: ['create', 'read', 'review', 'continue', 'compensate', 'cancel'] } } as RuntimeCapabilities
  assert.throws(() => requireWorkflowProtocol(capabilities), /更新服务/)
  assert.doesNotThrow(() => requireWorkflowProtocol({ ...capabilities, agentWorkflow: { ...capabilities.agentWorkflow!, selectionIdentityGuard: true } }))
})

test('shared-content selection invalidates on revision, source root or collaboration generation changes', () => {
  const before = { revision: 2, rootHash: 'original', epoch: 1 }
  assert.doesNotThrow(() => assertWorkflowPosition(before, { ...before }))
  for (const after of [{ ...before, revision: 3 }, { ...before, rootHash: 'new' }, { ...before, epoch: 2 }]) assert.throws(() => assertWorkflowPosition(before, after), /重新选择/)
})

test('workflow recovery bookmarks retain only a name and document IDs, never grants or shared contents', t => {
  const storage = new Map<string, string>()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else Reflect.deleteProperty(globalThis, 'sessionStorage') })
  const bookmark = { workflowId: 'workflow-1', name: 'Report', documentIds: ['anchor', 'source'], token: 'secret', facts: { value: 'private-content' } }
  storage.set('bookmarks', JSON.stringify([bookmark]))
  assert.deepEqual(readWorkflowBookmarks('bookmarks'), [{ workflowId: 'workflow-1', name: 'Report', documentIds: ['anchor', 'source'] }])
  saveWorkflowBookmark('bookmarks', { ...bookmark, name: 'Updated' })
  assert(!storage.get('bookmarks')!.includes('secret'))
  assert(!storage.get('bookmarks')!.includes('private-content'))
  assert.equal(readWorkflowBookmarks('bookmarks').length, 1)
  assert.equal(readWorkflowBookmarks('another-owner').length, 0)
})
