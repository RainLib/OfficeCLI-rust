import { api, ApiResponseError, type Session } from '../api.ts'
import { InputDraftJournal, readInputDrafts, discardInputDraft, type InputDraft } from '../inputDraftJournal.ts'
import { applyOperations, combineOperations, withoutSpecMeasurements } from './changes.ts'
import { CANVAS_PROTOCOL, type Batch, type CanvasEvent, type CanvasScene, type Operation, type Snapshot } from './model.ts'
import { receiveEvents } from './transport.ts'

export type CanvasConnectionState = {
  snapshot: Snapshot | null; scene: CanvasScene | null; status: string; error: string
  connected: boolean; pending: boolean; recovery: InputDraft[]; ready: boolean
}

/** Owns network ordering and draft durability independently from the renderer.
 * A failed batch keeps its ID and preconditions, so retry cannot overwrite a
 * peer or duplicate a write whose acknowledgement was lost. */
export class CanvasConnection {
  readonly clientId = crypto.randomUUID()
  private abort = new AbortController()
  private reconnect?: ReturnType<typeof setTimeout>
  private specTimer?: ReturnType<typeof setTimeout>
  private timer?: ReturnType<typeof setTimeout>
  private journal?: InputDraftJournal
  private namespace = ''
  private pending: Operation[] = []
  private flight: Batch | null = null
  private acknowledged = false
  private sending: Promise<number> | null = null
  private lastPresence = 0
  private cursor: CanvasEvent['specCursor'] = null
  private cursorSeq = 0
  private cursorTimer?: ReturnType<typeof setTimeout>
  setSpecCursor(cursor: CanvasEvent['specCursor']) {
    if (JSON.stringify(this.cursor) === JSON.stringify(cursor)) return
    this.cursor = cursor
    this.cursorSeq++
    if (!this.cursorTimer) this.cursorTimer=setTimeout(()=>{
      this.cursorTimer=undefined
      this.sendPresence({ specSeq:this.cursorSeq })
    },35)
  }
  private stopped = false
  private paused = false
  private recovering = false
  state: CanvasConnectionState = { snapshot: null, scene: null, status: '正在连接', error: '', connected: false, pending: false, recovery: [], ready: false }
  constructor(private session: () => Session, private changed: (state: CanvasConnectionState) => void, private presence: (event: CanvasEvent) => void) {}
  private notify(patch: Partial<CanvasConnectionState> = {}) {
    this.state = { ...this.state, ...patch, pending: this.pending.length > 0 || this.flight !== null }
    if (!this.stopped) this.changed(this.state)
  }
  optimistic() {
    const scene = this.state.snapshot?.scene
    return scene ? applyOperations(applyOperations(scene, this.flight && !this.acknowledged ? this.flight.operations : []), this.pending) : null
  }
  async start() {
    try {
      const auth = await (await api(this.session(), '/auth', { signal: this.abort.signal })).json() as { serviceId: string; collaborationEpoch: number }
      const namespace = JSON.stringify(['canvas/1', auth.serviceId, this.session().apiUrl || location.origin, this.session().documentId, this.session().userId])
      this.namespace = namespace
      this.journal = await this.newJournal(auth.collaborationEpoch)
      if (this.stopped) { this.journal.dispose(); return }
      const recovery = await readInputDrafts(namespace)
      await this.refresh()
      this.notify({ ready: true, recovery, status: '已保存' })
      void this.connect()
    } catch (error) { if (!this.stopped) this.notify({ error: String(error), status: '连接失败' }) }
  }
  async refresh() {
    const snapshot = await (await api(this.session(), '/canvas', { signal: this.abort.signal, cache: 'no-store' })).json() as Snapshot
    if (snapshot.schemaVersion !== CANVAS_PROTOCOL) throw new Error('画布服务协议不兼容')
    if (this.state.snapshot && snapshot.revision < this.state.snapshot.revision) return
    if (this.state.snapshot && snapshot.collaborationEpoch !== this.state.snapshot.collaborationEpoch && this.state.pending) {
      this.paused = true
      this.notify({ error: '文档已恢复到另一个版本，草稿已保留。请下载草稿，或读取当前协作版本。' })
    } else if (this.state.snapshot && snapshot.collaborationEpoch !== this.state.snapshot.collaborationEpoch) {
      await this.journal?.flush(); this.journal?.dispose()
      this.journal = await this.newJournal(snapshot.collaborationEpoch)
    }
    this.state = { ...this.state, snapshot }
    this.notify({ scene: this.optimistic() })
  }
  private async connect() {
    if (this.stopped) return
    try {
      await receiveEvents(this.session(), this.abort.signal, event => {
        if (event.type === 'presence' || event.type === 'reactions') { if (event.clientId !== this.clientId) this.presence(event); return }
        if (event.type === 'commit') {
          const current = this.state.snapshot
          if (event.rewriteOwner || event.undoRevision) this.presence(event)
          if (!current || (event.revision ?? -1) <= current.revision) return
          if (event.revision !== current.revision + 1) { void this.refresh().catch(error => this.notify({ error: String(error) })); return }
          const removed = new Set(event.removedIds || []), incoming = new Map((event.elements || []).map(element => [element.id, element]))
          const elements = current.scene.elements.filter(element => !removed.has(element.id)).map(element => { const next = incoming.get(element.id); incoming.delete(element.id); return next || element })
          elements.push(...incoming.values())
          const scene: CanvasScene = { ...current.scene, elements, files: { ...current.scene.files, ...event.files }, appState: event.appState || current.scene.appState }
          if (event.patchId === this.flight?.patchId) this.acknowledged = true
          this.state = { ...this.state, snapshot: { ...current, revision: event.revision!, scene } }
          this.notify({ scene: this.optimistic() })
          if (!event.rewriteOwner && !event.undoRevision) this.presence(event)
          return
        }
        if (event.type === 'heartbeat') {
          if (event.revision !== this.state.snapshot?.revision || event.collaborationEpoch !== this.state.snapshot?.collaborationEpoch) void this.refresh().catch(error => this.notify({ error: String(error) }))
          return
        }
        this.notify({ connected: true })
        void this.refresh().catch(error => this.notify({ error: String(error) }))
      })
    } catch { /* A reconnect reads a fresh snapshot; queued local operations stay intact. */ }
    if (!this.stopped) { this.notify({ connected: false }); this.reconnect = setTimeout(() => void this.connect(), 1500) }
  }
  enqueue(operations: Operation[]) {
    if (!operations.length || !this.state.ready || this.session().scope !== 'write') return
    this.pending = combineOperations(this.pending, operations)
    this.protect()
    if(operations.some(op=>op.op==='spec.update')){
      this.notify({status:'有未保存修改',scene:this.optimistic()})
      this.specTimer??=setTimeout(()=>{this.specTimer=undefined;if(!this.paused)void this.flush().catch(()=>{})},140)
      return
    }
    this.notify({ status: '有未保存修改' })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { if (!this.paused) void this.flush().catch(() => {}) }, 650)
  }
  private protect() {
    this.journal?.replace(this.flight || this.pending.length ? JSON.stringify({ flight: this.flight, pending: this.pending }) : null)
  }
  private newJournal(epoch: number) {
    return InputDraftJournal.create(this.namespace, this.session().documentId, epoch, error => { if (error) this.notify({ error: `本地草稿保护失败：${String(error)}` }) }, 32 * 1024 * 1024)
  }
  async append(batch: Batch, epoch: number) {
    await this.flush()
    if (this.session().scope !== 'write' || !this.state.ready) throw new Error('画布暂不可编辑。')
    if (batch.documentId !== this.session().documentId || !batch.vacantRegions?.length || batch.operations.some(op => op.op !== 'element.add')) throw new Error('追加内容必须包含空位检查。')
    if (epoch !== this.state.snapshot?.collaborationEpoch) throw new Error('画布已恢复到其他版本，请重新排版。')
    this.flight = batch; this.acknowledged = false
    this.protect()
    this.notify({ scene: this.optimistic(), status: '正在追加内容' })
    return this.flush()
  }
  async flush(): Promise<number> {
    clearTimeout(this.specTimer);this.specTimer=undefined
    clearTimeout(this.timer)
    if (this.sending) { await this.sending; return this.flush() }
    if (!this.state.snapshot) throw new Error('画布尚未加载')
    if (this.paused) throw new Error(this.state.error || '请先处理保存冲突')
    if (!this.flight && !this.pending.length) return this.state.snapshot.revision
    if (!this.flight) {
      this.flight = { schemaVersion: CANVAS_PROTOCOL, documentId: this.session().documentId, patchId: crypto.randomUUID(), baseRevision: this.state.snapshot.revision, operations: this.pending }
      this.pending = []; this.acknowledged = false
    }
    const batch = this.flight
    const epoch = this.state.snapshot.collaborationEpoch
    this.protect()
    this.notify({ status: '正在保存', error: '' })
    this.sending = (async () => {
      await this.journal?.flush()
      const post = async (value: Batch) => {
        const response = await api(this.session(), '/canvas/patch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(epoch) }, body: JSON.stringify(value) })
        return (await response.json() as { revision: number }).revision
      }
      let revision: number
      try {
        revision = await post(batch)
      } catch (error) {
        if (!(error instanceof ApiResponseError && error.status === 412 && error.message.includes('field height changed'))) throw error
        await this.refresh()
        const snapshot = this.state.snapshot!
        if (this.paused || snapshot.collaborationEpoch !== epoch) throw error
        const operations = withoutSpecMeasurements(batch.operations, snapshot.scene)
        if (!operations) throw error
        revision = snapshot.revision
        if (operations.length) {
          // The server atomically rejected the first payload. Journal the
          // replacement before sending it so retries retain receipt identity.
          this.flight = { ...batch, operations, patchId: crypto.randomUUID() }
          this.protect()
          await this.journal?.flush()
          revision = await post(this.flight)
        }
      }
      // Stop overlaying the batch before reading its authoritative result.
      this.acknowledged = true
      await this.refresh()
      this.flight = null; this.acknowledged = false
      this.protect(); await this.journal?.flush()
      this.notify({ scene: this.optimistic(), status: this.pending.length ? '有未保存修改' : '已保存' })
      return revision
    })().catch(error => { this.paused = true; this.notify({ status: '草稿已保留', error: String(error) }); throw error }).finally(() => { this.sending = null })
    const revision = await this.sending
    return this.pending.length ? this.flush() : revision
  }
  async retry() { this.paused = false; return this.flush() }
  async discard() {
    if (this.sending) throw new Error('请等待正在提交的修改')
    this.pending = []; this.flight = null; this.acknowledged = false; this.paused = false
    this.protect(); await this.journal?.flush(); await this.refresh()
    this.notify({ error: '', status: '已保存' })
  }
  async recover(draft: InputDraft) {
    if (this.recovering || this.state.pending || this.sending) return
    this.recovering = true
    try {
      if (draft.epoch !== this.state.snapshot?.collaborationEpoch) throw new Error('这份草稿属于恢复前的版本，不能自动提交。')
      const value = JSON.parse(draft.content) as { flight: Batch | null; pending: Operation[] }
      this.flight = value.flight; this.pending = value.pending; this.acknowledged = false
      this.protect(); await this.journal?.flush(); await discardInputDraft(draft)
      this.notify({ scene: this.optimistic(), recovery: this.state.recovery.filter(item => item.id !== draft.id) })
      await this.retry()
    } finally { this.recovering = false }
  }
  sendPresence(value: Omit<CanvasEvent, 'type'>) {
    if ((!value.emote && !value.chat && value.specSeq == null && Date.now() - this.lastPresence < 80) || !this.state.snapshot) return
    this.lastPresence = Date.now()
    void api(this.session(), '/canvas/presence', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(this.state.snapshot.collaborationEpoch) }, body: JSON.stringify({ ...value, ...(this.cursorSeq && {specCursor:this.cursor,specSeq:this.cursorSeq}), clientId: this.clientId }) }).catch(() => {})
  }
  dispose() {
    clearTimeout(this.cursorTimer)
    if (this.cursor) { this.cursor=null; this.sendPresence({specSeq:++this.cursorSeq}) } this.stopped = true; this.abort.abort(); clearTimeout(this.specTimer); clearTimeout(this.reconnect); clearTimeout(this.timer); this.protect(); this.journal?.dispose() }
}
