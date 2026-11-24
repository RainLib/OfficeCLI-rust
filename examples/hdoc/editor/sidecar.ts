import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Server } from '@hocuspocus/server'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import { migrateOpaqueRuns } from './src/migrateOpaqueRuns.ts'
import { jsonToSnapshot, projectionToJson, schemaExtensions, type Projection } from './src/schema.ts'

const api = process.env.HCD_API_URL || 'http://127.0.0.1:8766'
const secret = process.env.HCD_TOKEN_SECRET || ''
const keyFile = process.env.FOLDLY_COLLABORATION_KEY_FILE
const workerId = randomUUID()
const control = '/internal/collaboration'
const keyHeader = 'x-foldly-collaboration-key'
const workerHeader = 'x-foldly-collaboration-worker'
const documentHeader = 'x-foldly-collaboration-document'
const ownerHeader = 'x-hcd-collaboration-owner'
let controlKey = ''
let draining = false
if (!keyFile && Buffer.byteLength(secret) < 32) throw new Error('HCD_TOKEN_SECRET must contain at least 32 bytes')

type Room = { documentId: string; epoch: number; owner?: string }
const owners = new WeakMap<Y.Doc, string>()
function room(name: string, owner?: string): Room {
  const match = /^([A-Za-z0-9_-]{1,128}):([0-9]+)$/.exec(name)
  if (!match) throw new Error('Invalid HCD collaboration room')
  const epoch = Number(match[2])
  if (!Number.isSafeInteger(epoch)) throw new Error('Invalid collaboration epoch')
  return { documentId: match[1], epoch, owner }
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

async function request(selected: Room, route: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-HCD-Collaboration-Epoch', String(selected.epoch))
  if (keyFile) {
    if (!selected.owner) throw new Error('Missing collaboration room owner')
    headers.set(keyHeader, controlKey)
    headers.set(workerHeader, workerId)
    headers.set(ownerHeader, selected.owner)
  }
  if (token || !keyFile) headers.set('Authorization', `Bearer ${token || serviceToken(selected.documentId)}`)
  const response = await fetch(`${api}/v1/documents/${encodeURIComponent(selected.documentId)}${route}`, {
    ...init, headers, redirect: 'error',
    signal: AbortSignal.timeout(route === '/auth' ? 15_000 : 90_000),
  })
  if (response.headers.get('x-foldly-collaboration-stale') === 'true') {
    await response.body?.cancel()
    throw new StaleRoomError('HCD collaboration room has moved')
  }
  return response
}

async function currentRevision(room: Room): Promise<number> {
  const response = await request(room, '')
  if (!response.ok) throw new Error(`HCD manifest failed: ${response.status}`)
  const { revision } = await response.json() as { revision: number }
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid HCD revision')
  return revision
}

async function currentProjection(room: Room): Promise<Projection> {
  // Metadata changes (for example assigning a theme before the first edit)
  // can advance the revision without creating a structural editor projection.
  // Its capability, rather than a revision number, determines initialization.
  for (let attempt = 0; attempt < 3; attempt++) {
    const manifestResponse = await request(room, '')
    if (!manifestResponse.ok) throw new Error(`HCD manifest failed: ${manifestResponse.status}`)
    const manifest = await manifestResponse.json() as { revision: number; capabilities?: { structurePatch?: boolean } }
    if (manifest.capabilities?.structurePatch) {
      const response = await request(room, '/editor')
      if (!response.ok) throw new Error(`HCD editor projection failed: ${response.status} ${await response.text()}`)
      return await response.json() as Projection
    }
    const response = await request(room, '/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: manifest.revision }) })
    if (!response.ok && response.status !== 409 && response.status !== 400) throw new Error(`HCD editor projection creation failed: ${await response.text()}`)
    if (response.status === 400) {
      const updated = await (await request(room, '')).json() as { capabilities?: { structurePatch?: boolean } }
      if (!updated.capabilities?.structurePatch) throw new Error(`HCD editor projection creation failed: ${await response.text()}`)
    }
  }
  // A successful final creation still needs its fresh projection read.
  const response = await request(room, '/editor')
  if (!response.ok) throw new Error(`HCD editor projection failed: ${response.status} ${await response.text()}`)
  const manifest = await (await request(room, '')).json() as { capabilities?: { structurePatch?: boolean } }
  if (!manifest.capabilities?.structurePatch) throw new Error('HCD editor projection changed concurrently; retry')
  return await response.json() as Projection
}

const formatCache = new Map<string, string>()
async function documentFormat(room: Room): Promise<string> {
  const { documentId } = room
  const cached = formatCache.get(documentId)
  if (cached) return cached
  const response = await request(room, '')
  if (!response.ok) throw new Error(`HCD manifest failed: ${response.status}`)
  const manifest = await response.json() as { source: { format: string } }
  formatCache.set(documentId, manifest.source.format)
  return manifest.source.format
}

function isFixed(format: string) { return ['pdf','pptx','xlsx','csv','tsv'].includes(format) }

/** Persist the CRDT identities before acknowledging a room or checkpoint.
 * Rebuilding identical-looking paragraphs with new Yjs IDs after a restart
 * would duplicate them when an offline client reconnects. */
const writes = new WeakMap<Y.Doc, Promise<void>>()
function persistRoom(documentName: string, document: Y.Doc) {
  const selected = room(documentName, owners.get(document))
  const work = (writes.get(document) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const response = await request(selected, '/collaboration/state', {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(Y.encodeStateAsUpdate(document)),
    })
    await response.body?.cancel()
    if (response.status === 409) throw new StaleRoomError('HCD collaboration owner or generation changed')
    if (!response.ok) throw new Error(`HCD collaboration persistence failed: ${response.status}`)
  })
  writes.set(document, work)
  return work
}

type Pending = { document: Y.Doc; first: number; last: number; version: number; timer: ReturnType<typeof setTimeout> | null; saving: boolean; authors: Map<string, { name: string; version: number }>; unknownVersion: number }
const pending = new Map<string, Pending>()
type HostContext = { token?: string; hostIntegration?: boolean; scope?: string; author?: Contributor; owner?: string }
const hostConnections = new Map<HostContext, ReturnType<typeof setInterval>>()

async function authorizeHost(selected: Room, token: string) {
  if (!token) throw new Error('Missing HCD collaboration token')
  const response = await request(selected, '/auth', {}, token)
  if (!response.ok) throw new Error('Host collaboration session is no longer authorized')
  const access = await response.json() as { scope: string; collaborationEpoch: number; hostIntegration?: boolean; displayName?: string; userId?: string }
  if (access.collaborationEpoch !== selected.epoch) throw new Error('Stale host collaboration epoch')
  return access
}
const checkpoints = new Map<string, Promise<number>>()
const storageTasks = new Set<Promise<unknown>>()
const messages = new Map<object, () => void>()
let backupPause: {
  id: string; resumed: Promise<void>; release: () => void
  flushed: Promise<number>; timeout?: ReturnType<typeof setTimeout>
} | null = null

function trackStorage<T>(work: Promise<T>): Promise<T> {
  storageTasks.add(work)
  const done = () => storageTasks.delete(work)
  void work.then(done, done)
  return work
}

function autoCheckpoint(documentName: string) {
  const item = pending.get(documentName)
  if (item) item.timer = null
  if (!backupPause) void checkpoint(documentName).catch(() => {})
}

function resumeAfterBackup(id?: string) {
  if (!backupPause || id !== undefined && id !== backupPause.id) return
  const pause = backupPause
  backupPause = null
  clearTimeout(pause.timeout)
  pause.release()
  for (const [name, item] of pending) {
    if (!item.timer && !checkpoints.has(name)) item.timer = setTimeout(() => autoCheckpoint(name), 0)
  }
}

function freezeForBackup(id: string): Promise<number> {
  if (backupPause) {
    if (backupPause.id === id) return backupPause.flushed
    return Promise.reject(new Error('Another collaboration backup is active'))
  }
  let release = () => {}
  const resumed = new Promise<void>(done => { release = done })
  const flushed = Promise.resolve().then(async () => {
    // onChange is detached by Hocuspocus. It registers its storage work
    // before awaiting so updates already admitted are included in the cut.
    while (storageTasks.size || checkpoints.size) await Promise.allSettled([...storageTasks, ...checkpoints.values()])
    if (backupPause?.id !== id) throw new Error('Collaboration freeze was cancelled')
    const names = [...pending.keys()]
    let saved = 0
    for (let start = 0; start < names.length; start += 4) {
      const results = await Promise.allSettled(names.slice(start, start + 4).map(checkpoint))
      for (const result of results) {
        if (result.status === 'fulfilled') saved++
        else if (!(result.reason instanceof StaleRoomError)) throw result.reason
      }
      if (backupPause?.id !== id) throw new Error('Collaboration freeze was cancelled')
    }
    return saved
  })
  // The workspace can restart while the remote pause is held.
  const timeout = keyFile ? setTimeout(() => resumeAfterBackup(id), 300_000) : undefined
  timeout?.unref()
  backupPause = { id, release, resumed, flushed, timeout }
  return flushed.catch(error => {
    resumeAfterBackup(id)
    throw error
  })
}

// Standalone Workspace and Electron use the same pause without network control.
if (process.send) {
  process.on('disconnect', () => resumeAfterBackup())
  process.on('message', (message: { type?: string; id?: string }) => {
    if (!message?.id) return
    const { type, id } = message
    if (type === 'backup-resume') {
      resumeAfterBackup(id)
      process.send?.({ type, id }, () => {})
      return
    }
    if (type !== 'backup-freeze') return
    void freezeForBackup(id).then(flushed => {
      process.send?.({ type, id, flushed }, () => {})
    }).catch(() => {
      process.send?.({ type, id, error: '协作修改尚未完成落盘，未生成备份。' }, () => {})
    })
  })
}

let pendingSequence = Date.now() * 1000
class StaleRoomError extends Error {}
async function markPending(selected: Room, dirty: boolean) {
  const response = await request(selected, '/collaboration/pending', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dirty, sequence: ++pendingSequence }),
  })
  await response.body?.cancel()
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
  item.timer = setTimeout(() => autoCheckpoint(documentId), Math.max(0, due - now))
  pending.set(documentId, item)
  announceSave(documentId, 'editing')
}

