import * as Y from 'yjs'

const DATABASE = 'hcd-editor-drafts-v1'
const MAX_STREAM_BYTES = 32 * 1024 * 1024
export const DRAFT_RESTORE_ORIGIN = 'hcd-local-draft-restore'

export type DraftStream = {
  id: string; namespace: string; documentId: string; epoch: number; generation: string;
  baseline: ArrayBuffer; dirty: boolean; byteLength: number;
  createdAt: number; updatedAt: number; lastUpdateKey?: number;
}
type DraftUpdate = { key?: number; streamId: string; update: ArrayBuffer }
export type RecoverableDraft = { stream: DraftStream; updates: Uint8Array[]; recoveryError?: string }

let database: Promise<IDBDatabase> | undefined
function openDatabase(): Promise<IDBDatabase> {
  if (database) return database
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('streams', { keyPath: 'id' }).createIndex('namespace', 'namespace')
      db.createObjectStore('updates', { keyPath: 'key', autoIncrement: true }).createIndex('streamId', 'streamId')
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); database = undefined }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('草稿存储正被其他窗口占用'))
  })
  database = pending
  void pending.catch(() => { if (database === pending) database = undefined })
  return pending
}
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('草稿存储失败'))
  })
}
function writeTransaction(db: IDBDatabase, stores: string[]) {
  return db.transaction(stores, 'readwrite', { durability: 'strict' })
}

// A live writer holds its own stream lock until it has detached and flushed.
// Browser process death releases the lock too. Maintenance can therefore prune
// clean abandoned baselines without invalidating a quiet, still-open editor.
const lockName = (id: string) => `hcd-draft-stream:${id}`
async function holdStream(id: string): Promise<() => void> {
  if (!navigator.locks) return () => {}
  return new Promise((resolve, reject) => {
    void navigator.locks.request(lockName(id), () => new Promise<void>(release => resolve(release))).catch(reject)
  })
}

async function removeCleanStream(db: IDBDatabase, id: string) {
  const tx = writeTransaction(db, ['streams', 'updates'])
  const saved = complete(tx)
  const streams = tx.objectStore('streams')
  const read = streams.get(id)
  read.onsuccess = () => {
    if (!read.result || (read.result as DraftStream).dirty) return
    streams.delete(id)
    const updates = tx.objectStore('updates').index('streamId').openCursor(id)
    updates.onsuccess = () => { const cursor = updates.result; if (cursor) { cursor.delete(); cursor.continue() } }
  }
  await saved
}

async function pruneCleanStreams(db: IDBDatabase, streams: DraftStream[]) {
  // Without Web Locks we retain clean records; their number never disables
  // recovery. Concurrent writers are more important than reclaiming storage.
  if (!navigator.locks) return
  for (const stream of streams.filter(stream => !stream.dirty)) {
    await navigator.locks.request(lockName(stream.id), { ifAvailable: true }, async lock => {
      if (lock) await removeCleanStream(db, stream.id)
    })
  }
}

/** The namespace contains a hash of the API endpoint and authenticated user;
 * credentials are never written to the content journal. A legacy anonymous
 * token is isolated by its hash instead of trusting a browser-generated user. */
