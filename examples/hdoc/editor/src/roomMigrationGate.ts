/** Covers an entire received packet, including its asynchronous auth and
 * application hooks. Checking only before awaiting auth leaves a write race. */
type Entry = {active: number; blocked: boolean; waiters: Array<() => void>; task?: Promise<unknown>; operation?:string; identity?:string}
export class MigrationUncertain extends Error {
  constructor(readonly original?:unknown){super('migration-outcome-unknown')}
}
export class RoomMigrationGate {
  private entries = new Map<string, Entry>()
  private entry(id:string){let value=this.entries.get(id);if(!value){value={active:0,blocked:false,waiters:[]};this.entries.set(id,value)}return value}
  blocked(id:string){return this.entries.get(id)?.blocked??false}
  readyToRelease(id:string,operation:string){const entry=this.entries.get(id);return !!entry?.blocked&&entry.operation===operation&&!entry.task&&!entry.active}
  /** A release must belong to the same frozen request that acquired the gate. */
  readyToReleaseIdentity(id:string,operation:string,identity:string){const entry=this.entries.get(id);return this.readyToRelease(id,operation)&&entry?.identity===identity}
  heldIdentity(id:string,operation:string,identity:string){const entry=this.entries.get(id);return !!entry?.blocked&&entry.operation===operation&&entry.identity===identity&&!entry.active}
  /** Serialize post-transition work without releasing the held gate on error. */
  runHeld<T>(id:string,operation:string,identity:string,work:()=>Promise<T>):Promise<T>{
    const entry=this.entries.get(id)
    if(!entry||!this.readyToReleaseIdentity(id,operation,identity))return Promise.reject(new Error('room-protocol-transition'))
    const task=Promise.resolve().then(work).finally(()=>{if(entry.task===task)entry.task=undefined})
    entry.task=task;return task
  }
  enter(id:string){
    const entry=this.entry(id)
    if(entry.blocked)throw new Error('room-protocol-transition')
    entry.active++;let released=false
    return()=>{if(released)return;released=true;entry.active--;if(!entry.active)entry.waiters.splice(0).forEach(resolve=>resolve())}
  }
  /** Reopen only after the owner has installed an explicitly compatible room. */
  release(id:string,operation:string){const entry=this.entries.get(id);if(!entry?.blocked||entry.operation!==operation||entry.task)throw new Error('room-protocol-transition');entry.blocked=false;entry.operation=undefined;entry.identity=undefined}
  exclusive<T>(id:string,work:()=>Promise<T>,freeze:(()=>void)|undefined,operation:string,holdOnSuccess=false,identity?:string,shareInFlight=true):Promise<T>{
    const entry=this.entry(id)
    // Only retries of the same kind may share a result. An unrelated restore,
    // migration or recovery must not interpret another operation's receipt.
    if((entry.task||entry.blocked)&&(entry.operation!==operation||entry.identity!==identity))return Promise.reject(new Error('room-protocol-transition'))
    if(entry.task)return shareInFlight?entry.task as Promise<T>:Promise.reject(new Error('room-protocol-transition'))
    const wasBlocked=entry.blocked
    entry.blocked=true
    const previousOperation=entry.operation,previousIdentity=entry.identity;entry.operation=operation;entry.identity=identity
    try{freeze?.()}catch(error){entry.blocked=wasBlocked;entry.operation=previousOperation;entry.identity=previousIdentity;return Promise.reject(error)}
    const task=(async()=>{
      if(entry.active)await new Promise<void>(resolve=>entry.waiters.push(resolve))
      try{const result=await Promise.resolve().then(work);if(!holdOnSuccess){entry.blocked=false;entry.operation=undefined;entry.identity=undefined}return result}
      catch(error){if(!(error instanceof MigrationUncertain)){entry.blocked=false;entry.operation=undefined;entry.identity=undefined}throw error}
      finally{entry.task=undefined}
    })()
    entry.task=task;return task
  }
}