function discardStaleRoom(documentName: string, document: Y.Doc) {
  const item = pending.get(documentName)
  if (item?.document === document) {
    if (item.timer) clearTimeout(item.timer)
    pending.delete(documentName)
  }
  if (server.hocuspocus.documents.get(documentName) === document) {
    server.hocuspocus.closeConnections(documentName)
  }
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
  if (!item) {
    const document = server.hocuspocus.documents.get(documentId)
    return currentRevision(room(documentId, document && owners.get(document)))
  }
  item.saving = true
  if (item.timer) clearTimeout(item.timer)
  item.timer = null
  announceSave(documentId, 'saving')
  try {
    const selected = room(documentId, owners.get(item.document))
    const revision = await currentRevision(selected)
    // Capture content and contributors in one synchronous turn. Changes that
    // arrive while fetching the head must be included in both or neither.
    const version = item.version
    const authors = [...item.authors]
    const author = !item.unknownVersion && authors.length === 1 ? { id: authors[0][0], name: authors[0][1].name } : undefined
    const json = TiptapTransformer.fromYdoc(item.document, 'default')
    const blocks = jsonToSnapshot(json)
    const response = await request(selected, '/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(author ? { 'X-HCD-Checkpoint-Author': Buffer.from(JSON.stringify(author)).toString('base64url') } : {}) },
      body: JSON.stringify({ expectedRevision: revision, blocks }),
    })
    if (response.status === 409) {
      await response.body?.cancel()
      discardStaleRoom(documentId, item.document)
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
    if (item.version === version) {
      await markPending(selected, false)
      if (pending.get(documentId) === item && item.version === version) pending.delete(documentId)
    }
    announceSave(documentId, 'saved', saved.revision)
    console.log(`HCD checkpoint ${documentId} revision ${saved.revision}`)
    return saved.revision
  } catch (error) {
    if (error instanceof StaleRoomError) {
      discardStaleRoom(documentId, item.document)
      throw error
    }
    console.error(error)
    announceSave(documentId, 'failed')
    if (pending.get(documentId) === item) item.timer = setTimeout(() => autoCheckpoint(documentId), 5000)
    throw error
  } finally {
    item.saving = false
  }
}

