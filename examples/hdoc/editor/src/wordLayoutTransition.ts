import {readWordLayout,type WordLayout,type WordStory} from './wordRegions.ts'
import type {WordLayoutPending} from './wordCheckpointJournal.ts'

const ordered=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
const pages:Record<string,string>={widthTwips:'widthTwips',heightTwips:'heightTwips',orientation:'orientation',numberStart:'numberStart',numberFormat:'numberFormat'}
const margins:Record<string,string>={marginTop:'top',marginRight:'right',marginBottom:'bottom',marginLeft:'left',marginHeader:'header',marginFooter:'footer',marginGutter:'gutter'}

export type WordStoryUnlinkIntent={sectionId:string;kind:'header'|'footer';variant:'default'|'first'|'even';expectedInheritedStoryId:string|null}
/** Verify the topology of a coordinator-authenticated native receipt. This
 * check does not authenticate the receipt, compare content or migrate Yjs. */
export function matchesWordStoryUnlinkTransition(before:WordLayout,after:WordLayout,intent:WordStoryUnlinkIntent):boolean{
 try{
  readWordLayout({layout:before,layoutHash:'0'.repeat(64),revision:0},0,2)
  readWordLayout({layout:after,layoutHash:'0'.repeat(64),revision:0},0,2)
  if(before.schemaVersion!=='hcd-flow-layout/2'||after.schemaVersion!=='hcd-flow-layout/2'||!['header','footer'].includes(intent.kind)||!['default','first','even'].includes(intent.variant)||!(intent.expectedInheritedStoryId===null||typeof intent.expectedInheritedStoryId==='string'))return false
  if(after.stories.length!==before.stories.length+1)return false
  const story:WordStory=after.stories[after.stories.length-1],index=before.sections.findIndex(section=>section.id===intent.sectionId)
  if(index<0||story.kind!==intent.kind||before.stories.some(existing=>existing.id===story.id||existing.sourcePart===story.sourcePart)||before.sections.some(section=>section.id===story.id))return false
  const binding=(layout:WordLayout,i:number)=>intent.kind==='header'?layout.sections[i].headers:layout.sections[i].footers
  if(binding(before,index)[intent.variant]!==undefined)return false
  let inherited:string|null=null
  for(let i=index-1;i>=0;i--){const value=binding(before,i)[intent.variant];if(value!==undefined){inherited=value;break}}
  if(inherited!==intent.expectedInheritedStoryId)return false
  const expected=structuredClone(before)
  binding(expected,index)[intent.variant]=story.id;expected.stories.push(structuredClone(story))
  return ordered(expected)===ordered(after)
 }catch{return false}
}

/** Compare an authenticated native layout against a validated, immutable
 * layout-only request. This does not authenticate either projection and must
 * not itself acknowledge or clear a pending journal. */
export function matchesWordLayoutTransition(before:WordLayout,after:WordLayout,request:WordLayoutPending['request']):boolean{
 try{
  if(before.schemaVersion!=='hcd-flow-layout/2'||after.schemaVersion!=='hcd-flow-layout/2'||request.edits.schemaVersion!=='hcd-word-layout-edits/1'||!Array.isArray(request.edits.changes)||!request.edits.changes.length)return false
  const expected=structuredClone(before),seen=new Set<string>()
  for(const change of request.edits.changes){
   const field=change.field,key=`${change.sectionId??''}:${field}`
   if(seen.has(key)||change.expected===change.value)return false
   seen.add(key)
   if(field==='evenAndOddHeaders'){
    if(change.sectionId!==undefined||typeof change.value!=='boolean'||expected.evenAndOddHeaders!==change.expected)return false
    expected.evenAndOddHeaders=change.value;continue
   }
   const section=expected.sections.find(item=>item.id===change.sectionId)
   if(!section)return false
   if(field==='differentFirstPage'){
    if(typeof change.value!=='boolean'||section.differentFirstPage!==change.expected)return false
    section.differentFirstPage=change.value;continue
   }
   const page=section.page as Record<string,unknown>
   if(Object.hasOwn(pages,field)){
    const property=pages[field];if((page[property]??null)!==change.expected)return false
    if(change.value===null)delete page[property];else page[property]=change.value
   }else if(Object.hasOwn(margins,field)){
    const values={...(section.page.marginsTwips??{})} as Record<string,unknown>,property=margins[field]
    if((values[property]??null)!==change.expected)return false
    if(change.value===null)delete values[property];else values[property]=change.value
    if(Object.keys(values).length)page.marginsTwips=values;else delete page.marginsTwips
   }else return false
  }
  return ordered(expected)===ordered(after)
 }catch{return false}
}
