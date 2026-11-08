import type {WordLayout,WordStoryBindings} from './wordRegions.ts'
import type {WordFlowLayout} from './wordPageFlow.ts'
import {wordPaperGeometry} from './wordPaper.ts'

export type WordBookSectionMetric={flow:WordFlowLayout;pages:number;height:number}
export type WordBookNumbering={start:number|undefined;end:number|undefined;reason?:'previous'|'break'|'limit'}
/** Derived screen numbers never enter the saved section properties. A
 * continuous/column/parity break needs a physical book layout adapter before
 * its following section may inherit a computed number. */
export function wordBookNumbering(layout:WordLayout,metrics:ReadonlyMap<string,WordBookSectionMetric>):WordBookNumbering[]{
 let end:number|undefined
 return layout.sections.map((section,index)=>{
  const normal=index===0||section.breakType===undefined||section.breakType==='nextPage'
  const inherited=index===0?1:normal&&end!==undefined?end+1:undefined
  const start=section.page.numberStart??inherited,metric=metrics.get(section.id)
  const count=metric?.flow.phase==='ready'&&Number.isSafeInteger(metric.flow.pages)&&metric.flow.pages!>=1&&metric.flow.pages!<=512?metric.flow.pages!:undefined
  const last=start!==undefined&&count!==undefined?start+count-1:undefined
  const valid=last!==undefined&&Number.isSafeInteger(last)&&last<=2_147_483_647
  end=normal&&valid?last:undefined
  return{start,end,...(!normal?{reason:'break' as const}:start===undefined?{reason:'previous' as const}:last!==undefined&&!valid?{reason:'limit' as const}:{})}
 })
}
/** Resolve inherited bindings in document order rather than rescanning all
 * preceding sections once for every paper. Disabled variants do not reserve
 * body space. The live editor for a story is still unique across this book. */
export function wordBookStoryUses(layout:WordLayout){
 const headers:WordStoryBindings={},footers:WordStoryBindings={}
 return layout.sections.map((section,index)=>{
  for(const variant of ['default','first','even'] as const){if(section.headers[variant]!==undefined)headers[variant]=section.headers[variant];if(section.footers[variant]!==undefined)footers[variant]=section.footers[variant]}
  const variants=['default',...(section.differentFirstPage?['first']:[]),...(layout.evenAndOddHeaders?['even']:[])] as Array<'default'|'first'|'even'>
  const ids=new Set<string>();for(const variant of variants)for(const binding of [headers,footers])if(binding[variant])ids.add(binding[variant]!)
  return{sectionId:section.id,width:wordPaperGeometry(layout,index).bodyWidth,ids,headers:{...headers},footers:{...footers}}
 })
}
export const wordStoryMeasureKey=(id:string,width:number)=>`${id}:${width}`
export function wordBookPageIndex(value:unknown,pages:number){return Number.isSafeInteger(value)&&Number.isSafeInteger(pages)&&pages>0?Math.max(0,Math.min(pages-1,value as number)):0}
