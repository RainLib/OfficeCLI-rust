/** Remember in-flight and recently acknowledged requests until delayed revision
 * events arrive. The server binds each patch ID to one immutable request. */
export class WorkbookOwnRevisions {
 private readonly ids=new Set<string>()
 remember(id:string|undefined){
  if(!id)return
  this.ids.delete(id);this.ids.add(id)
  if(this.ids.size>128)this.ids.delete(this.ids.values().next().value!)
 }
 isOwn(event:{patchId:string;reset?:boolean},pendingId?:string){
  return !event.reset && !!event.patchId && (event.patchId===pendingId||this.ids.has(event.patchId))
 }
}
