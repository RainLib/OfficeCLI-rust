import {forwardRef,useCallback,useImperativeHandle,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react'
import {WordPageSurface,WordStoryReplica,WordStoryTemplate,type WordPageFlowBinding} from './WordPageSurface.tsx'
import {wordBookNumbering,wordBookPageIndex,wordBookStoryUses,wordStoryMeasureKey,type WordBookSectionMetric} from './wordBook.ts'
import {wordPaperGeometry,wordPreviewVariant,wordStoryForVariant,wordVariantForSectionPage} from './wordPaper.ts'
import type {WordLayout,WordStory} from './wordRegions.ts'
import type {WordFlowLayout} from './wordPageFlow.ts'
import {wordSectionViewportProgress} from './wordBookPresence.ts'

export type WordBookViewport={book:1;sectionId:string;regionId:string;variant:'first'|'default'|'even';paperIndex:number;paperProgress:number;sectionProgress:number}
export type WordBookHandle={locateSection:(index:number,progress?:number,paperIndex?:number)=>void;viewport:()=>WordBookViewport|null;editingLocation:()=>{sectionId:string;variant:'first'|'default'|'even';paperIndex:number}}
type Props={layout:WordLayout;section:number;scale:number;editingStories:boolean;previewVariant:'first'|'default'|'even';activeRegion?:string;scroll:HTMLElement|null;initialPaperIndex?:number
 renderBody:(id:string,flow:WordPageFlowBinding)=>ReactNode;renderStory:(story:WordStory)=>ReactNode
 onBody:(index:number)=>void;onStory:(index:number,kind:'header'|'footer',variant:'first'|'default'|'even',id:string|undefined)=>void
 onLayout:(value:WordFlowLayout)=>void;onViewSection:(index:number)=>void}
/** One continuously scrollable book. Body editors belong to sections; marginal
 * editors belong to stories and are never duplicated for inherited uses. */
export const WordBookSurface=forwardRef<WordBookHandle,Props>(function WordBookSurface(props,ref){
 const uses=useMemo(()=>wordBookStoryUses(props.layout),[props.layout]),needed=useMemo(()=>new Set(uses.flatMap(use=>[...use.ids])),[uses])
 const stories=useMemo(()=>props.layout.stories.filter(story=>needed.has(story.id)),[props.layout,needed])
 const sectionStories=useMemo(()=>{const byId=new Map(stories.map(story=>[story.id,story]));return uses.map(use=>[...use.ids].map(id=>byId.get(id)).filter((story):story is WordStory=>!!story))},[uses,stories])
 const [sources,setSources]=useState<Record<string,HTMLElement>>({}),[sizes,setSizes]=useState<Record<string,number>>({}),[metrics,setMetrics]=useState<ReadonlyMap<string,WordBookSectionMetric>>(()=>new Map()),[positions,setPositions]=useState<Record<string,{top:number;left:number}>>({}),[selected,setSelected]=useState<{sectionId:string;page:number}|null>(()=>({sectionId:props.layout.sections[props.section].id,page:wordBookPageIndex(props.initialPaperIndex,512)}))
 const elements=useRef(new Map<string,HTMLElement>()),observer=useRef<ResizeObserver|null>(null),frame=useRef(0)
 const numbering=useMemo(()=>wordBookNumbering(props.layout,metrics),[props.layout,metrics]),paper=wordPaperGeometry(props.layout,props.section)
 const widths=uses.map(use=>use.width),maxWidth=Math.max(...props.layout.sections.map((_section,index)=>wordPaperGeometry(props.layout,index).width)),maxBodyWidth=Math.max(...widths)
 const measurements=useMemo(()=>{const result=new Map<string,{id:string;width:number}>();for(const use of uses)for(const id of use.ids)result.set(wordStoryMeasureKey(id,use.width),{id,width:use.width});return[...result]},[uses])
 const latest=useRef({props,metrics,numbering,sources,selected});latest.current={props,metrics,numbering,sources,selected}
 const measurePositions=useCallback(()=>{frame.current=0;const next:Record<string,{top:number;left:number}>={};for(const[id,element]of elements.current)next[id]={top:element.offsetTop,left:element.offsetLeft};setPositions(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next)},[])
 const schedule=useCallback(()=>{if(!frame.current)frame.current=requestAnimationFrame(measurePositions)},[measurePositions])
 const element=useCallback((id:string,node:HTMLElement|null)=>{const old=elements.current.get(id);if(old)observer.current?.unobserve(old);if(node){elements.current.set(id,node);observer.current?.observe(node)}else elements.current.delete(id);schedule()},[schedule])
 useLayoutEffect(()=>{const resize=new ResizeObserver(schedule);observer.current=resize;for(const node of elements.current.values())resize.observe(node);schedule();return()=>{observer.current=null;resize.disconnect();cancelAnimationFrame(frame.current);frame.current=0}},[schedule])
 const metric=useCallback((id:string,value:WordBookSectionMetric)=>setMetrics(previous=>{if(JSON.stringify(previous.get(id))===JSON.stringify(value))return previous;const next=new Map(previous);next.set(id,value);return next}),[])
 useLayoutEffect(measurePositions,[metrics,measurePositions])
 const source=useCallback((id:string,node:HTMLElement|null)=>setSources(previous=>{if(previous[id]===node||!node&&!previous[id])return previous;const next={...previous};if(node)next[id]=node;else delete next[id];return next}),[])
 const size=useCallback((key:string,value:number)=>setSizes(previous=>Math.abs((previous[key]??0)-value)<.5?previous:{...previous,[key]:value}),[])
 const currentId=props.layout.sections[props.section].id,currentMetric=metrics.get(currentId),pages=currentMetric?.pages??1
 const preview=wordPreviewVariant(props.layout,props.section,props.previewVariant)
 const selectedPage=wordBookPageIndex(selected?.sectionId===currentId?selected.page:0,pages)
 useLayoutEffect(()=>{if(!props.editingStories||currentMetric?.flow.phase!=='ready'||wordVariantForSectionPage(props.layout,props.section,selectedPage,numbering[props.section]?.start)===preview)return;for(let index=0;index<pages;index++)if(wordVariantForSectionPage(props.layout,props.section,index,numbering[props.section]?.start)===preview){setSelected({sectionId:currentId,page:index});break}},[props.editingStories,props.layout,props.section,currentId,selectedPage,preview,pages,numbering,currentMetric])
 useLayoutEffect(()=>{props.onLayout(currentMetric?.flow??{phase:'measuring',pages:null})},[props.onLayout,currentMetric])
 const visibleSection=()=>{
  const current=latest.current,scroll=current.props.scroll;if(!scroll)return current.props.section
  const viewport=scroll.getBoundingClientRect();let chosen=current.props.section,best=-1
  current.props.layout.sections.forEach((section,index)=>{const box=elements.current.get(section.id)?.getBoundingClientRect();if(!box)return;const area=Math.max(0,Math.min(box.bottom,viewport.bottom)-Math.max(box.top,viewport.top));if(area>best){best=area;chosen=index}})
  return chosen
 }
 useImperativeHandle(ref,()=>({
  locateSection(index,progress=0,paperIndex){const current=latest.current,scroll=current.props.scroll,section=current.props.layout.sections[index];if(!scroll||!section)return;const node=elements.current.get(section.id);if(!node)return
   if(paperIndex!==undefined)setSelected({sectionId:section.id,page:wordBookPageIndex(paperIndex,512)})
   const box=node.getBoundingClientRect(),viewport=scroll.getBoundingClientRect(),ratio=Number.isFinite(progress)?Math.max(0,Math.min(1,progress)):0
   const paper=wordPaperGeometry(current.props.layout,index),offset=paperIndex===undefined?ratio*Math.max(0,box.height-scroll.clientHeight):(wordBookPageIndex(paperIndex,current.metrics.get(section.id)?.pages??1)*(paper.height+24)+ratio*paper.height)*current.props.scale
   scroll.scrollTo({top:Math.max(0,scroll.scrollTop+box.top-viewport.top+offset),behavior:'auto'})
  },
  viewport(){const current=latest.current,scroll=current.props.scroll;if(!scroll)return null
   const index=visibleSection(),section=current.props.layout.sections[index],node=elements.current.get(section.id);if(!node)return null
   const viewport=scroll.getBoundingClientRect(),box=node.getBoundingClientRect(),geometry=wordPaperGeometry(current.props.layout,index),pages=current.metrics.get(section.id)?.pages??1
   const paperIndex=wordBookPageIndex(Math.floor(Math.max(0,viewport.top-box.top)/((geometry.height+24)*current.props.scale)),pages),variant=wordVariantForSectionPage(current.props.layout,index,paperIndex,current.numbering[index]?.start)
   const active=current.props.activeRegion?current.sources[current.props.activeRegion]:undefined,activeBox=active?.getBoundingClientRect()
   if(current.props.editingStories&&activeBox&&activeBox.bottom>viewport.top&&activeBox.top<viewport.bottom){const containing=elements.current.get(current.props.layout.sections[current.props.section].id)?.getBoundingClientRect();return{book:1,sectionId:current.props.layout.sections[current.props.section].id,regionId:current.props.activeRegion!,variant:current.props.previewVariant,paperIndex:wordBookPageIndex(current.selected?.sectionId===current.props.layout.sections[current.props.section].id?current.selected.page:0,current.metrics.get(current.props.layout.sections[current.props.section].id)?.pages??1),paperProgress:0,sectionProgress:containing?wordSectionViewportProgress(containing.top,containing.height,viewport.top,viewport.height):0}}
   const inside=Math.max(0,(viewport.top-box.top)/current.props.scale)-paperIndex*(geometry.height+24),paperProgress=Math.max(0,Math.min(1,inside/geometry.height))
   return{book:1,sectionId:section.id,regionId:section.id,variant:variant==='unknown'?'default':variant,paperIndex,paperProgress,sectionProgress:wordSectionViewportProgress(box.top,box.height,viewport.top,viewport.height)}
  },
  editingLocation(){const current=latest.current,section=current.props.layout.sections[current.props.section];return{sectionId:section.id,variant:current.props.previewVariant,paperIndex:wordBookPageIndex(current.selected?.sectionId===section.id?current.selected.page:0,current.metrics.get(section.id)?.pages??1)}},
 }),[])
 useLayoutEffect(()=>{const scroll=props.scroll;if(!scroll)return;let pending=0;const report=()=>{pending=0;if(!latest.current.props.editingStories)latest.current.props.onViewSection(visibleSection())};const schedule=()=>{if(!pending)pending=requestAnimationFrame(report)};scroll.addEventListener('scroll',schedule,{passive:true});return()=>{scroll.removeEventListener('scroll',schedule);cancelAnimationFrame(pending)}},[props.scroll])
 const selectedStories={header:wordStoryForVariant(props.layout,props.section,'header',preview),footer:wordStoryForVariant(props.layout,props.section,'footer',preview)},position=positions[currentId]??{top:0,left:(maxWidth-paper.width)/2}
 return <div className={`word-book-stack ${props.editingStories?'is-story-editing':''}`} data-word-book="1" style={{width:maxWidth,zoom:props.scale}}>
  {props.layout.sections.map((section,index)=><WordPageSurface key={section.id} layout={props.layout} section={index} scale={props.scale} editingStories={props.editingStories&&index===props.section} previewVariant={index===props.section?props.previewVariant:'first'} numberStart={numbering[index]?.start} breakPreview={numbering[index]?.reason==='break'} activePage={index===props.section?selectedPage:0} sources={sources} sizes={sizes} stories={sectionStories[index]} bindings={uses[index]} onMetric={metric} onElement={element} renderBody={flow=>props.renderBody(section.id,flow)} onBody={()=>props.onBody(index)} onStory={(kind,variant,id,page)=>{setSelected({sectionId:section.id,page});props.onStory(index,kind,variant,id)}}/>) }
  {stories.map(story=>{const active=props.editingStories&&selectedStories[story.kind]?.id===story.id,height=sizes[wordStoryMeasureKey(story.id,paper.bodyWidth)]??24,top=position.top+selectedPage*(paper.height+24)+(story.kind==='header'?paper.header:(currentMetric?.flow.phase==='unsupported'?currentMetric.height:paper.height)-paper.footer-height)
   return <WordStoryTemplate key={story.id} id={story.id} source={source} active={active} style={{left:active?position.left+paper.left:0,top:active?top:0,width:active?paper.bodyWidth:maxBodyWidth}}>{props.renderStory(story)}</WordStoryTemplate>
  })}
  {measurements.map(([key,value])=><WordStoryMeasure key={key} identity={key} source={sources[value.id]} width={value.width} scale={props.scale} onSize={size}/>)}
 </div>
})
function WordStoryMeasure({identity,source,width,scale,onSize}:{identity:string;source:HTMLElement|undefined;width:number;scale:number;onSize:(key:string,height:number)=>void}){
 const ref=useRef<HTMLDivElement|null>(null)
 useLayoutEffect(()=>{const element=ref.current!,measure=()=>onSize(identity,element.getBoundingClientRect().height/scale),observer=new ResizeObserver(measure);observer.observe(element);measure();return()=>observer.disconnect()},[identity,scale,onSize])
 return <div ref={ref} className="word-book-story-measure word-page-replica" style={{width}} aria-hidden="true" inert><WordStoryReplica source={source}/></div>
}
