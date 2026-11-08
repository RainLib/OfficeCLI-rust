import {nodeEditWireVersion,roomMatches,wordLayoutProtocol,wordRegionalProtocol,type CollaborationRoom} from './collaborationProtocol.ts'
import type {CollaborationAccess} from './collaborationAccess.ts'

/** Require the authenticated room identity and the client's explicit wire
 * acknowledgement before loading regional state. This does not enable a
 * layout room: the host must separately install its compatible save owner. */
export function requireWordRoomClient(room:CollaborationRoom,access:CollaborationAccess,parameters:URLSearchParams,enabled:boolean){
 if(room.fixed||room.protocol!==wordRegionalProtocol&&room.protocol!==wordLayoutProtocol||!roomMatches(room,access))throw new Error('word-room-authority-mismatch')
 if(!enabled||access.coordinatedRestore!==true)throw new Error('word-room-disabled')
 const layout=room.protocol===wordLayoutProtocol
 if(parameters.get('hcdNodeEdits')!==String(nodeEditWireVersion)||parameters.get('hcdWordRegions')!==(layout?'2':'1')||layout&&parameters.get('hcdWordLayout')!=='1'||!layout&&parameters.has('hcdWordLayout'))throw new Error('word-room-client-upgrade-required')
 // Repeated declarations must not let proxies and the host choose different
 // wire models from the same handshake.
 for(const name of ['hcdNodeEdits','hcdWordRegions','hcdWordLayout'])if(parameters.getAll(name).length>1)throw new Error('word-room-client-upgrade-required')
 return room.protocol
}
