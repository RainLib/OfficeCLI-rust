/** Server-only request identity and native signature checks. No room or
 * journal is mutated by these checks, and they confer no member authority. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto'
import {wordLinkRequestIdentity,type WordLinkTransaction} from './wordLinkPlan.ts'
import {readWordPendingLink,type WordPendingLink} from './wordLinkRequest.ts'
export {readWordPendingLink,type WordPendingLink} from './wordLinkRequest.ts'
export type WordLinkAcknowledgement={pending:WordPendingLink;record:unknown;receipt:unknown;journalHash:string;initialUpdate:string}
export type WordLinkScope={apiHash:string;documentId:string;epoch:number;lineage:string}
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex')
const hex=(v:unknown,n=64):v is string=>typeof v==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(v)
const keys=(value:unknown,expected:string):boolean=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected
export function wordLinkPendingHash(pending:WordPendingLink){return hash(JSON.stringify(pending,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value))}
/** Native serde field order and sorted BTreeMap actor, including the domain
 * that distinguishes coordinated publication from the old link primitive. */
export function wordLinkRequestHash(r:WordLinkTransaction){
 return hash(wordLinkRequestIdentity(r))
}
export function matchesWordLinkRecord(input:unknown,request:WordLinkTransaction){
 const record=input as any
 return !!record&&record.documentId===request.documentId&&record.authorId===request.actor.userId&&record.authorName===request.actor.displayName&&record.revision===request.expectedRevision+1&&record.parentRevision===request.expectedRevision&&record.patchBaseRevision===request.expectedRevision&&record.patchId===`word-story-link-${request.transactionId}`&&record.patchHash===wordLinkRequestHash(request)&&hex(record.rootHash)&&record.structuralChange===true&&record.wordLayoutChange===true&&record.layoutUpgrade!==true
}
export function verifyWordLinkReceipt(scope:WordLinkScope,secret:string,record:unknown,pending:WordPendingLink,input:unknown,journalHash:string,initialUpdate:Uint8Array){
 try{readWordPendingLink(pending,scope.documentId)}catch{return false}
 const r=pending.request,p=input as any,revision=record as any
 if(!matchesWordLinkRecord(record,r)||!keys(p,'coordinatorId,documentId,epoch,expectedRevision,initialUpdateHash,journalHash,layoutHash,pendingHash,requestHash,reviewHash,revision,rootHash,schemaVersion,signature,transactionId')||!hex(journalHash)||!(initialUpdate instanceof Uint8Array)||!initialUpdate.length||initialUpdate.length>8*1024*1024||p.schemaVersion!=='hcd-word-link-receipt/1'||p.documentId!==scope.documentId||p.epoch!==scope.epoch||p.coordinatorId!==scope.lineage||p.journalHash!==journalHash||p.expectedRevision!==r.expectedRevision||p.revision!==revision.revision||p.transactionId!==r.transactionId||p.requestHash!==wordLinkRequestHash(r)||p.pendingHash!==wordLinkPendingHash(pending)||p.rootHash!==revision.rootHash||p.layoutHash!==pending.candidateLayoutHash||p.reviewHash!==pending.reviewHash||p.initialUpdateHash!==hash(initialUpdate)||typeof p.signature!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(p.signature))return false
 const message=JSON.stringify(['hcd-word-link-receipt/1',scope.apiHash,scope.documentId,scope.epoch,scope.lineage,journalHash,r.expectedRevision,revision.revision,r.transactionId,p.requestHash,p.pendingHash,revision.rootHash,r.link.baseLayoutHash,pending.candidateLayoutHash,pending.reviewHash,p.initialUpdateHash])
 const expected=createHmac('sha256',secret).update(message).digest('base64url')
 return p.signature.length===expected.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(p.signature))
}
