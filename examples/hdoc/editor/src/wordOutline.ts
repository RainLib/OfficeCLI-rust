import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import {TextSelection,type EditorState} from '@tiptap/pm/state'
import type {WordLayout} from './wordRegions.ts'
import {wordBoundaryName} from './wordRegionStore.ts'

/** View identity only: canonical/source IDs can change on save receipts. */
export type WordOutlineEntry={sectionId:string;key:string;level:number;text:string}
// Search offsets are UTF-16 offsets in the case-folded string. Case folding
// may expand characters (for example İ -> i + combining dot), so do not use
// that offset directly to slice the original heading.
function originalPointOffset(points:string[],foldedOffset:number,locale:string){
 let low=0,high=points.length
 while(low<high){const mid=Math.floor((low+high+1)/2),length=points.slice(0,mid).join('').toLocaleLowerCase(locale).length;if(length<=foldedOffset)low=mid;else high=mid-1}
 return low
}
export function wordOutline(layout:WordLayout,document:PmNode,options?:{fullLabels?:boolean;search?:{term:string;locale:string;untitled:string};onHeading?:()=>void}):WordOutlineEntry[]{
 const bodies=new Set(layout.sections.map(section=>section.id)),result:WordOutlineEntry[]=[],seen=new Set<string>()
 const search=options?.search,term=search?.term.trim().toLocaleLowerCase(search.locale)??''
 let sectionId:string|undefined,total=0
 document.forEach(block=>{
  if(block.type.name===wordBoundaryName){sectionId=bodies.has(block.attrs.regionId)?block.attrs.regionId:undefined;return}
  if(!sectionId)return
  const visit=(node:PmNode)=>{
   if(node.type.name!=='heading')return
   const key=node.attrs.hcdStructureKey
   if(typeof key!=='string'||!key||seen.has(key))throw Error('word-outline-identity')
   seen.add(key)
   options?.onHeading?.()
   const text=node.textBetween(0,node.content.size,' ',leaf=>leaf.attrs.reference?.snapshot?.label?'@'+leaf.attrs.reference.snapshot.label:leaf.attrs.extension?.fallback?.text??'').replace(/\s+/gu,' ').trim()
   if(options?.fullLabels){total+=text.length;if(seen.size>4000||total>1_000_000)throw Error('word-outline-snapshot-too-large')}
   const match=term?(text||search!.untitled).toLocaleLowerCase(search!.locale).indexOf(term):-1
   if(term&&match<0)return
   const points=Array.from(text),visibleFoldedLength=term?points.slice(0,256).join('').toLocaleLowerCase(search!.locale).length:0
   const start=match>=0&&match+term.length>visibleFoldedLength?Math.max(0,originalPointOffset(points,match,search!.locale)-64):0
   const label=start?`…${points.slice(start,start+256).join('')}${points.length>start+256?'…':''}`:points.slice(0,256).join('')
   result.push({sectionId:sectionId!,key,level:Number.isInteger(node.attrs.level)&&node.attrs.level>=1&&node.attrs.level<=6?node.attrs.level:1,text:options?.fullLabels?text:label})
  }
  visit(block);block.descendants(visit)
 })
 return result
}
/** Insert an explicit static snapshot after the selected top-level block.
 * Never replace a selection or reuse heading/source identities. */
export function wordOutlineSnapshotTransaction(state:EditorState,entries:readonly Pick<WordOutlineEntry,'level'|'text'>[],untitled:string){
 if(!entries.length||entries.length>4000||!untitled||!state.selection.empty||!(state.selection instanceof TextSelection)||state.selection.$from.depth<1)return null
 let size=0
 const nodes=entries.map(entry=>{
  if(!Number.isInteger(entry.level)||entry.level<1||entry.level>6||typeof entry.text!=='string')throw Error('word-outline-snapshot-invalid')
  const text='— '.repeat(entry.level-1)+'• '+(entry.text||untitled);size+=text.length
  if(size>1_000_000)throw Error('word-outline-snapshot-too-large')
  return state.schema.nodes.paragraph.createChecked(null,state.schema.text(text))
 })
 return state.tr.insert(state.selection.$from.after(1),Fragment.fromArray(nodes))
}
/** Resolve against the current scoped document. Never fall back to an old
 * offset or another heading with the same title after a deletion/conversion. */
export function wordOutlinePosition(document:PmNode,entry:WordOutlineEntry):number|null{
 let position:number|null=null,matches=0
 document.descendants((node,at)=>{
  if(node.attrs.hcdStructureKey!==entry.key)return
  matches++
  if(node.type.name==='heading')position=at
 })
 return matches===1?position:null
}
export function wordOutlineTransaction(state:EditorState,entry:WordOutlineEntry){
 const position=wordOutlinePosition(state.doc,entry)
 return position===null?null:state.tr.setSelection(TextSelection.create(state.doc,position+1)).setMeta('addToHistory',false)
}
