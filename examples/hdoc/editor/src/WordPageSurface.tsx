import {useCallback,useLayoutEffect,useMemo,useRef,useState,type ReactNode,type CSSProperties} from 'react'
import {wordPaperGeometry,wordPreviewVariant,wordVariantForSectionPage} from './wordPaper.ts'
import type {WordLayout,WordStory,WordStoryBindings} from './wordRegions.ts'
import type {WordFlowGeometry,WordFlowLayout} from './wordPageFlow.ts'
import {wordStoryMeasureKey,type WordBookSectionMetric} from './wordBook.ts'

export type WordPageFlowBinding={geometry:WordFlowGeometry|null;onLayout:(layout:WordFlowLayout)=>void}
type Props={
 layout:WordLayout;section:number;scale:number;editingStories:boolean;previewVariant:'first'|'default'|'even';numberStart?:number;activePage:number;breakPreview:boolean
 sources:Readonly<Record<string,HTMLElement>>;sizes:Readonly<Record<string,number>>;stories:readonly WordStory[];bindings:{headers:WordStoryBindings;footers:WordStoryBindings}
 renderBody:(flow:WordPageFlowBinding)=>ReactNode
 onBody:()=>void;onStory:(kind:'header'|'footer',variant:'first'|'default'|'even',id:string|undefined,page:number)=>void
 onMetric:(id:string,metric:WordBookSectionMetric)=>void;onElement:(id:string,element:HTMLElement|null)=>void
}
const gap=24
/** Page chrome and replicas are disposable views. Each story, including a
 * shared header, has exactly one live editor and one collaborative identity. */
