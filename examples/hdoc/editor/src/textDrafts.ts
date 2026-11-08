import {DraftActions} from './draftActions.ts'
export type TextRun = { nodeId: string; nodeHash: string; text: string; font?: { family: string; sizePt: number; bold: boolean; italic: boolean;families?:string[];mixedFamily?:boolean;mixedSize?:boolean;mixedStyle?:boolean } }
export type TextDraft = { base: TextRun; revision: number; text: string; page?:number; remote?: TextRun; stale?: 'refresh' | 'deleted' }

/** Drafts outlive viewport-mounted editors. The workspace controller owns
 * scoped persistence; a remote revision never overwrites a draft. */
export class TextDraftStore {
  readonly actions=new DraftActions<TextRun,TextDraft>()
  private drafts = new Map<string, TextDraft>()
  private inFlight = new Map<string, TextDraft>()
  private confirmed = new Map<string, { run: TextRun; revision: number }>()
  private listeners = new Set<() => void>()
  private generation = 0
  private batching=0
  private batchChanged=false
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.generation
  private changed() { if(this.batching){this.batchChanged=true;return};this.generation += 1; this.listeners.forEach(listener => listener()) }
  batch(work:()=>void){this.batching++;try{work()}finally{this.batching--;if(!this.batching&&this.batchChanged){this.batchChanged=false;this.changed()}}}
  get(nodeId: string) { return this.drafts.get(nodeId) }
  get size() { return this.drafts.size }
  entries() { return [...this.drafts.entries()] }
  restore(entries:Array<[string,TextDraft]>) {
    if(this.drafts.size||this.inFlight.size)throw new Error('Restore requires a fresh text store')
    for(const[id,draft]of entries)this.drafts.set(id,structuredClone(draft))
    this.changed()
  }
  currentRun(run: TextRun, revision: number) {
    const confirmed = this.confirmed.get(run.nodeId)
    return confirmed && confirmed.revision >= revision ? confirmed.run : run
  }

  edit(run: TextRun, revision: number, text: string, page?:number) {
    const saved = this.confirmed.get(run.nodeId)
    run = this.currentRun(run, revision)
    revision = Math.max(revision, saved?.revision ?? 0)
    const before={...run,text:this.drafts.get(run.nodeId)?.text??run.text}
    if (text === run.text && !this.inFlight.has(run.nodeId) && !this.drafts.get(run.nodeId)?.remote && !this.drafts.get(run.nodeId)?.stale) this.drafts.delete(run.nodeId)
    else {
      const previous = this.drafts.get(run.nodeId)
      this.drafts.set(run.nodeId, previous ? { ...previous, text } : { base: { ...run }, revision, text,...(page!==undefined?{page}:{}) })
    }
    this.changed()
    if(before.text!==text)this.actions.emit({before,after:{...run,text},revision,page,kind:'edit'})
  }

  applyHistory(run:TextRun,revision:number,text:string,page?:number){
    if(this.inFlight.has(run.nodeId))throw new Error('historyBusy')
    this.confirmed.set(run.nodeId,{run:{...run},revision})
    if(text===run.text)this.drafts.delete(run.nodeId)
    else this.drafts.set(run.nodeId,{base:{...run},revision,text,page})
    this.changed()
  }

  reconcile(runs: TextRun[], revision: number) {
    let changed = false
    for (const run of runs) {
      const draft = this.drafts.get(run.nodeId)
      if (!draft || revision < draft.revision) continue
      if (run.text === draft.text && !this.inFlight.has(run.nodeId)) {
        this.drafts.delete(run.nodeId)
        changed = true
      } else if (run.nodeHash !== draft.base.nodeHash) {
        if (draft.remote?.nodeHash !== run.nodeHash || draft.stale) {
          this.drafts.set(run.nodeId, { ...draft, remote: { ...run }, stale: undefined })
          changed = true
        }
      } else if (draft.remote || draft.stale) {
        this.drafts.set(run.nodeId, { ...draft, remote: undefined, stale: undefined })
        changed = true
      }
    }
    if (changed) this.changed()
  }

