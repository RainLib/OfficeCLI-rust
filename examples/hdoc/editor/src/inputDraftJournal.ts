/** Uncommitted form input is separate from the semantic Yjs update log. Each
 * editor owns a stream, so closing one window cannot acknowledge another. */
export type InputDraft = {
  id: string; namespace: string; documentId: string; epoch: number
  version: number; updatedAt: number; content: string
}
const databaseName = 'hcd-input-drafts-v1'
const maxBytes = 2 * 1024 * 1024
let database: Promise<IDBDatabase> | undefined

function openDatabase() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'id' }).createIndex('namespace', 'namespace')
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); database = undefined }
      resolve(db)
    }
    request.onerror = () => { database = undefined; reject(request.error) }
    request.onblocked = () => { database = undefined; reject(new Error('本地草稿数据库被占用')) }
  })
  return database
}
function transaction(db: IDBDatabase) {
  try { return db.transaction('drafts', 'readwrite', { durability: 'strict' }) }
  catch { return db.transaction('drafts', 'readwrite') }
}
function complete(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('本地草稿写入失败'))
  })
}
const lockName = (id: string) => `hcd-input-draft:${id}`
async function inactive<T>(id: string, callback: () => Promise<T>): Promise<T | undefined> {
  if (!navigator.locks) return callback()
  return navigator.locks.request(lockName(id), { ifAvailable: true }, lock => lock ? callback() : undefined)
}
async function hold(id: string): Promise<() => void> {
  if (!navigator.locks) return () => {}
  return new Promise((resolve, reject) => {
    void navigator.locks.request(lockName(id), () => new Promise<void>(release => resolve(release))).catch(reject)
  })
}

export async function readInputDrafts(namespace: string): Promise<InputDraft[]> {
  const db = await openDatabase()
  const drafts = await new Promise<InputDraft[]>((resolve, reject) => {
    const request = db.transaction('drafts').objectStore('drafts').index('namespace').getAll(namespace)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const available: InputDraft[] = []
  for (const draft of drafts) await inactive(draft.id, async () => { available.push(draft) })
  return available.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function discardInputDraft(draft: InputDraft) {
  const deleted = await inactive(draft.id, async () => {
    const db = await openDatabase(), tx = transaction(db), saved = complete(tx)
    const store = tx.objectStore('drafts'), read = store.get(draft.id)
    read.onsuccess = () => {
      const current = read.result as InputDraft | undefined
      // A delayed response cannot erase input written since the recovery read.
      if (current && (current.namespace !== draft.namespace || current.version !== draft.version || current.content !== draft.content)) { tx.abort(); return }
      store.delete(draft.id)
    }
    await saved
    return true
  })
  if (!deleted) throw new Error('这份草稿仍在另一个窗口编辑，请稍后重试')
}

export class InputDraftJournal {
  private queue = Promise.resolve()
  private failed: unknown
  private closed = false
  private version = 0
  pending = 0
  private constructor(private readonly identity: Pick<InputDraft, 'id' | 'namespace' | 'documentId' | 'epoch'>, private readonly release: () => void, private readonly changed: (error?: unknown) => void, private readonly maximumBytes: number) {}
  static async create(namespace: string, documentId: string, epoch: number, changed: (error?: unknown) => void, maximumBytes = maxBytes) {
    await openDatabase()
    const id = crypto.randomUUID(), release = await hold(id)
    return new InputDraftJournal({ id, namespace, documentId, epoch }, release, changed, maximumBytes)
  }
  replace(content: string | null) {
    if (this.closed) return
    const version = ++this.version
    this.pending++
    this.changed()
    this.queue = this.queue.then(async () => {
      if (this.failed) return
      if (content !== null && new TextEncoder().encode(content).length > this.maximumBytes) throw new Error(`未提交输入超过 ${this.maximumBytes / 1024 / 1024} MiB`)
      const db = await openDatabase(), tx = transaction(db), saved = complete(tx)
      const store = tx.objectStore('drafts')
      if (content === null) store.delete(this.identity.id)
      else {
        const read = store.get(this.identity.id)
        read.onsuccess = () => {
          const count = store.index('namespace').count(this.identity.namespace)
          count.onsuccess = () => {
            try {
              if (!read.result && count.result >= 128) { tx.abort(); return }
              store.put({ ...this.identity, version, content, updatedAt: Date.now() } satisfies InputDraft)
            } catch { tx.abort() }
          }
        }
      }
      await saved
    }).catch(error => { this.failed = error }).finally(() => { this.pending--; this.changed(this.failed) })
  }
  async flush() { await this.queue; if (this.failed) throw this.failed }
  dispose() { this.closed = true; void this.queue.finally(this.release) }
}
