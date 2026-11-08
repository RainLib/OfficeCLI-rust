import {wordRegionSections} from './wordRegions.ts'
import {boundedAsyncPool} from './boundedAsyncPool.ts'
import type {PageGroup,RenderedPage} from './fixedPages.ts'
import type {FixedPeer} from './FixedPresence.tsx'
import type {WordLayout,WordStory} from './wordRegions.ts'
export type WordPageVariant='first'|'even'|'default'|'unknown'
/** A shared story can appear on many pages. Only show a peer badge where its
 * viewport establishes the containing section and physical page. */
export function wordPeerOnPaper(peer:FixedPeer,bodySequence:number,pageNumber:number,revision:number):boolean{
 const selection=peer.selection,view=peer.viewport
 if(!selection||!view||view.page!==bodySequence||view.revision!==undefined&&view.revision!==revision)return false
 if(view.wordPage!==undefined)return view.wordPage===pageNumber
 // Older clients do not report physical Word pages. Only body text can be
 // located by its own group and visible geometry; shared stories are ambiguous.
 return selection.page===bodySequence
}
/** The regional editor's page selector previews a first, odd, or even page;
 * Word uses the default story when that page-specific mode is not enabled. */
export function wordPreviewVariant(layout:WordLayout,sectionIndex:number,choice:'first'|'even'|'default'):'first'|'even'|'default'{
 const section=layout.sections[sectionIndex]
 if(choice==='first'&&section?.differentFirstPage)return 'first'
 if(choice==='even'&&layout.evenAndOddHeaders)return 'even'
 return 'default'
}
/** Shared bindings include other variants in the same section and variants
 * that are currently disabled but may become visible after layout changes. */
export function wordStoryIsShared(layout:WordLayout,story:WordStory|undefined):boolean{
 if(!story)return false
 return wordRegionSections(layout,{id:story.id,kind:story.kind,sourcePart:story.sourcePart}).reduce((count,use)=>count+use.variants.length,0)>1
}
/** A mounted editor can outlive the page or editing mode that selected it. */
export function wordRegionIsActive(regionId:string|undefined,sectionId:string,headerId:string|undefined,footerId:string|undefined,editingStories:boolean){
 return !!regionId&&(editingStories?regionId===headerId||regionId===footerId:regionId===sectionId)
}
/** A later section without an explicit restart inherits the preceding page
 * count. This independently paginated preview cannot infer that count. */
export function wordVariantForSectionPage(layout:WordLayout,sectionIndex:number,pageIndex:number,measuredStart?:number):WordPageVariant{
 const section=layout.sections[sectionIndex];if(!section)return 'unknown'
 if(pageIndex===0&&section.differentFirstPage)return 'first'
 if(!layout.evenAndOddHeaders)return 'default'
 const known=Number.isSafeInteger(measuredStart)&&measuredStart!>=0&&measuredStart!<=2_147_483_647?measuredStart:undefined
 const start=section.page.numberStart??(sectionIndex===0?1:known)
 return start===undefined?'unknown':(start+pageIndex)%2===0?'even':'default'
}
export function wordStoryForVariant(layout:WordLayout,sectionIndex:number,kind:'header'|'footer',variant:WordPageVariant):WordStory|undefined{
 if(variant==='unknown'||!layout.sections[sectionIndex])return
 for(let index=sectionIndex;index>=0;index--){const id=(kind==='header'?layout.sections[index].headers:layout.sections[index].footers)[variant];if(id!==undefined)return layout.stories.find(story=>story.id===id&&story.kind===kind)}
}
/** Unknown parity is harmless for one region when both possibilities resolve
 * to the same story (or both are absent). Header and footer are independent. */