function validKey(value: string | string[] | undefined) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) &&
    timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(controlKey, 'hex'))
}

async function retireOldDocument(documentName: string, owner: string) {
  const instance = server.hocuspocus
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const document = instance.documents.get(documentName)
    if (!document && !instance.loadingDocuments.has(documentName) || document && owners.get(document) === owner) return
    if (document) {
      discardStaleRoom(documentName, document)
      await instance.unloadDocument(document)
    }
    await delay(50)
  }
  throw new Error('Previous collaboration owner is still unloading')
}

const server = new Server<HostContext>({
  address: process.env.HCD_COLLAB_BIND || '127.0.0.1',
  port: Number(process.env.HCD_COLLAB_PORT || 8768),
  stopOnSignals: !keyFile,
  debounce: 1000,
  maxDebounce: 5000,
  websocketOptions: { maxPayload: 1024 * 1024 },
  async onRequest({ request, response }) {
    if (!keyFile) return
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(draining ? 503 : 204).end()
    } else if (!validKey(request.headers[keyHeader])) {
      response.writeHead(403).end()
    } else if (request.method === 'GET' && request.url === control) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: workerId, draining }))
    } else {
      const id = /^\/internal\/collaboration\/backup\/([a-f0-9-]{36})$/.exec(request.url || '')?.[1]
      if (!id || request.headers[workerHeader] !== workerId) response.writeHead(404).end()
      else if (request.method === 'DELETE') {
        resumeAfterBackup(id)
        response.writeHead(204).end()
      } else if (request.method === 'PUT') {
        try {
          const flushed = await freezeForBackup(id)
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ flushed }))
        } catch (error) {
          console.error('Collaboration backup freeze failed:', error)
          response.writeHead(503).end()
        }
      } else response.writeHead(405).end()
    }
    // Prevent Hocuspocus from sending its default response a second time.
    throw null
  },
  async onUpgrade({ request, socket }) {
    if (!keyFile) return
    if (draining || !validKey(request.headers[keyHeader]) || request.headers[workerHeader] !== workerId) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      throw null
    }
  },
  async onAuthenticate({ documentName, token, connectionConfig, requestHeaders }) {
    const owner = requestHeaders.get(ownerHeader) ?? undefined
    const selected = room(documentName, owner)
    if (keyFile && (!owner || !/^[a-f0-9-]{36}$/.test(owner) || requestHeaders.get(documentHeader) !== selected.documentId)) {
      throw new Error('HCD collaboration connection is bound to another document')
    }
    const access = await authorizeHost(selected, token)
    if (keyFile && owner) await retireOldDocument(documentName, owner)
    connectionConfig.readOnly = access.scope !== 'write'
    return { scope: access.scope, token, owner, hostIntegration: access.hostIntegration === true,
      author: access.userId ? { id: access.userId, name: access.displayName || access.userId } : undefined }
  },
  async onTokenSync({ documentName, token, connection, context }) {
    const access = await authorizeHost(room(documentName, context.owner), token)
    connection.readOnly = access.scope !== 'write'
    Object.assign(context as HostContext, { token, scope: access.scope, author: access.userId ? { id: access.userId, name: access.displayName || access.userId } : undefined })
  },
  async connected({ documentName, connection, context }) {
    const host = context as HostContext
    if (!host.hostIntegration) return
    const timer = setInterval(() => {
      void authorizeHost(room(documentName, host.owner), host.token || '').then(access => {
        connection.readOnly = access.scope !== 'write'
      }).catch(() => { connection.readOnly = true; connection.close() })
    }, 30_000)
    timer.unref()
    hostConnections.set(host, timer)
  },
  async beforeHandleMessage({ documentName, document, connection, context }) {
    const host = context as HostContext
    if (keyFile && (!host.owner || owners.get(document) !== host.owner)) {
      connection.close()
      throw new StaleRoomError('HCD collaboration owner changed')
    }
    if (host.hostIntegration) {
      try {
        const access = await authorizeHost(room(documentName, host.owner), host.token || '')
        connection.readOnly = access.scope !== 'write'
      } catch (error) {
        connection.readOnly = true
        connection.close()
        throw error
      }
    }
    if (!process.send && !keyFile) return
    while (backupPause) await backupPause.resumed
    void trackStorage(new Promise<void>(done => messages.set(connection, done)))
  },
  async afterHandleMessage({ connection }) {
    messages.get(connection)?.()
    messages.delete(connection)
  },
  async onDisconnect({ context }) {
    const timer = hostConnections.get(context as HostContext)
    if (timer) clearInterval(timer)
    hostConnections.delete(context as HostContext)
  },
  async onLoadDocument({ documentName, document, context }) {
    while (backupPause) await backupPause.resumed
    return trackStorage((async () => {
      const selected = room(documentName, context.owner)
      if (selected.owner) owners.set(document, selected.owner)
      const format = await documentFormat(selected)
      if (isFixed(format)) return
      const response = await request(selected, '/collaboration/state')
      const dirty = response.headers.get('x-hcd-collaboration-dirty') === 'true'
      if (response.ok) {
        // Upgrade existing rooms once, on the server, so two opening browsers
        // cannot both insert duplicate collaborative runs into an old atom.
        Y.applyUpdate(document, new Uint8Array(await response.arrayBuffer()))
        migrateOpaqueRuns(document)
      } else {
        if (response.status !== 404) throw new Error(`HCD collaboration load failed: ${await response.text()}`)
        await response.body?.cancel()
        const projection = await currentProjection(selected)
        const seed = TiptapTransformer.toYdoc(projectionToJson(projection), 'default', schemaExtensions)
        Y.applyUpdate(document, Y.encodeStateAsUpdate(seed))
        seed.destroy()
      }
      if (!document.getMap('hcd-room').has('generation')) document.getMap('hcd-room').set('generation', randomUUID())
      await persistRoom(documentName, document)
      if (dirty) schedule(documentName, document)
    })())
  },
  async onStoreDocument({ documentName, document }) {
    // The synchronous pause check precedes any storage work. Dirty rooms are
    // persisted by the forced checkpoint while the backup pause is in effect.
    if (backupPause) return
    return trackStorage((async () => {
      try {
        if (!isFixed(await documentFormat(room(documentName, owners.get(document))))) await persistRoom(documentName, document)
      } catch (error) {
        if (error instanceof StaleRoomError && keyFile) {
          discardStaleRoom(documentName, document)
          return
        }
        announceSave(documentName, 'failed')
        throw error
      }
    })())
  },
  async onChange({ documentName, document, transactionOrigin, context }) {
    // Hocuspocus invokes onChange without awaiting its promise. A stale room
    // during reconnect must not become an unhandled rejection and terminate
    // collaboration for every document served by this process.
    return trackStorage((async () => {
      try {
        const selected = room(documentName, owners.get(document))
        if (isFixed(await documentFormat(selected))) return
        if (transactionOrigin === 'hcd-canonical-ids') return
        schedule(documentName, document, (context as HostContext | undefined)?.author)
        await markPending(selected, true)
      } catch (error) {
        announceSave(documentName, 'failed')
        if (error instanceof StaleRoomError) discardStaleRoom(documentName, document)
        console.error('HCD collaboration change rejected:', error)
      }
    })())
  },
  async onStateless({ documentName, document, connection, payload }) {
    if (connection.readOnly) return
    const selected = room(documentName, owners.get(document))
    const fixed = isFixed(await documentFormat(selected))
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
    const response = await request(selected, '')
    if (!response.ok) return
    const head = await response.json() as { revision: number }
    if (head.revision < message.revision!) return
    document.broadcastStateless(JSON.stringify({ type: 'hcd-fixed-revision', revision: head.revision }))
  },
})

async function start() {
  if (keyFile) {
    const deadline = Date.now() + 120_000
    while (!/^[a-f0-9]{64}$/.test(controlKey) && Date.now() < deadline) {
      controlKey = (await readFile(keyFile, 'utf8').catch(error => {
        if (error.code === 'ENOENT' || error.code === 'EACCES') return ''
        throw error
      })).trim()
      if (!/^[a-f0-9]{64}$/.test(controlKey)) await delay(250)
    }
    if (!/^[a-f0-9]{64}$/.test(controlKey)) throw new Error('Collaboration service key is unavailable')
    const stop = async () => {
      if (draining) return
      draining = true
      try {
        await (backupPause?.flushed ?? freezeForBackup(randomUUID()))
        await server.destroy()
      } catch (error) {
        console.error('Collaboration shutdown could not flush all rooms:', error)
        process.exitCode = 1
      } finally {
        process.exit()
      }
    }
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stop())
  }
  await server.listen()
}
void start().catch(error => {
  console.error(error)
  process.exitCode = 1
})