export async function draftNamespace(apiBase: string, userId: string | undefined, token: string, documentId: string, serviceId: string): Promise<string> {
  const identity = JSON.stringify([new URL(apiBase || '/v1/documents', location.href).href, serviceId, userId || `token:${token}`, documentId])
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function readDrafts(namespace: string): Promise<RecoverableDraft[]> {
  const db = await openDatabase()
  const streams = await requestValue<DraftStream[]>(db.transaction('streams').objectStore('streams').index('namespace').getAll(namespace))
  const dirty = streams.filter(stream => stream.dirty)
  if (dirty.length > 128) throw new Error('本地草稿数量过多，请先导出保留的草稿')
  await pruneCleanStreams(db, streams)
  const tx = db.transaction('updates')
  return Promise.all(dirty.map(async stream => {
    const updates = await requestValue<DraftUpdate[]>(tx.objectStore('updates').index('streamId').getAll(stream.id))
    return { stream, updates: [new Uint8Array(stream.baseline), ...updates
      .filter(update => (update.key ?? 0) <= (stream.lastUpdateKey ?? 0))
      .map(update => new Uint8Array(update.update))] }
  }))
}

export function restoreDraft(document: Y.Doc, draft: RecoverableDraft) {
  if (draft.stream.generation !== document.getMap('hcd-room').get('generation')) throw new Error('协同房间已变化，草稿需要单独核对')
  const merged = Y.mergeUpdates(draft.updates)
  const preview = new Y.Doc()
  try {
    Y.applyUpdate(preview, Y.encodeStateAsUpdate(document))
    Y.applyUpdate(preview, merged)
    if (preview.getMap('hcd-room').get('generation') !== draft.stream.generation) throw new Error('草稿协同身份不一致')
  } finally { preview.destroy() }
  Y.applyUpdate(document, merged, DRAFT_RESTORE_ORIGIN)
}

/** One baseline per room entry, followed by incremental CRDT updates. We do
 * not encode/rewrite the complete document on each keystroke. Transactions
 * commit the update and its dirty marker together before reporting protection. */
export class DraftJournal {
  private queue = Promise.resolve()
  private failed: unknown
  private disposed = false
  localVersion = 0
  pending = 0
  constructor(readonly stream: DraftStream, private readonly recovered: RecoverableDraft[], private readonly changed: (error?: unknown) => void, private readonly release: () => void) {}

  static async create(namespace: string, documentId: string, epoch: number, document: Y.Doc, recovered: RecoverableDraft[], changed: (error?: unknown) => void, localChanges = false) {
    const baseline = Uint8Array.from(Y.encodeStateAsUpdate(document)).buffer
    if (baseline.byteLength > MAX_STREAM_BYTES) throw new Error('本地草稿超过 32 MiB')
    const generation = document.getMap('hcd-room').get('generation')
    if (typeof generation !== 'string' || !generation) throw new Error('服务尚未提供持久协同身份')
    const now = Date.now()
    const stream: DraftStream = { id: crypto.randomUUID(), namespace, documentId, epoch, generation,
      baseline, dirty: recovered.length > 0 || localChanges, byteLength: baseline.byteLength, createdAt: now, updatedAt: now }
    const release = await holdStream(stream.id)
    try {
      const db = await openDatabase()
      const tx = writeTransaction(db, ['streams'])
      const saved = complete(tx)
      tx.objectStore('streams').put(stream)
      await saved
    } catch (error) { release(); throw error }
    const journal = new DraftJournal(stream, recovered, changed, release)
    if (recovered.length || localChanges) journal.localVersion++
    return journal
  }

  append(update: Uint8Array, local: boolean) {
    if (this.disposed) return
    if (local) this.localVersion++
    if (this.failed) { this.changed(this.failed); return }
    const bytes = Uint8Array.from(update).buffer
    this.pending++
    if (local) this.changed()
    this.queue = this.queue.then(async () => {
      if (this.failed) return
      const db = await openDatabase()
      const tx = writeTransaction(db, ['streams', 'updates'])
      const saved = complete(tx)
      const streams = tx.objectStore('streams')
      const read = streams.get(this.stream.id)
      read.onsuccess = () => {
        try {
          const stream = read.result as DraftStream | undefined
          if (!stream || stream.byteLength + bytes.byteLength > MAX_STREAM_BYTES) { tx.abort(); return }
          const added = tx.objectStore('updates').add({ streamId: stream.id, update: bytes } satisfies DraftUpdate)
          added.onsuccess = () => {
            stream.lastUpdateKey = Number(added.result)
            stream.byteLength += bytes.byteLength
            stream.updatedAt = Date.now()
            stream.dirty ||= local
            streams.put(stream)
          }
        } catch { tx.abort() }
      }
      await saved
    }).catch(error => { this.failed = error; this.changed(error) }).finally(() => { this.pending--; this.changed(this.failed) })
  }

  acknowledge(version: number) {
    if (this.disposed) return
    this.queue = this.queue.then(async () => {
      if (this.failed || this.localVersion !== version) return
      const db = await openDatabase()
      const tx = writeTransaction(db, ['streams', 'updates'])
      const saved = complete(tx)
      const store = tx.objectStore('streams')
      for (const candidate of [this.stream, ...this.recovered.map(draft => draft.stream)]) {
        const read = store.get(candidate.id)
        read.onsuccess = () => {
          const stream = read.result as DraftStream | undefined
          // Another open browser may still append to a recovered stream.
          // Never acknowledge the writes that arrived after our recovery read.
          if (!stream || this.localVersion !== version || candidate.id !== this.stream.id && stream.lastUpdateKey !== candidate.lastUpdateKey) return
          if (candidate.id === this.stream.id) {
            const updates = tx.objectStore('updates').index('streamId').getAll(stream.id)
            updates.onsuccess = () => {
              try {
                const records = updates.result as DraftUpdate[]
                stream.baseline = Uint8Array.from(Y.mergeUpdates([new Uint8Array(stream.baseline), ...records.map(update => new Uint8Array(update.update))])).buffer
                stream.byteLength = stream.baseline.byteLength
                stream.lastUpdateKey = undefined
                stream.dirty = false
                store.put(stream)
                for (const record of records) tx.objectStore('updates').delete(record.key!)
              } catch { tx.abort() }
            }
          } else {
            stream.dirty = false
            store.put(stream)
          }
        }
      }
      await saved
    }).catch(error => { this.failed = error; this.changed(error) })
  }

  async flush() { await this.queue; if (this.failed) throw this.failed }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    void this.queue.then(async () => {
      // A failed append must never turn the last protected draft into a clean
      // record. Only canonical, acknowledged content is eligible for removal.
      if (!this.failed) await removeCleanStream(await openDatabase(), this.stream.id)
    }).catch(() => {}).finally(this.release)
  }
}

export async function discardDraft(draft: RecoverableDraft) {
  const db = await openDatabase()
  const tx = writeTransaction(db, ['streams'])
  const saved = complete(tx)
  const read = tx.objectStore('streams').get(draft.stream.id)
  read.onsuccess = () => {
    const stream = read.result as DraftStream | undefined
    if (!stream || stream.lastUpdateKey !== draft.stream.lastUpdateKey) { tx.abort(); return }
    stream.dirty = false
    tx.objectStore('streams').put(stream)
  }
  await saved
}