export function wordStoryForPreview(layout:WordLayout,sectionIndex:number,kind:'header'|'footer',variant:WordPageVariant):{story:WordStory|undefined;ambiguous:boolean}{
 if(!layout.sections[sectionIndex])return{story:undefined,ambiguous:true}
 if(variant!=='unknown')return{story:wordStoryForVariant(layout,sectionIndex,kind,variant),ambiguous:false}
 const normal=wordStoryForVariant(layout,sectionIndex,kind,'default'),even=wordStoryForVariant(layout,sectionIndex,kind,'even')
 return normal?.id===even?.id?{story:normal,ambiguous:false}:{story:undefined,ambiguous:true}
}
/** A section can paginate independently only when parity is known or both
 * possible marginal bindings are identical. Otherwise retain its explicit
 * variant preview until the book supplies preceding section page counts. */
export function wordSectionPageParityKnown(layout:WordLayout,sectionIndex:number,measuredStart?:number){
 if(wordVariantForSectionPage(layout,sectionIndex,1,measuredStart)!=='unknown')return true
 return (['header','footer'] as const).every(kind=>!wordStoryForPreview(layout,sectionIndex,kind,'unknown').ambiguous)
}
/** Pagination reserves the largest story that can actually occur in the
 * section, including inherited bindings and either possible parity. Disabled
 * first/even variants must not consume body space. */
export function wordMeasuredStoryIds(layout:WordLayout,sectionIndex:number):Set<string>{
 const section=layout.sections[sectionIndex];if(!section)return new Set()
 const variants:Array<'default'|'first'|'even'>=['default']
 if(section.differentFirstPage)variants.push('first')
 if(layout.evenAndOddHeaders)variants.push('even')
 const ids=new Set<string>()
 for(const kind of ['header','footer'] as const)for(const variant of variants){const story=wordStoryForVariant(layout,sectionIndex,kind,variant);if(story)ids.add(story.id)}
 return ids
}
/** Match Word's variant selection exactly. An absent first/even story is blank;
 * default is not a fallback for another variant. */
export function wordStoryForPage(layout:WordLayout,sectionIndex:number,kind:'header'|'footer',first:boolean,pageNumber:number):WordStory|undefined{
 const section=layout.sections[sectionIndex];if(!section)return
 const variant=first&&section.differentFirstPage?'first':layout.evenAndOddHeaders&&pageNumber%2===0?'even':'default'
 return wordStoryForVariant(layout,sectionIndex,kind,variant)
}
/** Old servers lack region identities; preserve their complete scan. */
export function wordStoryGroupsForSection(groups:PageGroup[],layout:WordLayout,sectionIndex:number,locationPage?:number):PageGroup[]{
 const stories=groups.filter(group=>group.region==='header'||group.region==='footer')
 if(stories.some(group=>!group.wordRegionsVerified||!group.wordRegionId))return stories
 const required=wordMeasuredStoryIds(layout,sectionIndex)
 return stories.filter(group=>required.has(group.wordRegionId!)||locationPage!==undefined&&group.sequences.includes(locationPage))
}
/** Bound marginal-story requests. Stale navigation stops launching more work;
 * the shared page loader owns already-started requests and their cache. */
export function loadWordPageStories(groups:PageGroup[],revision:number,load:(group:PageGroup,revision:number)=>Promise<RenderedPage>,signal:AbortSignal){
 const stories=groups.filter(group=>group.region==='header'||group.region==='footer')
 return boundedAsyncPool(stories.map(group=>async taskSignal=>{taskSignal.throwIfAborted();const page=await load(group,revision);taskSignal.throwIfAborted();if(group.wordRegionsVerified&&page.wordRegion?.id!==group.wordRegionId)throw new Error('word-region-index-mismatch');return {group,page}}),signal)
}
export function wordPaperGeometry(layout:WordLayout,sectionIndex:number){
 const page=layout.sections[sectionIndex].page,m=page.marginsTwips??{}
 const width=(page.widthTwips??11906)/15,height=(page.heightTwips??16838)/15
 const left=Math.max(0,(m.left??1440)/15),right=Math.max(0,(m.right??1440)/15)
 const top=Math.max(0,(m.top??1440)/15),bottom=Math.max(0,(m.bottom??1440)/15)
 return{width,height,left,right,top,bottom,header:Math.max(0,(m.header??720)/15),footer:Math.max(0,(m.footer??720)/15),bodyWidth:Math.max(48,width-left-right),bodyHeight:Math.max(48,height-top-bottom)}
}

