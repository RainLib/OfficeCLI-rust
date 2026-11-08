import {Extension} from '@tiptap/core'
import {Plugin,PluginKey,type Transaction} from '@tiptap/pm/state'
import {Decoration,DecorationSet,type EditorView} from '@tiptap/pm/view'

/** CSS pixels before the workspace zoom. This is a view, never a saved page map. */
export type WordFlowGeometry={bodyHeight:number;pageHeight:number;pageGap:number;scale:number}
export type WordFlowLayout={phase:'disabled'|'measuring'|'ready'|'unsupported';pages:number|null;reason?:'geometry'|'limit'|'atomic'|'unstable'|'browser'|'parity'|'break'}
type Options={geometry:()=>WordFlowGeometry|null;onLayout:(value:WordFlowLayout)=>void;maxPages:number;maxPasses:number}
type LayoutState={geometry:WordFlowGeometry|null;pages:number;decorations:DecorationSet}
export const wordPageFlowKey=new PluginKey<LayoutState>('hcd-word-page-flow/1')
export const wordPageFlowMeta='hcd-word-page-flow/1/layout'
const tolerance=.5
export function validWordFlowGeometry(value:WordFlowGeometry){return [value.bodyHeight,value.pageHeight,value.scale].every(number=>Number.isFinite(number)&&number>0)&&Number.isFinite(value.pageGap)&&value.pageGap>=0&&value.bodyHeight<=value.pageHeight&&value.scale>=.05&&value.scale<=8&&value.pageHeight<=20000&&value.pageGap<=2000}
/** First pass has no exclusions yet. Subsequent passes measure the laid-out
 * content against the physical page stride, not against the body height. */
export function wordFlowPageCount(bottom:number,geometry:WordFlowGeometry,hasExclusions:boolean){
 if(!validWordFlowGeometry(geometry)||!Number.isFinite(bottom)||bottom<0)throw Error('word-flow-geometry')
 // The last page has no following exclusion. Its usable end, rather than
 // its physical bottom, determines whether another page is necessary.
 return hasExclusions?1+Math.max(0,Math.ceil((bottom-geometry.bodyHeight-tolerance)/(geometry.pageHeight+geometry.pageGap))):Math.max(1,Math.ceil((bottom-tolerance)/geometry.bodyHeight))
}
function sameGeometry(a:WordFlowGeometry|null,b:WordFlowGeometry|null){return a===b||!!a&&!!b&&a.bodyHeight===b.bodyHeight&&a.pageHeight===b.pageHeight&&a.pageGap===b.pageGap&&a.scale===b.scale}
export function wordFlowLayoutTransaction(view:Pick<EditorView,'state'>,geometry:WordFlowGeometry|null,pages:number):Transaction{
 if(geometry&&!validWordFlowGeometry(geometry)||!Number.isSafeInteger(pages)||pages<1||pages>512)throw Error('word-flow-geometry')
 return view.state.tr.setMeta(wordPageFlowMeta,{geometry,pages}).setMeta('addToHistory',false)
}
function exclusions(geometry:WordFlowGeometry,pages:number){
 return Decoration.widget(0,()=>{
  const root=document.createElement('div');root.dataset.hcdWordPageFlow='true';root.contentEditable='false';root.setAttribute('aria-hidden','true');root.style.display='contents'
  for(let index=1;index<pages;index++){
   const exclusion=document.createElement('div');exclusion.dataset.hcdWordPageBreak=String(index)
   const stride=geometry.pageHeight+geometry.pageGap
   exclusion.style.cssText=`float:right;clear:both;position:relative;width:100%;height:${stride}px;margin:0;padding:0;border:0;shape-outside:inset(${geometry.bodyHeight}px 0 0);pointer-events:none;user-select:none`
   root.append(exclusion)
  }
  return root
 },{side:-1,key:JSON.stringify([geometry,pages]),ignoreSelection:true,stopEvent:()=>true})
}
/** Pagination only adds DOM exclusions. There are no page nodes, split
 * paragraphs, author changes or CRDT writes in this plugin. */
