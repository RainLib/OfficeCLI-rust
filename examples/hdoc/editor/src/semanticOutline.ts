import type {Node as PmNode} from '@tiptap/pm/model'

export type SemanticOutlineEntry={pos:number;level:number;text:string;key?:string}
export function semanticOutline(document:PmNode):SemanticOutlineEntry[]{
 const entries:SemanticOutlineEntry[]=[]
 document.descendants((node,pos)=>{if(node.type.name==='heading'){
  const text=node.textBetween(0,node.content.size,' ',leaf=>leaf.attrs.reference?.snapshot?.label?'@'+leaf.attrs.reference.snapshot.label:leaf.attrs.extension?.fallback?.text??'')
  entries.push({pos,level:Number.isInteger(node.attrs.level)&&node.attrs.level>=1&&node.attrs.level<=6?node.attrs.level:1,text,key:typeof node.attrs.hcdStructureKey==='string'?node.attrs.hcdStructureKey:undefined})
 }})
 return entries
}
export function filterSemanticOutline(entries:readonly SemanticOutlineEntry[],query:string,locale:string,untitled:string){
 const term=query.trim().toLocaleLowerCase(locale);return term?entries.filter(entry=>(entry.text||untitled).toLocaleLowerCase(locale).includes(term)):entries
}
/** Keep the sidebar compact while retaining context for matches beyond the
 * beginning. Lowercasing can expand characters, so folded UTF-16 offsets
 * must be mapped back to original Unicode code points. */
export function semanticOutlineExcerpt(text:string,query:string,locale:string){
 const points=Array.from(text),term=query.trim().toLocaleLowerCase(locale),match=term?text.toLocaleLowerCase(locale).indexOf(term):-1
 const length=term?Math.min(256,Math.max(48,Array.from(query.trim()).length+8)):256
 let start=0
 if(match>=0&&match+term.length>points.slice(0,length).join('').toLocaleLowerCase(locale).length){
  let low=0,high=points.length
  while(low<high){const mid=Math.floor((low+high+1)/2);if(points.slice(0,mid).join('').toLocaleLowerCase(locale).length<=match)low=mid;else high=mid-1}
  // The sidebar is narrow and truncates one visual line. Keep only a short
  // prefix so a late match is visible without requiring hover.
  start=Math.max(0,low-4)
 }
 return `${start?'…':''}${points.slice(start,start+length).join('')}${points.length>start+length?'…':''}`
}
/** Reject stale positions rather than selecting another heading after an edit. */
export function semanticOutlinePosition(document:PmNode,entry:SemanticOutlineEntry):number|null{
 if(entry.key!==undefined){let found:number|null=null,count=0;document.descendants((node,pos)=>{if(node.attrs.hcdStructureKey===entry.key){count++;if(node.type.name==='heading')found=pos}});return count===1?found:null}
 const node=document.nodeAt(entry.pos);if(!node||node.type.name!=='heading')return null
 const current=semanticOutline(document).find(value=>value.pos===entry.pos)
 return current&&current.level===entry.level&&current.text===entry.text?entry.pos:null
}
