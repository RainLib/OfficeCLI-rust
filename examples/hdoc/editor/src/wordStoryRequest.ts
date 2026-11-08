/** Shared browser/server validation for the exact reviewed story payload. */
import type {WordPendingStory} from './wordCheckpointJournal.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import {validContributor} from './referenceAuthors.ts'
import {wordRegionSchema} from './wordRegionStore.ts'
import {projectionToJson} from './schema.ts'
const nodeId=(v:unknown)=>typeof v==='string'&&/^n_[a-f0-9]{32}$/.test(v)
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
export function readActiveStoryPending(value:unknown,documentId:string,member:WordTopologyMember):WordPendingStory{
 const p=value as WordPendingStory,r=p?.request,intent=p?.intent,story=p?.story,choices=p?.copyChoices
 const invalid=()=>{throw Error('word-active-story-invalid')}
 if(!p||Object.keys(p).sort().join(',')!=='actor,blocks,copyChoices,intent,request,story'||!r||Object.keys(r).sort().join(',')!=='actor,baseLayoutHash,candidateHash,documentId,expectedRevision,transactionId'||r.documentId!==documentId||!/^[a-f0-9]{32}$/.test(r.transactionId??'')||!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0||!Number.isSafeInteger(r.expectedRevision+1)||!hash(r.baseLayoutHash)||!hash(r.candidateHash)||!p.actor||Object.keys(p.actor).sort().join(',')!=='displayName,generation,userId'||p.actor.generation!==1||!validContributor(p.actor)||!r.actor||Object.keys(r.actor).sort().join(',')!=='displayName,userId')invalid()
 requireTopologyMember(member,p.actor,r.actor)
 if(!intent||Object.keys(intent).sort().join(',')!=='expectedInheritedStoryId,kind,sectionId,variant'||!nodeId(intent.sectionId)||!['header','footer'].includes(intent.kind)||!['default','first','even'].includes(intent.variant)||intent.expectedInheritedStoryId!==null&&!nodeId(intent.expectedInheritedStoryId)||!story||Object.keys(story).sort().join(',')!=='id,kind,sourcePart'||story.id!==`n_${r.transactionId}`||story.kind!==intent.kind||story.sourcePart!==`word/hcd-${r.transactionId}.xml`)invalid()
 if(!Array.isArray(p.blocks)||!p.blocks.length||p.blocks.length>10000||new Set(p.blocks.map(b=>b?.blockId)).size!==p.blocks.length||p.blocks.some(b=>!b||!nodeId(b.blockId)||!hash(b.blockHash)||b.flowRegionId!==story.id||b.region!==story.kind||b.readOnly!==false||!b.content)||!choices||Object.keys(choices).sort().join(',')!=='extensions,referenceIds'||!Array.isArray(choices.extensions)||choices.extensions.length||!Array.isArray(choices.referenceIds)||choices.referenceIds.length>10000||choices.referenceIds.some(id=>typeof id!=='string'||!id||id.length>256)||new Set(choices.referenceIds).size!==choices.referenceIds.length||new TextEncoder().encode(JSON.stringify(p)).byteLength>900*1024)invalid()
 try{wordRegionSchema().nodeFromJSON(projectionToJson({documentId,revision:r.expectedRevision,blocks:p.blocks})).check()}catch{invalid()}
 // Canonical keys preserve the gate/journal identity across JSON key order.
 return JSON.parse(JSON.stringify(p,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)) as WordPendingStory
}
