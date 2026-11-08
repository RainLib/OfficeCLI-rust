/** Browser-safe planning only. Publication needs native owner/journal proof. */
import {readWordLayout,type WordLayout} from './wordRegions.ts'
export type WordLinkSelection={sectionId:string;kind:'header'|'footer';variant:'default'|'first'|'even';transactionId:string}
export type WordLinkTransaction={schemaVersion:'hcd-word-story-link/1';documentId:string;transactionId:string;expectedRevision:number;actor:{userId:string;displayName:string};link:{baseLayoutHash:string;sectionId:string;kind:'header'|'footer';variant:'default'|'first'|'even';expectedDirectStoryId:string}}
export function readWordLinkSelection(value:unknown):WordLinkSelection{
 const v=value as WordLinkSelection
 if(!v||Object.keys(v).sort().join(',')!=='kind,sectionId,transactionId,variant'||!/^n_[a-f0-9]{32}$/.test(v.sectionId)||!/^[a-f0-9]{32}$/.test(v.transactionId)||!['header','footer'].includes(v.kind)||!['default','first','even'].includes(v.variant))throw Error('word-link-selection-invalid')
 return{sectionId:v.sectionId,kind:v.kind,variant:v.variant,transactionId:v.transactionId}
}
export function planWordStoryLink(layout:WordLayout,input:WordLinkSelection){
 const selection=readWordLinkSelection(input);readWordLayout({layout,layoutHash:'0'.repeat(64),revision:0},0,2)
 const index=layout.sections.findIndex(section=>section.id===selection.sectionId),key=selection.kind==='header'?'headers':'footers'
 if(index<0)throw Error('word-link-selection-invalid');if(index===0)throw Error('word-link-first-section')
 const direct=layout.sections[index][key][selection.variant];if(direct===undefined)throw Error('word-link-already-inherited')
 let inherited:string|null=null
 for(let previous=index-1;previous>=0;previous--){const value=layout.sections[previous][key][selection.variant];if(value!==undefined){inherited=value;break}}
 const affected:Array<{sectionId:string;beforeStoryId:string;afterStoryId:string|null}>=[]
 for(let offset=index;offset<layout.sections.length;offset++){if(offset>index&&layout.sections[offset][key][selection.variant]!==undefined)break;if(inherited!==direct)affected.push({sectionId:layout.sections[offset].id,beforeStoryId:direct,afterStoryId:inherited})}
 const next=structuredClone(layout);delete next.sections[index][key][selection.variant]
 return{layout:next,section:index+1,retainedStoryId:direct,inheritedStoryId:inherited,affected}
}
/** Shape equivalence only; callers independently authenticate the native
 * revision and compare all content before accepting its new layout. */
export function matchesWordStoryLinkTransition(before:WordLayout,after:WordLayout,request:WordLinkTransaction){
 try{
  const plan=planWordStoryLink(before,{sectionId:request.link.sectionId,kind:request.link.kind,variant:request.link.variant,transactionId:request.transactionId})
  const ordered=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
  return plan.retainedStoryId===request.link.expectedDirectStoryId&&ordered(plan.layout)===ordered(after)
 }catch{return false}
}
/** Byte recipe shared by the native-compatible server hash and browser proof.
 * Rust serializes transaction fields in declaration order and actor BTreeMap
 * fields in sorted order. This function carries no publication authority. */
export function wordLinkRequestIdentity(r:WordLinkTransaction){
 return JSON.stringify(['hcd-word-coordinated-link/1',{schemaVersion:r.schemaVersion,documentId:r.documentId,transactionId:r.transactionId,expectedRevision:r.expectedRevision,actor:{displayName:r.actor.displayName,userId:r.actor.userId},link:{baseLayoutHash:r.link.baseLayoutHash,sectionId:r.link.sectionId,kind:r.link.kind,variant:r.link.variant,expectedDirectStoryId:r.link.expectedDirectStoryId}}])
}
