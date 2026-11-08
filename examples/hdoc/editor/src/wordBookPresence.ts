/** These values are ephemeral hints, not document IDs accepted for mutation. */
export type WordPaperLocation={sectionId:string;variant:'first'|'default'|'even';paperIndex:number;paperProgress?:number}
/** Keep v1 progress section-local for old regional clients. Whole-book
 * progress is a separate optional hint, never an overloaded old field. */
export function wordSectionViewportProgress(top:number,height:number,viewportTop:number,viewportHeight:number){
 if(![top,height,viewportTop,viewportHeight].every(Number.isFinite)||height<0||viewportHeight<0)return 0
 return Math.max(0,Math.min(1,(viewportTop-top)/Math.max(1,height-viewportHeight)))
}
export function readWordBookProgress(value:unknown):number|undefined{
 if(!value||typeof value!=='object')return
 const input=value as {book?:unknown;bookProgress?:unknown}
 return input.book===1&&typeof input.bookProgress==='number'&&Number.isFinite(input.bookProgress)&&input.bookProgress>=0&&input.bookProgress<=1?input.bookProgress:undefined
}
export function readWordPaperLocation(value:unknown):WordPaperLocation|null{
 if(!value||typeof value!=='object')return null
 const candidate=value as WordPaperLocation
 if(typeof candidate.sectionId!=='string'||candidate.sectionId.length!==34||!/^n_[a-f0-9]{32}$/.test(candidate.sectionId)||!['first','default','even'].includes(candidate.variant)||!Number.isSafeInteger(candidate.paperIndex)||candidate.paperIndex<0||candidate.paperIndex>=512)return null
 const progress=candidate.paperProgress
 if(progress!==undefined&&(!Number.isFinite(progress)||progress<0||progress>1))return null
 return{sectionId:candidate.sectionId,variant:candidate.variant,paperIndex:candidate.paperIndex,...(progress!==undefined?{paperProgress:progress}:{})}
}
