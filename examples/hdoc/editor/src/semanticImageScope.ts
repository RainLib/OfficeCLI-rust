import type {Session} from './api.ts'

/** Credentials and display names can refresh without changing authority. */
export function sameResourceSession(a:Session,b:Session):boolean{
 return a.documentId===b.documentId&&a.userId===b.userId&&a.apiUrl===b.apiUrl&&a.collabUrl===b.collabUrl&&a.collaborationEpoch===b.collaborationEpoch&&a.collaborationProtocol===b.collaborationProtocol&&a.flowLayoutVersion===b.flowLayoutVersion&&a.format===b.format
}
/** Token refresh and presentation-only changes keep the same document scope;
 * a different identity, model, endpoint or journal must never inherit work. */
export function semanticImageScopeMatches(bound:{session:Session;userId:string;document:unknown;localJournal:unknown},current:{session:Session;userId:string;document:unknown;localJournal:unknown}):boolean{
 const a=bound.session,b=current.session
 return bound.userId===current.userId&&bound.document===current.document&&bound.localJournal===current.localJournal&&sameResourceSession(a,b)
}
