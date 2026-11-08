import type {StructurePoint} from './semanticStructureSelection.ts'
export const structureViewportField='hcdStructureViewport'
export type ViewportFollowTicket=Readonly<{client:number;generation:number}>
/** Cancel navigation synchronously, before React commits a new subscription.
 * Old awareness callbacks and animation frames must not restart following. */
export class ViewportFollowIntent{
 private client:number|null=null
 private generation=0
 set(client:number|null){if(client!==null&&(!Number.isSafeInteger(client)||client<0))throw Error('invalid-follow-client');this.client=client;this.generation++}
 capture(client:number):ViewportFollowTicket|null{return this.client===client?Object.freeze({client,generation:this.generation}):null}
 current(ticket:ViewportFollowTicket){return this.client===ticket.client&&this.generation===ticket.generation}
}
export type StructureViewport={version:1;owner:string;progress:number;anchor:StructurePoint|null;following?:number}
/** Presence is untrusted, ephemeral navigation data, never document content. */
export function readStructureViewport(input:unknown):StructureViewport|null{
 try{
  if(!input||JSON.stringify(input).length>6000)return null
  const value=input as StructureViewport
  if(value.version!==1||typeof value.owner!=='string'||value.owner.length>64||!Number.isFinite(value.progress)||value.progress<0||value.progress>1)return null
  if(value.following!==undefined&&(!Number.isSafeInteger(value.following)||value.following<0))return null
  const point=value.anchor
  if(point){
   if(typeof point.key!=='string'||!point.key.length||point.key.length>128||!Number.isSafeInteger(point.offset)||point.offset<0)return null
   const id=(id:any)=>id==null||typeof id==='object'&&Number.isSafeInteger(id.client)&&id.client>=0&&Number.isSafeInteger(id.clock)&&id.clock>=0
   const relative=point.relative
   if(relative&&(!id(relative.type)||!id(relative.item)||relative.tname!=null||relative.assoc!==undefined&&![0,-1,1].includes(relative.assoc)))return null
  }else if(point!==null)return null
  return value
 }catch{return null}
}

/** Reject mutual and longer follow loops instead of making viewers chase each
 * other's programmatic scroll events. A missing peer simply ends the chain. */
export function viewportFollowCycle(states:ReadonlyMap<number,Record<string,unknown>>,local:number,target:number){
 const seen=new Set([local]);let client:number|undefined=target
 for(let count=0;client!==undefined&&count<1000;count++){
  if(seen.has(client))return true
  seen.add(client);client=readStructureViewport(states.get(client)?.[structureViewportField])?.following
 }
 return client!==undefined
}

/** One row per person, pinned to the exact connection being followed. A second
 * window must not silently redirect an existing follow session. */
export function selectViewportConnections<T extends {client:number;id:string}>(peers:readonly T[],following:number|null):T[]{
 const members=new Map<string,T>()
 for(const peer of peers){const previous=members.get(peer.id);if(!previous||peer.client===following)members.set(peer.id,peer)}
 return [...members.values()]
}
