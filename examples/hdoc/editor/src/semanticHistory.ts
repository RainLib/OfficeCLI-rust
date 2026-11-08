import * as Y from 'yjs'
import {defaultDeleteFilter,defaultProtectedNodes,ySyncPluginKey} from '@tiptap/y-tiptap'
import type { DraftAction } from './draftActions.ts'
import type { CollaborativeImageDraftStore } from './collaborativeImages.ts'
import { validGeometry, type ImageField, type ImageDraft, type PositionedImage } from './imageDrafts.ts'

type TextStep = { kind: 'text'; item: Y.UndoManager['undoStack'][number] }
type ImageStep = { kind: 'image'; action: 'edit' | 'replace' | 'choose'; before: PositionedImage; after: PositionedImage; fields: ImageField[]; revision: number; page?: number }
type Step = TextStep | ImageStep
export type HistoryImageReader = (id: string, signal: AbortSignal) => Promise<{ revision: number; image: PositionedImage | null }>
const fields: ImageField[] = ['x', 'y', 'width', 'height', 'assetHash']
const value = (image: PositionedImage, field: ImageField) => field === 'assetHash' ? image.assetHash ?? null : image.geometry[field]
const clean = (image: PositionedImage): PositionedImage => ({ nodeId: image.nodeId, visualHash: image.visualHash, ...(image.assetHash ? { assetHash: image.assetHash } : {}), geometry: { ...image.geometry } })
const changedFields = (before: PositionedImage, after: PositionedImage) => fields.filter(field => !Object.is(value(before, field), value(after, field)))

/** Match the installed collaboration plugin's protection and history flags. */
export function semanticUndoManager(document:Y.Doc){
  return new Y.UndoManager(document.getXmlFragment('default'),{
    trackedOrigins:new Set([ySyncPluginKey]),
    deleteFilter:item=>defaultDeleteFilter(item,defaultProtectedNodes),
    captureTransaction:transaction=>transaction.meta.get('addToHistory')!==false,
  })
}

/** A window's own chronological actions. Text keeps CRDT identities; image
 * inverses use an authenticated current object and never undo the shared map. */
