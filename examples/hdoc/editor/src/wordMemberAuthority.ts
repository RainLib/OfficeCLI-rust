import {roomMatches,wordRegionalProtocol,wordLayoutProtocol,type CollaborationRoom} from './collaborationProtocol.ts'
import type {CollaborationAccess} from './collaborationAccess.ts'
import type {WordTopologyMember} from './wordTopologyAuthority.ts'

/** Resolve authority from the member's current token, never from the draft.
 * Recheck the owner lease and token after the asynchronous authorization call. */
export async function authorizeWordMember(options:{room:CollaborationRoom;userId:string;displayName?:string;token:()=>string|undefined;access:(token:string)=>Promise<CollaborationAccess>;assertLease:()=>void;now?:()=>number}):Promise<{token:string;member:WordTopologyMember}>{
 const fail=()=>{throw new Error('word-member-authority-changed')}
 const expected={userId:options.userId,displayName:options.displayName},room={...options.room},token=options.token()
 if(!expected.userId||!token||room.fixed||room.protocol!==wordRegionalProtocol&&room.protocol!==wordLayoutProtocol)fail()
 options.assertLease()
 const current=await options.access(token!)
 options.assertLease()
 if(options.room.documentId!==room.documentId||options.room.epoch!==room.epoch||options.room.fixed!==room.fixed||options.room.protocol!==room.protocol||options.token()!==token||current.scope!=='write'||current.userId!==expected.userId||!roomMatches(room,current)||!Number.isSafeInteger(current.expiresAt)||(options.now?.()??Date.now())>=current.expiresAt*1000||expected.displayName!==undefined&&current.displayName!==expected.displayName)fail()
 return {token:token!,member:{userId:current.userId!,displayName:current.displayName??'',scope:'write'}}
}
