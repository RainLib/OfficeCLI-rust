/** Layout request identity stays separate from story identity while sharing
 * the bounded phase/retry engine. Native signed journals remain authoritative. */
import type {WordLayoutPending} from './wordCheckpointJournal.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import {WordActiveTopology,type WordActiveTopologyContext,type WordActiveTopologyStatus} from './wordActiveTopology.ts'
export type WordActiveLayoutContext=WordActiveTopologyContext
export type WordActiveLayoutStatus=WordActiveTopologyStatus<'layout'>
export class WordActiveLayout extends WordActiveTopology<WordLayoutPending,'layout'>{constructor(){super('layout')}}

/** The HTTP caller supplies the current authenticated actor. Reconstruct keys
 * in a stable order so JSON object ordering cannot change retry identity. */
export function activeWordLayoutPending(value:unknown,documentId:string,member:WordTopologyMember):WordLayoutPending{
 const input=value as WordLayoutPending['request'],integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0,scalar=(v:unknown)=>v===null||typeof v==='boolean'||typeof v==='string'&&v.length<=128||typeof v==='number'&&Number.isFinite(v)
 if(!input||Object.keys(input).sort().join(',')!=='actor,baseRevision,documentId,edits,expectedRevision,schemaVersion,transactionId'||input.schemaVersion!=='hcd-word-layout-transaction/1'||input.documentId!==documentId||!/^[a-f0-9]{32}$/.test(input.transactionId??'')||!integer(input.baseRevision)||!integer(input.expectedRevision)||!integer(input.expectedRevision+1)||input.baseRevision>input.expectedRevision||!input.actor||Object.keys(input.actor).sort().join(',')!=='displayName,userId'||!input.edits||Object.keys(input.edits).sort().join(',')!=='baseLayoutHash,changes,schemaVersion'||input.edits.schemaVersion!=='hcd-word-layout-edits/1'||!/^[a-f0-9]{64}$/.test(input.edits.baseLayoutHash??'')||!Array.isArray(input.edits.changes)||!input.edits.changes.length||input.edits.changes.length>4096)throw Error('word-active-layout-invalid')
 requireTopologyMember(member,input.actor,input.actor)
 const changes=input.edits.changes.map(change=>{if(!change||Object.keys(change).sort().join(',')!==(change.sectionId===undefined?'expected,field,value':'expected,field,sectionId,value')||typeof change.field!=='string'||change.field.length>64||change.sectionId!==undefined&&!/^n_[a-f0-9]{32}$/.test(change.sectionId)||!scalar(change.expected)||!scalar(change.value))throw Error('word-active-layout-invalid');return{...(change.sectionId===undefined?{}:{sectionId:change.sectionId}),field:change.field,expected:change.expected,value:change.value}})
 const actor={userId:member.userId,displayName:member.displayName}
 return{actor:{...actor,generation:1},request:{schemaVersion:input.schemaVersion,documentId,transactionId:input.transactionId,baseRevision:input.baseRevision,expectedRevision:input.expectedRevision,actor:{...actor},edits:{schemaVersion:input.edits.schemaVersion,baseLayoutHash:input.edits.baseLayoutHash,changes}}}
}