export class SemanticHistory {
  private undoStack: Step[] = []
  private redoStack: Step[] = []
  private version = 0
  private listeners = new Set<() => void>()
  private working = false
  private movingText = false
  private closed = true
  private abort = new AbortController()
  private lastImage = 0
  private detach: Array<() => void> = []
  constructor(private images: CollaborativeImageDraftStore, readonly undoManager: Y.UndoManager, private blocked: () => boolean, private readImage: HistoryImageReader, private now = () => Date.now(),private captureAllowed=()=>true) {}
  connect() {
    if (!this.closed) throw new Error('History already connected')
    this.closed = false; this.abort = new AbortController()
    const onStack = (event: { type: string; stackItem: TextStep['item'] }) => {
      if (this.closed || this.movingText || event.type !== 'undo') return
      if(!this.captureAllowed()){
        if(!this.undoStack.some(step=>step.kind==='text'&&step.item===event.stackItem)){const index=this.undoManager.undoStack.indexOf(event.stackItem);if(index>=0)this.undoManager.undoStack.splice(index,1)}
        return
      }
      this.redoStack = []
      if (this.undoStack.at(-1)?.kind !== 'text' || (this.undoStack.at(-1) as TextStep).item !== event.stackItem) this.undoStack.push({ kind: 'text', item: event.stackItem })
      this.trim(); this.lastImage = 0; this.changed()
    }
    const onClear = (event: { undoStackCleared: boolean; redoStackCleared: boolean }) => {
      if(this.movingText)return
      if (event.undoStackCleared) this.undoStack = this.undoStack.filter(step => step.kind !== 'text')
      if (event.redoStackCleared) this.redoStack = this.redoStack.filter(step => step.kind !== 'text')
      this.changed()
    }
    this.undoManager.on('stack-item-added', onStack)
    this.undoManager.on('stack-item-updated', onStack)
    this.undoManager.on('stack-cleared', onClear)
    this.detach = [
      () => this.undoManager.off('stack-item-added', onStack),
      () => this.undoManager.off('stack-item-updated', onStack),
      () => this.undoManager.off('stack-cleared', onClear),
      this.images.actions.subscribe(action => this.recordImage(action)),
      this.images.subscribe(() => this.changed()),
    ]
    this.changed()
    return () => this.dispose()
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.version
  private changed() { this.version++; this.listeners.forEach(listener => listener()) }
  private trim() { while (this.undoStack.length > 200) this.undoStack.shift() }
  get busy() { return this.working }
  get canUndo() { return !this.closed && this.undoStack.length > 0 && !this.working && !this.blocked() }
  get canRedo() { return !this.closed && this.redoStack.length > 0 && !this.working && !this.blocked() }
  stopCapturing() { this.lastImage = 0; this.undoManager.stopCapturing() }
  private recordImage(action: DraftAction<PositionedImage,ImageDraft>) {
    if (this.closed) return
    this.undoManager.stopCapturing()
    if (action.kind === 'reset') {
      const keep = (step: Step) => step.kind !== 'image' || step.after.nodeId !== action.after.nodeId
      this.undoStack = this.undoStack.filter(keep); this.redoStack = this.redoStack.filter(keep)
      this.stopCapturing(); this.changed(); return
    }
    const changed = changedFields(action.before, action.after)
    if (!changed.length) return
    const step: ImageStep = { kind: 'image', action: action.kind, before: clean(action.before), after: clean(action.after), fields: changed, revision: action.revision, ...(action.page !== undefined ? { page: action.page } : {}) }
    const previous = this.undoStack.at(-1), at = this.now()
    const continuous = previous?.kind === 'image' && step.action === 'edit' && previous.action === 'edit' && previous.after.nodeId === step.after.nodeId && previous.fields.join() === step.fields.join() && this.lastImage > 0 && at - this.lastImage < 750 && !changedFields(previous.after, step.before).length
    if (continuous) this.undoStack[this.undoStack.length - 1] = { ...previous, after: step.after, fields: changedFields(previous.before, step.after) }
    else this.undoStack.push(step)
    const latest = this.undoStack.at(-1)
    if (latest?.kind === 'image' && !latest.fields.length) this.undoStack.pop()
    this.redoStack = []
    this.undoManager.clear(false, true)
    this.lastImage = at; this.trim(); this.changed()
  }
  skip(direction: 'undo' | 'redo', expectedVersion: number) {
    if (this.closed || this.working || this.blocked()) throw new Error('historyBusy')
    if (expectedVersion !== this.version) throw new Error('historyChanged')
    const stack = direction === 'undo' ? this.undoStack : this.redoStack
    const action=stack.at(-1)
    if(!action)throw new Error('historyInvalid')
    if(action.kind==='text'){
      const raw=direction==='undo'?this.undoManager.undoStack:this.undoManager.redoStack
      if(raw.at(-1)!==action.item)throw new Error('historyInvalid')
      const older=raw.splice(0,raw.length-1);this.movingText=true
      try{this.undoManager.clear(direction==='undo',direction==='redo')}finally{(direction==='undo'?this.undoManager.undoStack:this.undoManager.redoStack).unshift(...older);this.movingText=false}
    }
    stack.pop(); this.stopCapturing(); this.changed()
  }
  async step(direction: 'undo' | 'redo') {
    if (this.closed || this.working || this.blocked()) throw new Error('historyBusy')
    const from = direction === 'undo' ? this.undoStack : this.redoStack, to = direction === 'undo' ? this.redoStack : this.undoStack
    const action = from.at(-1)
    if (!action) throw new Error('historyEmpty')
    this.working = true; this.stopCapturing(); this.changed()
    try {
      if (action.kind === 'text') {
        const stack = direction === 'undo' ? this.undoManager.undoStack : this.undoManager.redoStack
        if (stack.at(-1) !== action.item) throw new Error('historyInvalid')
        // Yjs skips invisible items when a peer already deleted their content.
        // Isolate this one action so that skip cannot cross an image action.
        const older = stack.splice(0, stack.length - 1)
        this.movingText = true
        let moved: TextStep['item'] | null
        try { moved = direction === 'undo' ? this.undoManager.undo() : this.undoManager.redo() }
        finally { stack.unshift(...older); this.movingText = false }
        from.pop()
        if (moved) {
          const opposite = direction === 'undo' ? this.undoManager.redoStack : this.undoManager.undoStack
          to.push({ kind: 'text', item: opposite.at(-1)! })
        }
      } else {
        const imageVersion = this.images.snapshot(), historyVersion = this.version, owner = this.abort
        const result = await this.readImage(action.after.nodeId, AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)]))
        if (this.closed || owner !== this.abort || this.blocked()) throw new Error('historyBusy')
        if (imageVersion !== this.images.snapshot() || historyVersion !== this.version) throw new Error('historyChanged')
        const current = result.image
        if (!current) throw new Error('historyDeleted')
        if (!Number.isSafeInteger(result.revision) || result.revision < action.revision || current.nodeId !== action.after.nodeId || !/^[a-f0-9]{64}$/.test(current.visualHash) || !validGeometry(current.geometry)) throw new Error('historyInvalid')
        const draft = this.images.get(current.nodeId)
        if (draft?.collaborationConflict || draft?.remote) throw new Error('historyConflict')
        const expected = direction === 'undo' ? action.after : action.before, desired = direction === 'undo' ? action.before : action.after
        if (current.geometry.unit !== desired.geometry.unit) throw new Error('historyConflict')
        const visible = draft ? { ...current, geometry: { ...current.geometry }, assetHash: current.assetHash } : clean(current)
        if (draft) {
          for (const field of (draft.touched ?? changedFields(draft.base, { ...draft.base, geometry: draft.geometry, assetHash: draft.assetHash ?? draft.base.assetHash }))) {
            const wanted = field === 'assetHash' ? draft.assetHash ?? draft.base.assetHash : draft.geometry[field]
            if (!Object.is(value(current, field), value(draft.base, field)) && !Object.is(value(current, field), wanted)) throw new Error('historyConflict')
            if (field === 'assetHash') visible.assetHash = wanted as string | undefined
            else visible.geometry[field] = wanted as number
          }
        }
        const next = clean(visible)
        for (const field of action.fields) {
          if (!Object.is(value(visible, field), value(expected, field))) throw new Error('historyConflict')
          if (field === 'assetHash') next.assetHash = desired.assetHash
          else next.geometry[field] = desired.geometry[field]
        }
        this.images.applyHistory(current, result.revision, next, action.page, action.fields)
        from.pop(); to.push(action)
      }
      this.changed()
    } finally { this.working = false; this.changed() }
  }
  dispose() {
    this.closed = true; this.abort.abort(); this.detach.forEach(detach => detach()); this.detach = []
  }
}