export function wordPageFlowPlugin(options:Options,expose:(request:()=>void)=>void=()=>{}){
 return new Plugin<LayoutState>({key:wordPageFlowKey,
  state:{init:()=>({geometry:null,pages:1,decorations:DecorationSet.empty}),apply(transaction,previous){
   const next=transaction.getMeta(wordPageFlowMeta) as {geometry:WordFlowGeometry|null;pages:number}|undefined
   if(next){const {geometry,pages}=next;return{geometry,pages,decorations:geometry?DecorationSet.create(transaction.doc,[exclusions(geometry,pages)]):DecorationSet.empty}}
   return transaction.docChanged?{...previous,decorations:previous.decorations.map(transaction.mapping,transaction.doc)}:previous
  }},
  props:{decorations:state=>wordPageFlowKey.getState(state)?.decorations,
   attributes:(state):Record<string,string>=>wordPageFlowKey.getState(state)?.geometry?{'data-hcd-word-paginated':'true',style:'display:flow-root'}:{}},
  view(view){
   let closed=false,frame=0,pass=0,dirty=true,geometry:WordFlowGeometry|null=null,last:WordFlowLayout|undefined,writing=false
   const publish=(value:WordFlowLayout)=>{if(JSON.stringify(last)!==JSON.stringify(value)){last=value;options.onLayout(value)}}
   const apply=(next:WordFlowGeometry|null,pages:number)=>{const state=wordPageFlowKey.getState(view.state)!;if(sameGeometry(state.geometry,next)&&state.pages===pages)return;writing=true;try{view.dispatch(wordFlowLayoutTransaction(view,next,pages))}finally{writing=false}}
   const fallback=(reason:NonNullable<WordFlowLayout['reason']>)=>{apply(null,1);publish({phase:'unsupported',pages:null,reason});dirty=false;pass=0}
   const schedule=()=>{if(!closed&&!frame)frame=requestAnimationFrame(measure)}
   const request=()=>{if(closed)return;dirty=true;pass=0;publish({phase:'measuring',pages:null});schedule()}
   const measure=()=>{
    frame=0;if(closed||!dirty)return
    if(view.composing){schedule();return}
    const next=options.geometry()
    if(!next){apply(null,1);publish({phase:'disabled',pages:null});dirty=false;return}
    if(!validWordFlowGeometry(next)){fallback('geometry');return}
    if(typeof CSS==='undefined'||!CSS.supports('shape-outside','inset(1px 0 0)')){fallback('browser');return}
    if(!sameGeometry(geometry,next)){geometry={...next};pass=0;apply(null,1)}
    // These existing node views have not acquired a pagination adapter yet.
    // Keep the complete continuous view rather than clipping their content or
    // entering an unbounded push-to-next-page loop.
    if(view.dom.querySelector('iframe,table,pre,.hcd-opaque,.hcd-word-opaque,.hcd-extension-block,.hcd-extension-container')){fallback('atomic');return}
    const state=wordPageFlowKey.getState(view.state)!,origin=view.dom.getBoundingClientRect().top
    let bottom=0
    for(const child of Array.from(view.dom.children)){
     if(child.hasAttribute('data-hcd-word-page-flow'))continue
     bottom=Math.max(bottom,(child.getBoundingClientRect().bottom-origin)/next.scale)
    }
    const pages=wordFlowPageCount(Math.max(0,bottom),next,!!state.geometry)
    if(pages>Math.min(512,options.maxPages)){fallback('limit');return}
    if(!state.geometry||pages!==state.pages){
     if(++pass>options.maxPasses){fallback('unstable');return}
     apply({...next},pages);schedule();return
    }
    dirty=false;pass=0;publish({phase:'ready',pages})
   }
   const resize=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(()=>{if(!dirty)request()});resize?.observe(view.dom)
   const contentLoaded=()=>request(),compositionEnded=()=>request()
   view.dom.addEventListener('load',contentLoaded,true);view.dom.addEventListener('compositionend',compositionEnded)
   const fonts=view.dom.ownerDocument.fonts;fonts?.addEventListener('loadingdone',contentLoaded)
   expose(request);request()
   return{update(current,previous){view=current;if(writing)return;if(!current.state.doc.eq(previous.doc)||!sameGeometry(geometry,options.geometry()))request()},destroy(){closed=true;cancelAnimationFrame(frame);resize?.disconnect();view.dom.removeEventListener('load',contentLoaded,true);view.dom.removeEventListener('compositionend',compositionEnded);fonts?.removeEventListener('loadingdone',contentLoaded);expose(()=>{})}}
  },
 })
}
export const WordPageFlow=Extension.create<Options>({
 name:'hcdWordPageFlow',addOptions(){return{geometry:()=>null,onLayout:()=>{},maxPages:512,maxPasses:12}},
 addStorage(){return{requestLayout:()=>{}}},
 addProseMirrorPlugins(){return[wordPageFlowPlugin(this.options,request=>{this.storage.requestLayout=request})]},
})