  reconcileHashes(hashes: Record<string, string | null>, revision: number) {
    let changed = false
    for (const [id, hash] of Object.entries(hashes)) {
      const draft = this.drafts.get(id)
      if (!draft || revision < draft.revision) continue
      const stale = hash === null ? 'deleted' : hash !== draft.base.nodeHash && hash !== draft.remote?.nodeHash ? 'refresh' : undefined
      if (stale !== draft.stale) {
        this.drafts.set(id, { ...draft, stale })
        changed = true
      }
    }
    if (changed) this.changed()
  }

  discard(nodeId: string) {
    if (this.inFlight.has(nodeId)) return
    const draft=this.drafts.get(nodeId)
    if (this.drafts.delete(nodeId)){this.changed();this.actions.emit({before:draft!.base,after:draft!.base,revision:draft!.revision,kind:'reset'})}
  }

  resolve(run: TextRun, revision: number, keepLocal: boolean) {
    if(this.inFlight.has(run.nodeId))return
    run = this.currentRun(run, revision)
    const draft = this.drafts.get(run.nodeId)
    if (!draft) return
    const before=structuredClone({...draft,remote:{...run},stale:undefined})
    if (!keepLocal || draft.text === run.text) this.drafts.delete(run.nodeId)
    else this.drafts.set(run.nodeId, { base: { ...run }, revision, text: draft.text,...(draft.page!==undefined?{page:draft.page}:{}) })
    this.changed()
    this.actions.emit({before:{...run,text:before.text},after:{...run,text:this.drafts.get(run.nodeId)?.text??run.text},revision,page:draft.page,kind:'choose',choice:{before,after:this.drafts.get(run.nodeId)??null,canonical:{...run}}})
  }

  applyChoiceHistory(run:TextRun,revision:number,expected:TextDraft|null,desired:TextDraft|null,guard?:TextRun,requireResolvedExpected=false){
    if(this.inFlight.has(run.nodeId))throw new Error('historyBusy')
    if(guard&&run.nodeHash!==guard.nodeHash)throw new Error('historyConflict')
    const rebase=(snapshot:TextDraft|null):TextDraft|null=>!snapshot||snapshot.text===run.text?null:{...structuredClone(snapshot),revision,remote:snapshot.base.nodeHash!==run.nodeHash?{...run}:undefined,stale:undefined}
    const signature=(snapshot:TextDraft|null)=>snapshot?JSON.stringify({text:snapshot.text,conflict:!!snapshot.remote}):'none'
    const actual=rebase(this.drafts.get(run.nodeId)??null),next=rebase(desired)
    const wantedExpected=rebase(expected)
    if(requireResolvedExpected&&wantedExpected?.remote)throw new Error('historyConflict')
    if(signature(actual)!==signature(wantedExpected))throw new Error('historyConflict')
    this.confirmed.set(run.nodeId,{run:{...run},revision})
    if(next)this.drafts.set(run.nodeId,next);else this.drafts.delete(run.nodeId)
    this.changed()
    return {before:structuredClone(actual),after:structuredClone(next)}
  }

  beginSave(sent: Array<[string, TextDraft]>) {
    if (sent.some(([id]) => this.inFlight.has(id))) throw new Error('Text save already in progress')
    for (const [id, draft] of sent) this.inFlight.set(id, draft)
  }

  endSave(sent: Array<[string, TextDraft]>) {
    for (const [id, draft] of sent) if (this.inFlight.get(id) === draft) this.inFlight.delete(id)
  }

  acknowledge(sent: Array<[string, TextDraft]>, revision: number, hashes: Record<string, string>) {
    for (const [id, saved] of sent) {
      const draft = this.drafts.get(id)
      if (!draft || !hashes[id]) continue
      // A later remote update remains a conflict even if this response arrives late.
      if (draft.stale || draft.remote && draft.remote.nodeHash !== hashes[id]) continue
      this.confirmed.set(id, { run: { nodeId: id, nodeHash: hashes[id], text: saved.text }, revision })
      if (draft.text === saved.text) this.drafts.delete(id)
      else this.drafts.set(id, { base: { nodeId: id, nodeHash: hashes[id], text: saved.text }, revision, text: draft.text,...(draft.page!==undefined?{page:draft.page}:{}) })
    }
    this.changed()
  }
}
