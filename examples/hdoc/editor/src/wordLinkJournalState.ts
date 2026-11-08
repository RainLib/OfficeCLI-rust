/** Exact transitions in the shared signed chain; separate native proof
 * verification and owner/authentication remain mandatory. */
import type {WordSaveCapsule} from './wordCheckpointJournal.ts'
import type {WordPendingLink} from './wordLinkProof.ts'
export type WordLinkJournalAction='prepare'|'acknowledge'|'promote'
export const prepareLinkCapsule=(input:WordSaveCapsule,pending:WordPendingLink):WordSaveCapsule=>{const next=structuredClone(input);next.version=5;delete next.checkpointAcknowledgement;delete next.unchangedAcknowledgement;delete next.staleRebase;next.pendingLink=structuredClone(pending);return next}
export const promoteLinkCapsule=(input:WordSaveCapsule):WordSaveCapsule=>{const next=structuredClone(input);next.version=3;delete next.linkAcknowledgement;return next}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
export function assertWordLinkJournalTransition(before:WordSaveCapsule|undefined,next:WordSaveCapsule,parent:string,action:WordLinkJournalAction|'load'|'save'){
 const reject=()=>{throw Error('word-link-journal-transition-invalid')}
 if(before?.version!==5&&next.version!==5){if(['prepare','acknowledge','promote'].includes(action))reject();return}
 if(next.version===5&&before?.version!==5){
  if(action!=='prepare'&&action!=='load'||before?.version!==3||before.pending||!next.pendingLink||!same(prepareLinkCapsule(before,next.pendingLink),next))reject()
  return
 }
 if(!before||before.version!==5)reject()
 if(next.version===3){if(action!=='promote'&&action!=='load'||!before!.linkAcknowledgement||!same(promoteLinkCapsule(before!),next))reject();return}
 if(next.version!==5)reject()
 if(before!.pendingLink&&next.linkAcknowledgement){
  const proof=next.linkAcknowledgement
  if(action!=='acknowledge'&&action!=='load'||proof.journalHash!==parent||!same(proof.pending,before!.pendingLink)||next.pendingLink||next.base.digest!==before!.base.digest||proof.initialUpdate!==next.document)reject()
  for(const field of ['actors','references','uploads','recoveries','decisions'] as const)if(!same(before![field],next[field]))reject()
 }else if(action!=='save'&&action!=='load'||!same(before!.base,next.base)||!same(before!.pendingLink,next.pendingLink)||!same(before!.linkAcknowledgement,next.linkAcknowledgement))reject()
}
