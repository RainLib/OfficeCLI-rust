import { SemanticSaveCoordinator } from './src/semanticSaveCoordinator.ts'
import { upgradeTypography } from './src/typographyMigration.ts'
import { createHmac } from 'node:crypto'
import { Server } from '@hocuspocus/server'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import { projectionToJson, schemaExtensions, type Projection } from './src/schema.ts'

const api = process.env.HCD_API_URL || 'http://127.0.0.1:8766'
const secret = process.env.HCD_TOKEN_SECRET || ''
if (Buffer.byteLength(secret) < 32) throw new Error('HCD_TOKEN_SECRET must contain at least 32 bytes')

function room(name: string): { documentId: string; epoch: number; fixed: boolean } {
  const match = /^(fixed:)?([A-Za-z0-9_-]{1,128}):([0-9]+)(:typography2:save4)?$/.exec(name)
  if (!match) throw new Error('Invalid HCD collaboration room')
  if (!match[1] && !match[4]) throw new Error('Reload a save-coordinator-aware HCD editor')
  const epoch = Number(match[3])
  if (!Number.isSafeInteger(epoch)) throw new Error('Invalid collaboration epoch')
  return { documentId: match[2], epoch, fixed: !!match[1] }
}

function serviceToken(documentId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  // A checkpoint may contain updates from several people. Attribute it to the
  // collaboration service rather than claiming a single person authored it.
  const payload = Buffer.from(JSON.stringify({ doc: documentId, scope: 'write', sub: 'hcd-collaboration', name: 'Collaboration autosave', aud: 'hcd-core', iat: now, exp: now + 60 })).toString('base64url')
  const signed = `${header}.${payload}`
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`
}

async function request(documentId: string, route: string, init: RequestInit = {}, epoch?: number): Promise<Response> {
  return fetch(`${api}/v1/documents/${encodeURIComponent(documentId)}${route}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${serviceToken(documentId)}`,
      ...(epoch === undefined ? {} : { 'X-HCD-Collaboration-Epoch': String(epoch) }), ...(init.headers || {}) },
  })
}

async function currentProjection(documentId: string): Promise<Projection> {
  let response = await request(documentId, '/editor')
  if (!response.ok) throw new Error(`HCD editor projection failed: ${response.status} ${await response.text()}`)
  let projection = await response.json() as Projection
  if (projection.revision === 0) {
    const manifestResponse = await request(documentId, '')
    const manifest = await manifestResponse.json() as { capabilities?: { structurePatch?: boolean } }
    if (!manifest.capabilities?.structurePatch) {
      response = await request(documentId, '/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0 }) })
      if (!response.ok && response.status !== 400) throw new Error(`HCD editor projection creation failed: ${await response.text()}`)
      projection = await (await request(documentId, '/editor')).json() as Projection
    }
  }
  return projection
}

const coordinators = new Map<string, SemanticSaveCoordinator>()
const loaded = new Map<string, { projection: Projection; legacyProblem: boolean; stateHash: string }>()
type Access = { scope: string; collaborationEpoch: number; userId?: string; displayName?: string; expiresAt: number }
type User = Access & { token: string }

async function access(documentId: string, token: string): Promise<Access> {
  const response = await fetch(`${api}/v1/documents/${encodeURIComponent(documentId)}/auth`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('Unauthorized HCD collaboration connection')
  return await response.json() as Access
}

const server = new Server({
  address: process.env.HCD_COLLAB_BIND || '127.0.0.1',
  port: Number(process.env.HCD_COLLAB_PORT || 8768),
  debounce: 1000,
  maxDebounce: 5000,
  websocketOptions: { maxPayload: 1024 * 1024 },
  async onAuthenticate({ documentName, token, connectionConfig }) {
    const selected = room(documentName), user = await access(selected.documentId, token)
    if (!selected.fixed && user.collaborationEpoch !== selected.epoch) throw new Error('Stale HCD collaboration room')
    connectionConfig.readOnly = selected.fixed || user.scope !== 'write'
    return { ...user, token }
  },
  async onTokenSync({ documentName, token, connection }) {
    const selected = room(documentName), user = await access(selected.documentId, token)
    if (!selected.fixed && user.collaborationEpoch !== selected.epoch) throw new Error('Stale HCD collaboration room')
    connection.readOnly = selected.fixed || user.scope !== 'write'
    Object.assign(connection.context, user, { token })
  },
  async beforeHandleMessage({ connection }) {
    if (Date.now() >= Number((connection.context as User)?.expiresAt) * 1000) {
      connection.readOnly = true
      throw new Error('HCD collaboration access expired')
    }
  },
  async onLoadDocument({ documentName }) {
    const selected = room(documentName)
    if (selected.fixed) return new Y.Doc()
    const response = await request(selected.documentId, '/collaboration/state', {}, selected.epoch)
    const projection = await currentProjection(selected.documentId)
    let document: Y.Doc
    let legacyProblem = false
    if (response.ok) {
      document = new Y.Doc()
      Y.applyUpdate(document, new Uint8Array(await response.arrayBuffer()))
      try { upgradeTypography(document, projection) }
      catch { legacyProblem = true }
    } else {
      if (response.status !== 404) throw new Error(`HCD collaboration load failed: ${response.status}`)
      document = TiptapTransformer.toYdoc(projectionToJson(projection), 'default', schemaExtensions)
      document.getMap('hcdSchema').set('typography', 2)
      document.getMap('hcdSchema').set('sourceIdentity', 1)
    }
    loaded.set(documentName, { projection, legacyProblem, stateHash: response.ok ? response.headers.get('x-hcd-state-hash') ?? 'invalid' : 'none' })
    return document
  },
  async afterLoadDocument({ documentName, document }) {
    const selected = room(documentName)
    if (selected.fixed) return
    const initial = loaded.get(documentName)
    if (!initial) throw new Error('Missing collaboration baseline')
    loaded.delete(documentName)
    const coordinator = new SemanticSaveCoordinator({ ...selected, document, secret, stateHash: initial.stateHash,
      request: (route, init) => request(selected.documentId, route, init, selected.epoch),
      broadcast: state => document.broadcastStateless(JSON.stringify(state)),
    })
    coordinators.set(documentName, coordinator)
    await coordinator.initialize(initial.projection, initial.legacyProblem)
  },
  async onStoreDocument({ documentName }) {
    await coordinators.get(documentName)?.persist()
  },
  async onChange({ documentName, context, transactionOrigin }) {
    coordinators.get(documentName)?.changed(context as User, transactionOrigin)
  },
  async onStateless({ documentName, connection, payload }) {
    const coordinator = coordinators.get(documentName)
    if (!coordinator || payload.length > 4096) return
    let message: { type?: string; requestId?: string; digest?: string; imageDigest?: string }
    try { message = JSON.parse(payload) } catch { return }
    if (message.type === 'hcd-save-state') {
      try { connection.sendStateless(JSON.stringify(await coordinator.inspect())) }
      catch { connection.sendStateless(JSON.stringify(coordinator.state('failed'))) }
      return
    }
    if (message.type !== 'hcd-save' || !/^[a-f0-9-]{36}$/.test(message.requestId ?? '') || !/^[a-f0-9]{64}$/.test(message.digest ?? '') || !/^[a-f0-9]{64}$/.test(message.imageDigest ?? '')) return
    const reply = (state: object) => connection.sendStateless(JSON.stringify({ ...state, requestId: message.requestId }))
    try {
      const selected = room(documentName), user = await access(selected.documentId, (connection.context as User).token)
      if (connection.readOnly || user.scope !== 'write') { reply({ type: 'hcd-save-status', status: 'failed', conflict: 'read-only' }); return }
      const result = await coordinator.save(message.digest,message.imageDigest)
      reply(result)
    } catch { reply({ type: 'hcd-save-status', status: 'failed' }) }
  },
  async beforeUnloadDocument({ documentName }) {
    await coordinators.get(documentName)?.prepareUnload()
  },
  async afterUnloadDocument({ documentName }) {
    coordinators.get(documentName)?.dispose()
    coordinators.delete(documentName)
    loaded.delete(documentName)
  },
})

server.listen()
