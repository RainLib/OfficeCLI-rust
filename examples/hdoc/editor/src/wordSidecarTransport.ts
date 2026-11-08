import {wordLayoutProtocol,wordRegionalProtocol,type CollaborationRoom} from './collaborationProtocol.ts'

/** Select from the native head, never a client-supplied capability. Unknown
 * and legacy linked-story models are deliberately not treated as layout-only. */
export function wordSidecarHeadModel(value:unknown,documentId:string):'layout'|'story'{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('word-layout-head-invalid')
 const manifest=value as {documentId?:unknown;revision?:unknown;rootHash?:unknown;profile?:unknown;source?:{format?:unknown};capabilities?:{flowLayout?:unknown;wordLayoutEdits?:unknown}}
 if(manifest.documentId!==documentId||!Number.isSafeInteger(manifest.revision)||(manifest.revision as number)<0||typeof manifest.rootHash!=='string'||!/^[a-f0-9]{64}$/.test(manifest.rootHash)||manifest.profile!=='semantic-flow'||manifest.source?.format!=='docx'||manifest.capabilities?.flowLayout!==2)throw new Error('word-layout-head-invalid')
 const capability=manifest.capabilities.wordLayoutEdits
 if(capability===undefined||capability===1)return 'layout'
 if(capability===3)return 'story'
 throw new Error('word-layout-head-unsupported')
}
/** Re-read the head for each guarded request. Native handlers independently
 * check the head and owner under lock, so a concurrent change fails closed. */
export async function wordSidecarRequestModel(route:string,documentId:string,head:()=>Promise<Response>,assertLease:()=>void){
 if(!['/editor','/word/checkpoints','/word/checkpoint-receipt','/word/layout-preflight','/word/layout-transactions','/word/layout-receipt'].includes(route.split('?',1)[0]))return undefined
 assertLease();const response=await head();if(!response.ok)throw new Error(`word-layout-head:${response.status}`)
 const model=wordSidecarHeadModel(await response.json(),documentId);assertLease();return model
}

/** Owner-scoped requests always use the room's own lease; caller headers may
 * not substitute another owner or stale journal tip. This does not enable a
 * room or grant a member permission to perform a topology operation. */
export function wordSidecarRoomName(room:CollaborationRoom){
 if(room.fixed||![wordRegionalProtocol,wordLayoutProtocol].includes(room.protocol as typeof wordRegionalProtocol|typeof wordLayoutProtocol))throw new Error('word-owner-room-invalid')
 return `${room.documentId}:${room.epoch}:${room.protocol===wordLayoutProtocol?'wordregions2:save6':'wordregions1:save5'}`
}
const ownerRoutes=new Set(['/word/checkpoints','/word/checkpoint-receipt','/word/checkpoint-cancel','/word/layout-receipt','/word/layout-transactions','/word/layout-preflight','/word/story-receipt','/word/story-transactions','/word/story-preflight','/word/link-preflight','/word/link-transactions','/word/link-receipt','/word/topology-cancel'])
/** The caller selects the model from the verified canonical head. Never infer
 * it from caller headers: story-aware and layout-only heads require different
 * coordinator versions, and an incorrect declaration must fail closed. */
export function wordSidecarHeaders(route:string,init:HeadersInit|undefined,lease:Record<string,string>,model?:'layout'|'story'){
 const headers=new Headers(init)
 // Replace, rather than trust, any owner values supplied by a caller.
 const ownerNames=['X-HCD-Word-Owner','X-HCD-Word-Owner-Id','X-HCD-Word-Journal-Hash']
 for(const name of ownerNames)headers.delete(name)
 const path=route.split('?',1)[0]
 if(model&&['/editor','/word/checkpoints','/word/checkpoint-receipt','/word/layout-preflight','/word/layout-transactions','/word/layout-receipt'].includes(path)){
  headers.set('X-HCD-Coordinator-Version',model==='story'?'7':'6');headers.set('X-HCD-Word-Layout-Version','1')
  if(model==='story')headers.set('X-HCD-Word-Story-Version','1');else headers.delete('X-HCD-Word-Story-Version')
 }
 const layoutEditor=path==='/editor'&&['6','7'].includes(headers.get('X-HCD-Coordinator-Version')??'')&&headers.get('X-HCD-Word-Layout-Version')==='1'
 if(ownerRoutes.has(path)||layoutEditor)for(const name of ownerNames){if(typeof lease[name]!=='string'||!lease[name])throw new Error('word-owner-unavailable');headers.set(name,lease[name])}
 return headers
}
