/** Derive bounded human review rows from the signed link and pinned layout.
 * Planning does not authorize publishing or discard the retained story. */
import {planWordStoryLink,type WordLinkTransaction} from './wordLinkPlan.ts'
import type {WordLayout} from './wordRegions.ts'
export type WordLinkRecoveryChange={operation:'link';section:number;kind:'header'|'footer';variant:'default'|'first'|'even';sourceSection:number|null;contentChanged:boolean;retained:true}
export function wordLinkRecoveryDetails(layout:WordLayout,link:WordLinkTransaction['link'],transactionId:string,offset:number){
 if(!Number.isSafeInteger(offset)||offset<0||offset%20!==0)throw Error('word-link-review-offset-invalid')
 const plan=planWordStoryLink(layout,{sectionId:link.sectionId,kind:link.kind,variant:link.variant,transactionId})
 if(plan.retainedStoryId!==link.expectedDirectStoryId)throw Error('word-link-review-changed')
 const key=link.kind==='header'?'headers':'footers';let sourceSection:number|null=null
 for(let i=plan.section-2;i>=0;i--)if(layout.sections[i][key][link.variant]!==undefined){sourceSection=i+1;break}
 const affected=new Set(plan.affected.map(item=>item.sectionId)),sections=layout.sections.flatMap((section,index)=>section.id===link.sectionId||affected.has(section.id)?[{id:section.id,number:index+1}]:[])
 if(offset>=sections.length)throw Error('word-link-review-offset-invalid')
 return{total:sections.length,offset,changes:sections.slice(offset,offset+20).map(section=>({operation:'link' as const,section:section.number,kind:link.kind,variant:link.variant,sourceSection,contentChanged:affected.has(section.id),retained:true as const}))}
}
