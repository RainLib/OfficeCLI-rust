import * as Y from 'yjs'
import {imageDraftMap} from './collaborativeImages.ts'

/** A packet's Yjs update can contain deletions as well as visible map entries.
 * Only reuse it if every image item is already integrated in the room and
 * every packet deletion affecting one was already integrated too. Unknown GC
 * structs are conservatively rejected because their former parent is lost. */
export function recoveryImagesAlreadyIntegrated(packet:Y.Doc,room:Y.Doc):boolean{
 if(packet.store.pendingDs||packet.store.pendingStructs||room.store.pendingDs||room.store.pendingStructs)return false
 const packetImages=packet.getMap(imageDraftMap),roomImages=room.getMap(imageDraftMap)
 for(const [client,structs] of packet.store.clients){
  const live=room.store.clients.get(client)
  for(const entry of structs){
   const isImage=entry instanceof Y.Item&&entry.parent===packetImages,isGc=entry instanceof Y.GC
   if(!isImage&&!isGc)continue
   if(!live?.length)return false
   let clock=entry.id.clock,end=clock+entry.length
   while(clock<end){
    const last=live[live.length-1];if(clock>last.id.clock+last.length-1)return false
    const current=live[Y.findIndexSS(live,clock)]
    if(current.id.clock>clock||current.id.clock+current.length<=clock)return false
    if(isImage&&current instanceof Y.Item&&current.parent!==roomImages)return false
    if((entry.deleted||isGc)&&!current.deleted)return false
    clock=Math.min(end,current.id.clock+current.length)
   }
  }
 }
 return true
}