export function wordPaperFormat(width:number,height:number):'A4'|'Letter'|undefined{
 const [short,long]=[width*15,height*15].sort((a,b)=>a-b)
 if(Math.abs(short-11906)<10&&Math.abs(long-16838)<10)return 'A4'
 if(Math.abs(short-12240)<10&&Math.abs(long-15840)<10)return 'Letter'
}

/** Marginal story IDs are not page IDs. Resolve its containing body section
 * before history/follow navigation; shared stories prefer the visible section. */
export async function wordBodyGroup(group:PageGroup,revision:number,layout:WordLayout,groups:PageGroup[],load:(group:PageGroup,revision:number)=>Promise<RenderedPage>,preferredPage?:number,signal?:AbortSignal){
 return wordBodyGroupFromIndex(group,revision,layout,()=>groups,()=>true,async()=>{},load,preferredPage,signal)
}

/** Resolve against the current index, including pages loaded after an async
 * location request started. Do not read later metadata after cancellation. */
export async function wordBodyGroupFromIndex(group:PageGroup,revision:number,layout:WordLayout,groups:()=>PageGroup[],complete:()=>boolean,loadMore:(signal?:AbortSignal)=>Promise<void>,load:(group:PageGroup,revision:number)=>Promise<RenderedPage>,preferredPage?:number,signal?:AbortSignal){
 if(group.region==='body')return group
 const check=()=>{if(signal?.aborted)throw new Error('Aborted')};check()
 const story=await load(group,revision);check()
 const uses=story.wordRegion?wordRegionSections(layout,story.wordRegion):[]
 if(!uses.length)throw new Error('fixedLocationUnavailable')
 const sectionIds=new Set(uses.map(use=>layout.sections[use.section-1].id))
 const visited=new Set<number>()
 for(;;){
  const candidates=groups().filter(value=>value.region==='body'&&!visited.has(value.firstSequence)).sort((a,b)=>Number(b.firstSequence===preferredPage)-Number(a.firstSequence===preferredPage))
  for(const candidate of candidates){
   check();visited.add(candidate.firstSequence)
   // New indexes bind each body group to a verified region. Avoid reading
   // every unrelated section; old indexes still require the complete scan.
   if(candidate.wordRegionsVerified&&candidate.wordRegionId&&!sectionIds.has(candidate.wordRegionId))continue
   const body=await load(candidate,revision);check()
   if(candidate.wordRegionsVerified&&candidate.wordRegionId&&(body.wordRegion?.id!==candidate.wordRegionId||body.wordRegion.kind!=='body'||body.wordRegion.sourcePart!=='word/document.xml'))throw new Error('word-region-index-mismatch')
   if(body.wordRegion?.kind==='body'&&body.wordRegion.sourcePart==='word/document.xml'&&body.wordRegion.id&&sectionIds.has(body.wordRegion.id))return candidate
  }
  check();if(complete())throw new Error('fixedLocationUnavailable')
  await loadMore(signal);check()
 }
}

/** A shared header/footer may belong to several sections. Presence carries
 * its containing section as context; the region alone cannot identify paper. */
export function wordPresenceLocation(layout:WordLayout,regionId:unknown,sectionId:unknown,variant:unknown){
 if(typeof regionId!=='string')return null
 const body=layout.sections.findIndex(section=>section.id===regionId)
 if(body>=0)return{section:body,stories:false,variant:undefined}
 const story=layout.stories.find(story=>story.id===regionId);if(!story)return null
 const uses=wordRegionSections(layout,{id:story.id,kind:story.kind,sourcePart:story.sourcePart}),preferred=layout.sections.findIndex(section=>section.id===sectionId),use=uses.find(use=>use.section===preferred+1)??uses[0]
 if(!use)return null
 return{section:use.section-1,stories:true,variant:use.variants.find(value=>value===variant)??use.variants[0]}
}
