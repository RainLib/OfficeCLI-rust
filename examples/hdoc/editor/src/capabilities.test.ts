import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api, type Session } from './api.ts'
import { assertPatchSupported, type RuntimeCapabilities } from './capabilities.ts'

const capabilities: RuntimeCapabilities = {
  protocolVersion: 'hcd-api/1', protocolFingerprint: 'a'.repeat(64),
  patchSchemas: {
    'hcd-patch/4': { route: '/patch', operations: ['block.insert', 'table.edit'] },
    'hcd-patch/29': { route: '/node-patch', operations: ['xlsx.number.set'] },
  }, calculation: { contractVersion: 'officecli-calculation/1', verifiedFunctions: ['SUM', 'LEN'] },
}
const session = (): Session => ({ documentId: 'test-document', token: 'test-only-token', scope: 'write', format: 'docx' })
const tablePatch = { schemaVersion: 'hcd-patch/4', operations: [{ op: 'table.edit' }] }
const write = { method: 'POST', body: JSON.stringify(tablePatch) }

test('rejects a known schema with an unsupported operation or wrong endpoint', () => {
  const old = { ...capabilities, patchSchemas: { 'hcd-patch/4': { route: '/patch', operations: ['block.insert'] } } }
  assert.throws(() => assertPatchSupported(old, '/patch', tablePatch), /尚未支持此操作/)
  assert.throws(() => assertPatchSupported(capabilities, '/node-patch', tablePatch), /不支持此编辑版本/)
})

test('an old service is readable but receives no editing POST', async t => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    return new Response('{}', { status: String(url).endsWith('/capabilities') ? 404 : 200 })
  })
  const current = session()
  await api(current, '')
  await assert.rejects(api(current, '/patch', write), /版本较旧/)
  assert.equal(calls.some(call => call.startsWith('POST ')), false)
})

test('valid edits carry the negotiated fingerprint; a changed service is not retried automatically', async t => {
  let reads = 0, posts = 0
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/capabilities')) { reads++; return Response.json(capabilities) }
    posts++
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('x-hcd-protocol-fingerprint'), capabilities.protocolFingerprint)
    assert.equal(headers.get('authorization'), 'Bearer test-only-token')
    return new Response('service_version_changed', { status: posts === 1 ? 409 : 200 })
  })
  const current = session()
  await assert.rejects(api(current, '/patch', write), /409/)
  assert.equal(posts, 1)
  await api(current, '/patch', write)
  assert.equal(reads, 2)
  assert.equal(posts, 2)
})

test('receipt review requires its own advertised contract before sending the exact patch', async t => {
  let supported = false
  const posts: RequestInit[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/capabilities')) return Response.json(supported ? { ...capabilities,
      nodePatchReview: { protocolVersion: 'hcd-node-patch-review/1', route: '/node-patch-review', exactPayloadAndAuthor: true },
    } : capabilities)
    posts.push(init!)
    return Response.json({ state: 'ready' })
  })
  const payload = JSON.stringify({ schemaVersion: 'hcd-patch/29', patchId: 'exact-id', operations: [{ op: 'xlsx.number.set' }] })
  const options = { method: 'POST', headers: { 'X-HCD-Collaboration-Epoch': '7' }, body: payload }
  await assert.rejects(api(session(), '/node-patch-review', options), /不支持核对提交回执/)
  assert.equal(posts.length, 0)
  supported = true
  await api(session(), '/node-patch-review', options)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].body, payload)
  const headers = new Headers(posts[0].headers)
  assert.equal(headers.get('x-hcd-protocol-fingerprint'), capabilities.protocolFingerprint)
  assert.equal(headers.get('x-hcd-collaboration-epoch'), '7')
})
