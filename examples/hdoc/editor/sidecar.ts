import { createHmac } from 'node:crypto'
import { Server } from '@hocuspocus/server'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
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

function serviceToken(documentId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ doc: documentId, scope: 'write', aud: 'hcd-core', iat: now, exp: now + 60 })).toString('base64url')
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

type Pending = { document: Y.Doc; first: number; last: number; timer: ReturnType<typeof setTimeout> | null; saving: boolean }
const pending = new Map<string, Pending>()

function schedule(documentId: string, document: Y.Doc) {
  const now = Date.now()
  const item = pending.get(documentId) || { document, first: now, last: now, timer: null, saving: false }
  item.document = document
  item.last = now
  if (item.timer) clearTimeout(item.timer)
  const due = Math.min(item.last + 30_000, item.first + 60_000)
  item.timer = setTimeout(() => void checkpoint(documentId), Math.max(0, due - now))
  pending.set(documentId, item)
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

async function checkpoint(documentId: string) {
  const item = pending.get(documentId)
  if (!item || item.saving) return
  item.saving = true
  if (item.timer) clearTimeout(item.timer)
  item.timer = null
  try {
    const selected = room(documentId)
    const projection = await currentProjection(selected.documentId)
    const json = TiptapTransformer.fromYdoc(item.document, 'default')
    const blocks = jsonToSnapshot(json)
    const response = await request(selected.documentId, '/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: projection.revision, blocks }),
    }, selected.epoch)
    if (response.status === 409) {
      pending.delete(documentId)
      server.hocuspocus.closeConnections(documentId)
      return
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
    item.first = Date.now()
    console.log(`HCD checkpoint ${documentId} revision ${saved.revision}`)
  } catch (error) {
    console.error(error)
    item.timer = setTimeout(() => void checkpoint(documentId), 5000)
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
    const access = await response.json() as { scope: string; collaborationEpoch: number }
    if (access.collaborationEpoch !== selected.epoch) throw new Error('Stale HCD collaboration room')
    connectionConfig.readOnly = access.scope !== 'write'
    return { scope: access.scope }
  },
  async onTokenSync({ documentName, token, connection }) {
    const selected = room(documentName)
    const response = await fetch(`${api}/v1/documents/${encodeURIComponent(selected.documentId)}/auth`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error('Expired HCD collaboration token')
    const access = await response.json() as { scope: string; collaborationEpoch: number }
    if (access.collaborationEpoch !== selected.epoch) throw new Error('Stale HCD collaboration room')
    connection.readOnly = access.scope !== 'write'
  },
  async onLoadDocument({ documentName }) {
    const selected = room(documentName)
    const response = await request(selected.documentId, '/collaboration/state', {}, selected.epoch)
    if (response.ok) return new Uint8Array(await response.arrayBuffer())
    if (response.status !== 404) throw new Error(`HCD collaboration load failed: ${await response.text()}`)
    const projection = await currentProjection(selected.documentId)
    return TiptapTransformer.toYdoc(projectionToJson(projection), 'default', schemaExtensions)
  },
  async onStoreDocument({ documentName, document }) {
    const selected = room(documentName)
    const response = await request(selected.documentId, '/collaboration/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(Y.encodeStateAsUpdate(document)),
    }, selected.epoch)
    if (!response.ok) throw new Error(`HCD collaboration persistence failed: ${response.status} ${await response.text()}`)
  },
  async onChange({ documentName, document }) {
    schedule(documentName, document)
  },
})

server.listen()
