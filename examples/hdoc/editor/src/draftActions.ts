/** User intent only. Reconciliation, receipts and recovery never emit actions. */
export type DraftChoice<T,D>={before:D;after:D|null;canonical:T;fields?:string[]}
export type DraftAction<T,D=never>={before:T;after:T;revision:number;page?:number;kind:'edit'|'replace'|'choose'|'reset';choice?:DraftChoice<T,D>}
export class DraftActions<T,D=never>{
 private listeners=new Set<(action:DraftAction<T,D>)=>void>()
 subscribe=(listener:(action:DraftAction<T,D>)=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 emit(action:DraftAction<T,D>){this.listeners.forEach(listener=>listener(structuredClone(action)))}
}
