/** The trusted host must resolve this identity from the current member's
 * authentication and document permissions, never from the submitted request. */
export type WordTopologyMember={userId:string;displayName:string;scope:'write'|'read'}
export function requireTopologyMember(member:WordTopologyMember,actor:{userId:string;displayName:string},requestActor:{userId:string;displayName:string}){
 if(!member||member.scope!=='write'||typeof member.userId!=='string'||!member.userId||typeof member.displayName!=='string'||!member.displayName||!actor||!requestActor||member.userId!==actor.userId||member.displayName!==actor.displayName||member.userId!==requestActor.userId||member.displayName!==requestActor.displayName)throw new Error('word-topology-actor-unauthorized')
}
