import {checkpointContents} from './checkpointSnapshot.ts'
import type {RevisionChangeRow,RevisionSelection} from './revisionSelection.ts'
import type {Block,BlockContent,Inline,Projection} from './schema.ts'
export type RevisionDifference={before?:Block;after?:Block;oldIndex?:number;newIndex?:number;kind:'same'|'added'|'removed'|'modified';moved:boolean;textChanged:boolean;formatChanged:boolean;objectChanged:boolean}
export type TextDifference={kind:'same'|'added'|'removed';text:string}
const revisionInlineText=(inline:Inline):string=>inline.content?inline.content.inlines.map(revisionInlineText).join(''):inline.hardBreak?'\n':inline.text
export function revisionBlockText(content:BlockContent):string{return content.inlines.map(revisionInlineText).join('')+(content.children?.length?'\n'+content.children.map(revisionBlockText).join('\n'):'')}
function signature(block:Block){return block.region+'\n'+checkpointContents([{blockId:null,content:block.content}])+'\n'+objectSignature(block)}
function objectSignature(block:Block){return(block.readOnlyHtml??'').replace(/\sdata-hcd-(?:id|node-hash|block-id|source-path|run-index)="[^"]*"/g,'')}
function retained(pairs:Array<{old:number;next:number}>){
 const tails:number[]=[],previous:number[]=[]
 pairs.forEach((pair,index)=>{let low=0,high=tails.length;while(low<high){const middle=(low+high)>>1;if(pairs[tails[middle]].old<pair.old)low=middle+1;else high=middle}previous[index]=low?tails[low-1]:-1;tails[low]=index})
 const result=new Set<number>();for(let index=tails.at(-1)??-1;index>=0;index=previous[index])result.add(pairs[index].next);return result
}
/** Stable IDs first, then semantic anchors. No whole-document text matrix.
 * Only the block sequences are read, so callers may pass partial surfaces
 * without claiming a full network Projection. */
export function revisionDifferences(before:{blocks:Block[]},after:{blocks:Block[]}):RevisionDifference[]{
 const old=before.blocks,next=after.blocks,paired=new Map<number,number>(),used=new Set<number>(),ids=new Map(old.map((block,index)=>[block.blockId,index]))
 next.forEach((block,index)=>{const found=ids.get(block.blockId);if(found!==undefined&&!used.has(found)){paired.set(index,found);used.add(found)}})
 const content=new Map<string,number[]>()
 old.forEach((block,index)=>{if(!used.has(index)){const key=signature(block),entries=content.get(key)??[];entries.push(index);content.set(key,entries)}})
 const offsets=new Map<string,number>()
 next.forEach((block,index)=>{if(paired.has(index))return;const key=signature(block),entries=content.get(key),offset=offsets.get(key)??0,found=entries?.[offset];if(found!==undefined){paired.set(index,found);used.add(found);offsets.set(key,offset+1)}})
 const anchors=retained([...paired].sort(([a],[b])=>a-b).map(([next,old])=>({old,next})))
 // Pair replacements only inside an unchanged ordering gap, not across it.
 let oldStart=0,newStart=0
 for(const boundary of [...anchors].sort((a,b)=>a-b).concat(next.length)){
  const oldEnd=paired.get(boundary)??old.length,a:number[]=[],b:number[]=[]
  for(let index=oldStart;index<oldEnd;index++)if(!used.has(index))a.push(index)
  for(let index=newStart;index<boundary;index++)if(!paired.has(index))b.push(index)
  for(let index=0;index<Math.min(a.length,b.length);index++){paired.set(b[index],a[index]);used.add(a[index])}
  oldStart=oldEnd+1;newStart=boundary+1
 }
 const stable=retained([...paired].sort(([a],[b])=>a-b).map(([next,old])=>({old,next}))),result:RevisionDifference[]=[],removed=old.map((_block,index)=>index).filter(index=>!used.has(index));let deleted=0
 next.forEach((block,newIndex)=>{
  const oldIndex=paired.get(newIndex)
  if(oldIndex!==undefined)while(deleted<removed.length&&removed[deleted]<oldIndex){const index=removed[deleted++];result.push({before:old[index],oldIndex:index,kind:'removed',moved:false,textChanged:true,formatChanged:false,objectChanged:false})}
  if(oldIndex===undefined){result.push({after:block,newIndex,kind:'added',moved:false,textChanged:true,formatChanged:false,objectChanged:false});return}
  const previous=old[oldIndex],textChanged=revisionBlockText(previous.content)!==revisionBlockText(block.content),formatChanged=checkpointContents([{blockId:null,content:previous.content}])!==checkpointContents([{blockId:null,content:block.content}])&&!textChanged,objectChanged=objectSignature(previous)!==objectSignature(block),same=signature(previous)===signature(block)
  result.push({before:previous,after:block,oldIndex,newIndex,kind:same?'same':'modified',moved:!stable.has(newIndex),textChanged,formatChanged,objectChanged})
 })
 while(deleted<removed.length){const index=removed[deleted++];result.push({before:old[index],oldIndex:index,kind:'removed',moved:false,textChanged:true,formatChanged:false,objectChanged:false})}
 return result
}
/** Semantic-flow adapter: folds a Projection pair into the neutral review
 * contract. Row text is captured eagerly so the mounted UI stays format-free. */
export function semanticRevisionSelection(before:Projection,after:Projection,meta:{author?:string;createdAt?:number}={}):RevisionSelection{
 const changes:RevisionChangeRow[]=revisionDifferences(before,after).map(diff=>({kind:diff.kind,moved:diff.moved,formatChanged:diff.formatChanged,objectChanged:diff.objectChanged,oldIndex:diff.oldIndex,newIndex:diff.newIndex,beforeText:diff.before?revisionBlockText(diff.before.content):'',afterText:diff.after?revisionBlockText(diff.after.content):''}))
 return {target:before.revision,comparedWith:after.revision,...meta,changes}
}
/** Word/Chinese token diff, with a bounded matrix and a linear fallback for
 * very large paragraphs. Internal IDs never appear as a content change. */
export function revisionTextDifference(before:string,after:string):TextDifference[]{
 if(before===after)return[{kind:'same',text:before}]
 const tokens=(text:string)=>text.match(/[\p{Script=Han}]|[\p{L}\p{N}_]+|\s+|[^\s]/gu)??[],a=tokens(before),b=tokens(after),out:TextDifference[]=[]
 const push=(kind:TextDifference['kind'],text:string)=>{if(!text)return;const previous=out.at(-1);if(previous?.kind===kind)previous.text+=text;else out.push({kind,text})}
 if(a.length*b.length>262144){let start=0,endA=a.length,endB=b.length;while(start<endA&&start<endB&&a[start]===b[start])start++;while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--}push('same',a.slice(0,start).join(''));push('removed',a.slice(start,endA).join(''));push('added',b.slice(start,endB).join(''));push('same',a.slice(endA).join(''));return out}
 const width=b.length+1,table=new Uint32Array((a.length+1)*width)
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)table[i*width+j]=a[i]===b[j]?1+table[(i+1)*width+j+1]:Math.max(table[(i+1)*width+j],table[i*width+j+1])
 let i=0,j=0
 while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j]){push('same',a[i++]);j++}else if(j<b.length&&(i===a.length||table[i*width+j+1]>table[(i+1)*width+j]))push('added',b[j++]);else push('removed',a[i++])}
 return out
}
