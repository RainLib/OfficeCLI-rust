import {legacyProtocol,requireCollaborationSession,type CollaborationSession} from './collaborationProtocol.ts'

export type CollaborationAccess=CollaborationSession&{scope:'read'|'write';userId?:string;displayName?:string;expiresAt:number;coordinatedRestore?:boolean}

/** The native auth endpoint is authoritative, but malformed responses must
 * never turn an invalid or unbounded session into an accepted room member. */
export function requireCollaborationAccess(value:unknown,options?:{wordLayoutV2?:boolean},now=Date.now()):CollaborationAccess{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid-collaboration-authority')
 const result=value as Record<string,unknown>
 if(result.scope!=='read'&&result.scope!=='write'||!Number.isSafeInteger(result.expiresAt)||Number(result.expiresAt)<=0||!Number.isFinite(now)||now>=Number(result.expiresAt)*1000)throw Error('invalid-collaboration-authority')
 if(result.userId!=null&&typeof result.userId!=='string'||result.displayName!=null&&typeof result.displayName!=='string'||result.coordinatedRestore!==undefined&&typeof result.coordinatedRestore!=='boolean')throw Error('invalid-collaboration-authority')
 const session=requireCollaborationSession({...result,collaborationProtocol:result.collaborationProtocol??legacyProtocol},options)
 return {...result,...session,userId:result.userId??undefined,displayName:result.displayName??undefined} as CollaborationAccess
}
