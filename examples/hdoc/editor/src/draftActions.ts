/** User intent only. Reconciliation, receipts and recovery never emit actions. */
export type DraftAction<T>={before:T;after:T;revision:number;page?:number;kind:'edit'|'replace'|'reset'}
export class DraftActions<T>{
 private listeners=new Set<(action:DraftAction<T>)=>void>()
 subscribe=(listener:(action:DraftAction<T>)=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 emit(action:DraftAction<T>){this.listeners.forEach(listener=>listener(structuredClone(action)))}
}
