/** Browser/server validation of an exact reviewed link. Validation grants no
 * publication authority; native signatures remain server-only. */
import {validContributor,type AuthenticatedContributor} from './referenceAuthors.ts'
import {readWordLinkSelection,type WordLinkTransaction} from './wordLinkPlan.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
export type WordPendingLink={request:WordLinkTransaction;actor:AuthenticatedContributor;candidateLayoutHash:string;reviewHash:string}
const hex=(v:unknown,n=64):v is string=>typeof v==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(v)
const keys=(value:unknown,expected:string):boolean=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected
export function readWordPendingLink(value:unknown,documentId:string):WordPendingLink{
 const p=value as WordPendingLink,r=p?.request,l=r?.link
 if(!keys(p,'actor,candidateLayoutHash,request,reviewHash')||!keys(p.actor,'displayName,generation,userId')||!validContributor(p.actor)||!hex(p.candidateLayoutHash)||!hex(p.reviewHash)||!keys(r,'actor,documentId,expectedRevision,link,schemaVersion,transactionId')||r.schemaVersion!=='hcd-word-story-link/1'||r.documentId!==documentId||!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0||!Number.isSafeInteger(r.expectedRevision+1)||!keys(r.actor,'displayName,userId')||r.actor.userId!==p.actor.userId||r.actor.displayName!==p.actor.displayName||!keys(l,'baseLayoutHash,expectedDirectStoryId,kind,sectionId,variant')||!hex(l.baseLayoutHash)||l.baseLayoutHash===p.candidateLayoutHash||!/^n_[a-f0-9]{32}$/.test(l.expectedDirectStoryId))throw Error('word-link-pending-invalid')
 readWordLinkSelection({sectionId:l.sectionId,kind:l.kind,variant:l.variant,transactionId:r.transactionId})
 if(new TextEncoder().encode(JSON.stringify(p)).byteLength>256*1024)throw Error('word-link-pending-invalid')
 return structuredClone(p)
}
export function readActiveLinkPending(value:unknown,documentId:string,member:WordTopologyMember){
 const pending=readWordPendingLink(value,documentId)
 if(pending.actor.generation!==1)throw Error('word-active-link-invalid')
 requireTopologyMember(member,pending.actor,pending.request.actor)
 return JSON.parse(JSON.stringify(pending,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)) as WordPendingLink
}
