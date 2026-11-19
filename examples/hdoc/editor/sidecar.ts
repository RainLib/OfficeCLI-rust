import { createHmac, randomUUID } from 'node:crypto'
import { Server } from '@hocuspocus/server'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import { migrateOpaqueRuns } from './src/migrateOpaqueRuns.ts'
import { jsonToSnapshot, projectionToJson, schemaExtensions, type Projection } from './src/schema.ts'

const api = process.env.HCD_API_URL || 'http://127.0.0.1:8766'
const secret = process.env.HCD_TOKEN_SECRET || ''
if (Buffer.byteLength(secret) < 32) throw new Error('HCD_TOKEN_SECRET must contain at least 32 bytes')

function room(name: string): { documentId: string; epoch: number } {
  const match = /^([A-Za-z0-9_-]{1,128}):([0-9]+)$/.exec(name)
  if (!match) throw new Error('Invalid HCD collaboration room')
  const epoch = Number(match[2])
  if (!Number.isSafeInteger(epoch)) throw new Error('Invalid collaboration epoch')
  return { documentId: match[1], epoch }
}

type Contributor = { id: string; name: string }
function serviceToken(documentId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  // Authors come from engine-authenticated connections, never client awareness.
  // A checkpoint with several writers retains the collaboration service identity.
  const payload = Buffer.from(JSON.stringify({ doc: documentId, scope: 'write', sub: 'hcd-collaboration', name: 'Collaboration autosave', aud: 'hcd-core', iat: now, exp: now + 60 })).toString('base64url')
  const signed = `${header}.${payload}`
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`
}

async function request(documentId: string, route: string, init: RequestInit = {}, epoch?: number): Promise<Response> {
  return fetch(`${api}/v1/documents/${encodeURIComponent(documentId)}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${serviceToken(documentId)}`,
      ...(epoch === undefined ? {} : { 'X-HCD-Collaboration-Epoch': String(epoch) }), ...(init.headers || {}) },
  })
}

async function currentRevision(documentId: string): Promise<number> {
  const response = await request(documentId, '')
  if (!response.ok) throw new Error(`HCD manifest failed: ${response.status}`)
  const { revision } = await response.json() as { revision: number }
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid HCD revision')
  return revision
}

async function currentProjection(documentId: string): Promise<Projection> {
  // Metadata changes (for example assigning a theme before the first edit)
  // can advance the revision without creating a structural editor projection.
  // Its capability, rather than a revision number, determines initialization.
  for (let attempt = 0; attempt < 3; attempt++) {
    const manifestResponse = await request(documentId, '')
    if (!manifestResponse.ok) throw new Error(`HCD manifest failed: ${manifestResponse.status}`)
    const manifest = await manifestResponse.json() as { revision: number; capabilities?: { structurePatch?: boolean } }
    if (manifest.capabilities?.structurePatch) {
      const response = await request(documentId, '/editor')
      if (!response.ok) throw new Error(`HCD editor projection failed: ${response.status} ${await response.text()}`)
      return await response.json() as Projection
    }
    const response = await request(documentId, '/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: manifest.revision }) })
    if (!response.ok && response.status !== 409 && response.status !== 400) throw new Error(`HCD editor projection creation failed: ${await response.text()}`)
    if (response.status === 400) {
      const updated = await (await request(documentId, '')).json() as { capabilities?: { structurePatch?: boolean } }
      if (!updated.capabilities?.structurePatch) throw new Error(`HCD editor projection creation failed: ${await response.text()}`)
    }
  }
  // A successful final creation still needs its fresh projection read.
  const response = await request(documentId, '/editor')
  if (!response.ok) throw new Error(`HCD editor projection failed: ${response.status} ${await response.text()}`)
  const manifest = await (await request(documentId, '')).json() as { capabilities?: { structurePatch?: boolean } }
  if (!manifest.capabilities?.structurePatch) throw new Error('HCD editor projection changed concurrently; retry')
  return await response.json() as Projection
}

const formatCache = new Map<string, string>()
async function documentFormat(documentId: string): Promise<string> {
  const cached = formatCache.get(documentId)
  if (cached) return cached
  const response = await request(documentId, '')
  if (!response.ok) throw new Error(`HCD manifest failed: ${response.status}`)
  const manifest = await response.json() as { source: { format: string } }
  formatCache.set(documentId, manifest.source.format)
  return manifest.source.format
}

function isFixed(format: string) { return format === 'pdf' || format === 'pptx' || format === 'xlsx' }

/** Persist the CRDT identities before acknowledging a room or checkpoint.
 * Rebuilding identical-looking paragraphs with new Yjs IDs after a restart
 * would duplicate them when an offline client reconnects. */
async function persistRoom(documentName: string, document: Y.Doc) {
  const selected = room(documentName)
  const response = await request(selected.documentId, '/collaboration/state', {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(Y.encodeStateAsUpdate(document)),
  }, selected.epoch)
  if (!response.ok) throw new Error(`HCD collaboration persistence failed: ${response.status}`)
}

type Pending = { document: Y.Doc; first: number; last: number; version: number; timer: ReturnType<typeof setTimeout> | null; saving: boolean; authors: Map<string, { name: string; version: number }>; unknownVersion: number }
const pending = new Map<string, Pending>()
type HostContext = { token?: string; hostIntegration?: boolean; scope?: string; author?: Contributor }
const hostConnections = new Map<HostContext, ReturnType<typeof setInterval>>()

async function reauthorizeHost(documentName: string, token: string) {
  const selected = room(documentName)
  const response = await fetch(`${api}/v1/documents/${encodeURIComponent(selected.documentId)}/auth`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error('Host collaboration session is no longer authorized')
  const access = await response.json() as { scope: string; collaborationEpoch: number; hostIntegration?: boolean }
  if (access.collaborationEpoch !== selected.epoch) throw new Error('Stale host collaboration epoch')
  return access
}
const checkpoints = new Map<string, Promise<number>>()
let pendingSequence = Date.now() * 1000
class StaleRoomError extends Error {}
async function markPending(documentName: string, dirty: boolean) {
  const selected = room(documentName)
  const response = await request(selected.documentId, '/collaboration/pending', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dirty, sequence: ++pendingSequence }),
  }, selected.epoch)
  if (response.status === 409) throw new StaleRoomError('HCD collaboration generation changed')
  if (!response.ok) throw new Error(`HCD pending state failed: ${response.status}`)
}

function announceSave(documentId: string, status: 'editing' | 'saving' | 'saved' | 'failed', revision?: number) {
  server.hocuspocus.documents.get(documentId)?.broadcastStateless(JSON.stringify({
    type: 'hcd-save-status', status, revision,
  }))
}

function schedule(documentId: string, document: Y.Doc, author?: Contributor) {
  const now = Date.now()
  const item: Pending = pending.get(documentId) || { document, first: now, last: now, version: 0, timer: null, saving: false, authors: new Map(), unknownVersion: 0 }
  item.version++
  if (author) item.authors.set(author.id, { name: author.name, version: item.version })
  else item.unknownVersion = item.version
  item.document = document
  item.last = now
  if (item.timer) clearTimeout(item.timer)
  const due = Math.min(item.last + 30_000, item.first + 60_000)
  item.timer = setTimeout(() => void checkpoint(documentId).catch(() => {}), Math.max(0, due - now))
  pending.set(documentId, item)
  announceSave(documentId, 'editing')
}

function yBlocks(document: Y.Doc): Y.XmlElement[] {
  const result: Y.XmlElement[] = []
  for (const item of document.getXmlFragment('default').toArray()) {
    if (!(item instanceof Y.XmlElement)) continue
    if (item.nodeName === 'bulletList' || item.nodeName === 'orderedList') {
      for (const nested of item.toArray()) if (nested instanceof Y.XmlElement && nested.nodeName === 'listItem') result.push(nested)
    } else result.push(item)
  }
  return result
}

function checkpoint(documentId: string): Promise<number> {
  const running = checkpoints.get(documentId)
  if (running) return running
  const work = storeCheckpoint(documentId).finally(() => checkpoints.delete(documentId))
  checkpoints.set(documentId, work)
  return work
}

async function storeCheckpoint(documentId: string): Promise<number> {
  const item = pending.get(documentId)
  // Checkpoint coordination only needs the current revision. Reading and
  // transferring the complete semantic document here slows every clean table
  // action and every autosave; room initialization already created projection.
  if (!item) return currentRevision(room(documentId).documentId)
  item.saving = true
  if (item.timer) clearTimeout(item.timer)
  item.timer = null
  announceSave(documentId, 'saving')
  try {
    const selected = room(documentId)
    const revision = await currentRevision(selected.documentId)
    // Capture content and contributors in one synchronous turn. Changes that
    // arrive while fetching the head must be included in both or neither.
    const version = item.version
    const authors = [...item.authors]
    const author = !item.unknownVersion && authors.length === 1 ? { id: authors[0][0], name: authors[0][1].name } : undefined
    const json = TiptapTransformer.fromYdoc(item.document, 'default')
    const blocks = jsonToSnapshot(json)
    const response = await request(selected.documentId, '/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(author ? { 'X-HCD-Checkpoint-Author': Buffer.from(JSON.stringify(author)).toString('base64url') } : {}) },
      body: JSON.stringify({ expectedRevision: revision, blocks }),
    }, selected.epoch)
    if (response.status === 409) {
      pending.delete(documentId)
      server.hocuspocus.closeConnections(documentId)
      throw new Error('HCD checkpoint conflicted; reload the current collaboration room')
    }
    if (!response.ok) throw new Error(`HCD checkpoint failed: ${response.status} ${await response.text()}`)
    const saved = await response.json() as { projection: Projection; revision: number }
    const canonical = saved.projection.blocks.filter(block => block.region === 'body')
    const xml = yBlocks(item.document)
    if (xml.length === canonical.length) {
      item.document.transact(() => {
        xml.forEach((node, index) => {
          if (node.getAttribute('hcdBlockId') !== canonical[index].blockId) node.setAttribute('hcdBlockId', canonical[index].blockId)
        })
      }, 'hcd-canonical-ids')
    }
    await persistRoom(documentId, item.document)
    for (const [id, contributor] of item.authors) if (contributor.version <= version) item.authors.delete(id)
    if (item.unknownVersion <= version) item.unknownVersion = 0
    item.first = Date.now()
    if (item.version === version) await markPending(documentId, false)
    announceSave(documentId, 'saved', saved.revision)
    console.log(`HCD checkpoint ${documentId} revision ${saved.revision}`)
    return saved.revision
  } catch (error) {
    console.error(error)
    announceSave(documentId, 'failed')
    if (pending.get(documentId) === item) item.timer = setTimeout(() => void checkpoint(documentId).catch(() => {}), 5000)
    throw error
  } finally {
    item.saving = false
  }
}

const server = new Server({
  address: process.env.HCD_COLLAB_BIND || '127.0.0.1',
  port: Number(process.env.HCD_COLLAB_PORT || 8768),
  debounce: 1000,
  maxDebounce: 5000,
  websocketOptions: { maxPayload: 1024 * 1024 },
  async onAuthenticate({ documentName, token, connectionConfig }) {
    const selected = room(documentName)
    const response = await fetch(`${api}/v1/documents/${encodeURIComponent(selected.documentId)}/auth`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error('Unauthorized HCD collaboration connection')
    const access = await response.json() as { scope: string; collaborationEpoch: number; hostIntegration?: boolean; userId?: string; displayName?: string }
    if (access.collaborationEpoch !== selected.epoch) throw new Error('Stale HCD collaboration room')
    connectionConfig.readOnly = access.scope !== 'write'
    return { scope: access.scope, token, hostIntegration: access.hostIntegration === true,
      author: access.userId ? { id: access.userId, name: access.displayName || access.userId } : undefined }
  },
  async onTokenSync({ documentName, token, connection, context }) {
    const selected = room(documentName)
    const response = await fetch(`${api}/v1/documents/${encodeURIComponent(selected.documentId)}/auth`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error('Expired HCD collaboration token')
    const access = await response.json() as { scope: string; collaborationEpoch: number; userId?: string; displayName?: string }
    if (access.collaborationEpoch !== selected.epoch) throw new Error('Stale HCD collaboration room')
    connection.readOnly = access.scope !== 'write'
    Object.assign(context as HostContext, { token, scope: access.scope, author: access.userId ? { id: access.userId, name: access.displayName || access.userId } : undefined })
  },
  async connected({ documentName, connection, context }) {
    const host = context as HostContext
    if (!host.hostIntegration) return
    const timer = setInterval(() => {
      void reauthorizeHost(documentName, host.token || '').then(access => {
        connection.readOnly = access.scope !== 'write'
      }).catch(() => { connection.readOnly = true; connection.close() })
    }, 30_000)
    timer.unref()
    hostConnections.set(host, timer)
  },
  async beforeHandleMessage({ documentName, connection, context }) {
    const host = context as HostContext
    if (!host.hostIntegration) return
    try {
      const access = await reauthorizeHost(documentName, host.token || '')
      connection.readOnly = access.scope !== 'write'
    } catch (error) {
      connection.readOnly = true
      connection.close()
      throw error
    }
  },
  async onDisconnect({ context }) {
    const timer = hostConnections.get(context as HostContext)
    if (timer) clearInterval(timer)
    hostConnections.delete(context as HostContext)
  },
  async onLoadDocument({ documentName }) {
    const selected = room(documentName)
    if (isFixed(await documentFormat(selected.documentId))) return new Y.Doc()
    const response = await request(selected.documentId, '/collaboration/state', {}, selected.epoch)
    if (response.ok) {
      // Upgrade existing rooms once, on the server, so two opening browsers
      // cannot both insert duplicate collaborative runs into an old atom.
      const document = new Y.Doc()
      Y.applyUpdate(document, new Uint8Array(await response.arrayBuffer()))
      migrateOpaqueRuns(document)
      if (!document.getMap('hcd-room').has('generation')) document.getMap('hcd-room').set('generation', randomUUID())
      await persistRoom(documentName, document)
      return document
    }
    if (response.status !== 404) throw new Error(`HCD collaboration load failed: ${await response.text()}`)
    const projection = await currentProjection(selected.documentId)
    const document = TiptapTransformer.toYdoc(projectionToJson(projection), 'default', schemaExtensions)
    document.getMap('hcd-room').set('generation', randomUUID())
    await persistRoom(documentName, document)
    return document
  },
  async onStoreDocument({ documentName, document }) {
    const selected = room(documentName)
    if (isFixed(await documentFormat(selected.documentId))) return
    try { await persistRoom(documentName, document) } catch (error) {
      announceSave(documentName, 'failed')
      throw error
    }
  },
  async onChange({ documentName, document, transactionOrigin, context }) {
    // Hocuspocus invokes onChange without awaiting its promise. A stale room
    // during reconnect must not become an unhandled rejection and terminate
    // collaboration for every document served by this process.
    try {
      if (isFixed(await documentFormat(room(documentName).documentId))) return
      if (transactionOrigin === 'hcd-canonical-ids') return
      schedule(documentName, document, (context as HostContext | undefined)?.author)
      await markPending(documentName, true)
    } catch (error) {
      announceSave(documentName, 'failed')
      if (error instanceof StaleRoomError) {
        const item = pending.get(documentName)
        if (item?.timer) clearTimeout(item.timer)
        pending.delete(documentName)
        server.hocuspocus.closeConnections(documentName)
      }
      console.error('HCD collaboration change rejected:', error)
    }
  },
  async onStateless({ documentName, document, connection, payload }) {
    if (connection.readOnly) return
    const selected = room(documentName)
    const fixed = isFixed(await documentFormat(selected.documentId))
    let message: { type?: string; revision?: number; requestId?: string }
    try { message = JSON.parse(payload) } catch { return }
    if (!fixed && message.type === 'hcd-checkpoint' && typeof message.requestId === 'string' && message.requestId.length <= 64) {
      try {
        const revision = await checkpoint(documentName)
        connection.sendStateless(JSON.stringify({ type: 'hcd-checkpoint-result', requestId: message.requestId, revision }))
      } catch {
        connection.sendStateless(JSON.stringify({ type: 'hcd-checkpoint-result', requestId: message.requestId, error: 'checkpoint failed' }))
      }
      return
    }
    if (!fixed) return
    if (message.type !== 'hcd-fixed-revision' || !Number.isSafeInteger(message.revision)) return
    const response = await request(selected.documentId, '')
    if (!response.ok) return
    const head = await response.json() as { revision: number }
    if (head.revision < message.revision!) return
    document.broadcastStateless(JSON.stringify({ type: 'hcd-fixed-revision', revision: head.revision }))
  },
})

server.listen()