export function WordPageSurface(props:Props){
 const paper=wordPaperGeometry(props.layout,props.section),[flow,setFlow]=useState<WordFlowLayout>({phase:'measuring',pages:null})
 const [bodyHeight,setBodyHeight]=useState(0),body=useRef<HTMLDivElement|null>(null),paperRef=useRef<HTMLElement|null>(null)
 useLayoutEffect(()=>{const element=body.current!;const measure=()=>{const height=element.getBoundingClientRect().height/props.scale;setBodyHeight(previous=>Math.abs(previous-height)<.5?previous:height)};const resize=new ResizeObserver(measure);resize.observe(element);measure();return()=>resize.disconnect()},[props.scale])
 const sectionId=props.layout.sections[props.section].id
 useLayoutEffect(()=>{props.onElement(sectionId,paperRef.current);return()=>props.onElement(sectionId,null)},[sectionId,props.onElement])
 const stories=props.stories,byId=useMemo(()=>new Map(stories.map(story=>[story.id,story])),[stories]),height=(id:string)=>props.sizes[wordStoryMeasureKey(id,paper.bodyWidth)]??0
 const headerHeight=Math.max(0,...stories.filter(story=>story.kind==='header').map(story=>height(story.id))),footerHeight=Math.max(0,...stories.filter(story=>story.kind==='footer').map(story=>height(story.id)))
 const top=Math.max(paper.top,paper.header+headerHeight),bottom=Math.max(paper.bottom,paper.footer+footerHeight)
 const parityKnown=props.numberStart!==undefined||!props.layout.evenAndOddHeaders||props.bindings.headers.default===props.bindings.headers.even&&props.bindings.footers.default===props.bindings.footers.even
 const geometry=useMemo<WordFlowGeometry>(()=>({bodyHeight:paper.height-top-bottom,pageHeight:paper.height,pageGap:gap,scale:props.scale}),[paper.height,top,bottom,props.scale])
 const latest=useRef({props,parityKnown});latest.current={props,parityKnown}
 const onLayout=useCallback((value:WordFlowLayout)=>{setFlow(previous=>{const next=value.phase==='measuring'&&previous.pages!==null?{...value,pages:previous.pages}:value;return JSON.stringify(previous)===JSON.stringify(next)?previous:next})},[])
 // Keep the last complete paper stack during a new measurement. Collapsing
 // to one page here moves a focused marginal editor and changes scrollTop.
 const ready=flow.pages!==null&&(flow.phase==='ready'||flow.phase==='measuring'),pages=ready?flow.pages!:1,stride=paper.height+gap,continuousHeight=Math.max(paper.height,bodyHeight)
 const preview=wordPreviewVariant(props.layout,props.section,props.previewVariant)
 const variants=useMemo(()=>Array.from({length:pages},(_,index)=>ready?wordVariantForSectionPage(props.layout,props.section,index,props.numberStart):preview),[pages,ready,props.layout,props.section,preview,props.numberStart])
 const selectedPage=Math.min(props.activePage,pages-1)
 useLayoutEffect(()=>{const reported:WordFlowLayout=flow.phase==='ready'&&props.breakPreview?{...flow,reason:'break'}:flow.phase==='ready'&&!parityKnown?{...flow,reason:'parity'}:flow;latest.current.props.onMetric(sectionId,{flow:reported,pages,height:ready?pages*stride-gap:continuousHeight})},[flow,parityKnown,props.breakPreview,sectionId,pages,stride,continuousHeight,ready])
 return <main ref={paperRef} data-word-section={sectionId} className={`word-page-book ${ready?'is-paginated':'is-continuous'}`} data-word-page-start={props.numberStart} data-word-page-count={ready?pages:undefined} data-word-page-phase={flow.phase} style={{width:paper.width,minHeight:paper.height,...(ready?{height:pages*stride-gap}:{})}}>
  <div className="word-page-sheets" aria-hidden="true">{variants.map((variant,index)=><div key={index} className="word-page-sheet" data-word-page={index+1} data-word-page-number={props.numberStart!==undefined&&props.numberStart+index<=2_147_483_647?props.numberStart+index:undefined} style={{top:index*stride,height:ready?paper.height:continuousHeight}}>{(['header','footer'] as const).map(kind=>{
   const shown=props.editingStories&&index===selectedPage?preview:variant==='unknown'?wordPreviewVariant(props.layout,props.section,index===0?'first':props.previewVariant==='even'?'even':'default'):variant
   const storyId=(kind==='header'?props.bindings.headers:props.bindings.footers)[shown],story=storyId?byId.get(storyId):undefined
   const live=props.editingStories&&index===selectedPage
   return <section key={kind} className={`word-page-replica ${kind}`} style={{left:paper.left,right:paper.right,...(kind==='header'?{top:paper.header,minHeight:Math.max(24,top-paper.header)}:{bottom:paper.footer,minHeight:Math.max(24,bottom-paper.footer)})}} onDoubleClick={()=>props.onStory(kind,shown,story?.id,index)}>{story&&!live&&<WordStoryReplica source={props.sources[story.id]}/>}</section>
  })}</div>)}</div>
  <div ref={body} className={`word-page-flow-body ${props.editingStories?'inactive':''}`} style={{marginLeft:paper.left,marginRight:paper.right,paddingTop:top,paddingBottom:bottom}} onDoubleClick={props.onBody}>{props.renderBody({geometry,onLayout})}</div>

 </main>
}
export function WordStoryTemplate({id,source,active,style,children}:{id:string;source:(id:string,element:HTMLElement|null)=>void;active:boolean;style:CSSProperties;children:ReactNode}){
 const ref=useRef<HTMLDivElement|null>(null)
 useLayoutEffect(()=>{source(id,ref.current);return()=>source(id,null)},[id,source])
 return <div ref={ref} className={`word-page-live-story ${active?'is-active':''}`} style={style} aria-hidden={!active} inert={!active}>{children}</div>
}
/** Copy the already-sanitized node views, never a second editor. Source views
 * own blob URLs and stay mounted for the lifetime of these replicas. */
export function WordStoryReplica({source}:{source:HTMLElement|undefined}){
 const ref=useRef<HTMLDivElement|null>(null)
 useLayoutEffect(()=>{
  const target=ref.current!;if(!source){target.replaceChildren();return}
  let frame=0
  const copy=()=>{frame=0;const original=source.querySelector('.tiptap');if(!original){target.replaceChildren();return}const clone=original.cloneNode(true) as HTMLElement
   clone.querySelectorAll('.collaboration-carets__caret,[data-hcd-word-page-flow]').forEach(node=>node.remove())
   for(const element of [clone,...clone.querySelectorAll<HTMLElement>('*')]){element.removeAttribute('id');element.removeAttribute('contenteditable');element.removeAttribute('tabindex');element.removeAttribute('autofocus');if(element.getAttribute('role')==='textbox')element.removeAttribute('role')}
   target.replaceChildren(clone)
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(copy)},observer=new MutationObserver(schedule);observer.observe(source,{childList:true,subtree:true,characterData:true,attributes:true});copy()
  return()=>{observer.disconnect();cancelAnimationFrame(frame);target.replaceChildren()}
 },[source])
 return <div ref={ref} className="word-page-story-copy word-region-rich" inert/>
}
