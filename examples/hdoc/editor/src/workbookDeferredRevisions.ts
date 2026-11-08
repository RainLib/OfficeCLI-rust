import type {RevisionEvent} from './api.ts'

/** A save receipt may advance the head before an earlier peer event arrives.
 * That event is too old to replay on the current head, but it can describe
 * cells that the grid loaded at an earlier revision. */
export function workbookLatePeerNeedsReload(event:RevisionEvent,head:number,openedRevision:number,own:boolean){
 return !own&&event.revision<head&&event.revision>openedRevision
}

/** Bounded events held while an in-cell editor owns private input. */
export class WorkbookDeferredRevisions {
 private events:RevisionEvent[]=[]
 private bytes=0
 private needsReload=false
 get pending(){return this.needsReload||this.events.length>0}
 push(event:RevisionEvent){
  if(this.needsReload)return
  const size=event.nodes.reduce((sum,node)=>sum+node.text.length+node.nodeId.length+node.nodeHash.length,0)+Object.entries(event.nodeHashes??{}).reduce((sum,[id,hash])=>sum+id.length+(hash?.length??0),0)
  if(event.reset||this.events.length>=128||this.bytes+size>2_000_000){this.events=[];this.bytes=0;this.needsReload=true;return}
  this.events.push(event);this.bytes+=size
 }
 take(){const result={reload:this.needsReload,events:this.events};this.events=[];this.bytes=0;this.needsReload=false;return result}
}
