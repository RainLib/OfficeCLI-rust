import {createPortal} from 'react-dom'
import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import {useI18n} from './i18n.tsx'
import {pageDocument,type PageGroup,type RenderedPage,type createPageLoader} from './fixedPages.ts'
import {wordRegionSections,type WordLayout} from './wordRegions.ts'
import {loadWordPageStories,wordStoryGroupsForSection,wordMeasuredStoryIds,wordPaperGeometry,wordStoryForPreview,wordVariantForSectionPage,wordPeerOnPaper} from './wordPaper.ts'
import type {TextDraftStore} from './textDrafts.ts'
import type {FixedPeer,FixedSelection} from './FixedPresence.tsx'

type Located={group:PageGroup;page:RenderedPage}
type Region='body'|'header'|'footer'
/** One physical page of the selected semantic section. Browser columns paginate
 * one continuous body DOM, so chunk boundaries do not become page breaks. */
export function WordPageCanvas({loaded,active,pages,loader,layout,stylesheet,drafts,scale,editable,peers,onInteraction,onSelection,onUndoRedo,onStopCapture,location,requestedPage,onPage,initialPage,editingRegion:mode,onEditingRegion:setMode,pending,onImage,tools,onPageCount,onSave}:{
 loaded:RenderedPage;active:PageGroup;pages:PageGroup[];loader:ReturnType<typeof createPageLoader>;layout:WordLayout;stylesheet:string;drafts:TextDraftStore;scale:number;editable:boolean;peers:FixedPeer[]
 onSave:()=>void;tools:HTMLElement|null;onPageCount:(count:number)=>void;pending:boolean;onImage:(page:number,nodeId:string)=>void;initialPage:number;editingRegion:Region;onEditingRegion:(region:Region)=>void;requestedPage?:number;onPage:(page:number)=>void;location?:FixedSelection;onInteraction:()=>void;onSelection:(selection:FixedSelection)=>void;onUndoRedo:(direction:'undo'|'redo')=>void;onStopCapture:()=>void
}){
 const {t,locale}=useI18n(),generation=useSyncExternalStore(drafts.subscribe,drafts.snapshot)
 const frame=useRef<HTMLIFrameElement>(null),cleanup=useRef<()=>void>(()=>{}),refresh=useRef<()=>void>(()=>{})
 const pendingLastPage=useRef(requestedPage===-1)
 const [content,setContent]=useState<{key:string;body:Located;stories:Located[]}|null>(null),[error,setError]=useState(false),[attempt,setAttempt]=useState(0)
 const [storyNotice,setStoryNotice]=useState<'header'|'footer'|'parity'|null>(null)
 const [pageIndex,setPageIndex]=useState(Math.max(0,(requestedPage===undefined?initialPage:requestedPage)-1))
 const sectionIndex=wordRegionSections(layout,loaded.wordRegion!)[0]?.section??1
 const section=layout.sections[sectionIndex-1],geometry=wordPaperGeometry(layout,sectionIndex-1)
 const relevant=wordStoryGroupsForSection(pages,layout,sectionIndex-1,location?.page)
 const key=`${loaded.revision}:${active.firstSequence}:${location?.page??''}:${(loaded.wordRegion?.kind==='body'?relevant:pages).map(page=>`${page.sequences.join(',')}:${page.wordRegionId??''}:${page.wordRegionsVerified??false}`).join(';')}`
 useEffect(()=>{
  let live=true;const cancellation=new AbortController();setError(false)
  void(async()=>{
   let body:Located|undefined=loaded.wordRegion?.kind==='body'?{group:active,page:loaded}:undefined
   if(!body)for(const group of pages.filter(group=>group.region==='body')){const page=await loader(group,loaded.revision);if(!live)return;if(page.wordRegion?.id===section.id){body={group,page};break}}
   if(!body)throw new Error('Missing section body')
   const stories=await loadWordPageStories(wordStoryGroupsForSection(pages,layout,sectionIndex-1,location?.page),loaded.revision,loader,cancellation.signal)
   if(!live)return
   for(const value of [body,...stories])drafts.reconcile(value.page.runs,loaded.revision)
   setContent({key,body,stories})
  })().catch(()=>{if(live)setError(true)})
  return()=>{live=false;cancellation.abort()}
 },[key,loader,loaded,layout,attempt])
 const previousSection=useRef(active.firstSequence)
 useEffect(()=>{if(previousSection.current!==active.firstSequence){previousSection.current=active.firstSequence;setPageIndex(0)}},[active.firstSequence])
 useEffect(()=>{if(requestedPage!==undefined){pendingLastPage.current=requestedPage===-1;setPageIndex(requestedPage===-1?0:Math.max(0,requestedPage-1))}},[requestedPage])
 useEffect(()=>{onPage(pageIndex+1)},[pageIndex,onPage])
 const current=content?.key===key?content:null
 const variant=wordVariantForSectionPage(layout,sectionIndex-1,pageIndex)
 const headerResult=wordStoryForPreview(layout,sectionIndex-1,'header',variant),footerResult=wordStoryForPreview(layout,sectionIndex-1,'footer',variant),header=headerResult.story,footer=footerResult.story,ambiguous=headerResult.ambiguous||footerResult.ambiguous
 useEffect(()=>{if(!location||!current)return;const value=[current.body,...current.stories].find(value=>value.group.sequences.includes(location.page));if(value)setMode(value.page.wordRegion?.kind??'body')},[location,current])
 const headerPage=current?.stories.find(value=>value.page.wordRegion?.id===header?.id),footerPage=current?.stories.find(value=>value.page.wordRegion?.id===footer?.id)
 useEffect(()=>{setStoryNotice(null)},[sectionIndex,pageIndex])
 useEffect(()=>{if(current&&((mode==='header'&&!headerPage)||(mode==='footer'&&!footerPage)))setMode('body')},[current,mode,headerPage,footerPage,setMode])
 const activate=(region:Region,target?:Element|null)=>{
  onInteraction()
  if(region!=='body'){
   const result=region==='header'?headerResult:footerResult,page=region==='header'?headerPage:footerPage
   if(!page){setStoryNotice(result.ambiguous?'parity':region);return}
  }
  setStoryNotice(null);setMode(region);requestAnimationFrame(()=>{refresh.current();const element=target?.closest<HTMLElement>('[data-hcd-node-hash][contenteditable]')??frame.current?.contentDocument?.querySelector<HTMLElement>(`[data-part="${region}"] [contenteditable]`);element?.focus()})
 }
 const caption=(kind:'header'|'footer')=>`${t(kind==='header'?'headerRegion':'footerRegion')} · ${t('wordSection',{count:sectionIndex})} · ${t(variant==='first'?'wordFirstPageVariant':variant==='even'?'wordEvenPageVariant':variant==='unknown'?'wordParityUnknownLabel':'wordDefaultPages')}${variant!=='unknown'&&(kind==='header'?header:footer)&&(kind==='header'?section.headers:section.footers)[variant]===undefined?` · ${t('wordLinkedPrevious')}`:''}`
 const labels={body:t('wordBodyRegion'),header:caption('header'),footer:caption('footer')}
 const source=useMemo(()=>{
  if(!current)return ''
  const {width,height,left,right,top,bottom,bodyWidth,bodyHeight}=geometry
  const css=`html,body{width:${width}px!important;height:${height}px!important;margin:0!important;padding:0!important;overflow:hidden!important;background:white}#word-paper{position:relative;width:${width}px;height:${height}px;color:#1b263b} .word-part{position:absolute;z-index:2;left:${left}px;right:${right}px;box-sizing:border-box;outline:0}.word-part[data-part=header]{top:${geometry.header}px;min-height:26px;overflow:visible}.word-part[data-part=footer]{bottom:${geometry.footer}px;min-height:26px;overflow:visible}.word-body-window{position:absolute;left:${left}px;top:${top}px;width:${bodyWidth}px;height:${bodyHeight}px;overflow:hidden}#word-body{position:relative;width:${bodyWidth}px;height:${bodyHeight}px;column-width:${bodyWidth}px;column-gap:0;column-fill:auto;transition:none}#word-body>div,#word-body section{display:contents}.word-part>div,.word-part section,.word-measure>div,.word-measure section{display:contents}.word-measure{position:absolute;visibility:hidden;pointer-events:none;left:-100000px;width:${bodyWidth}px;height:auto}.word-part:before{position:absolute;right:0;top:0;transform:none;font:11px/18px system-ui;color:#7b8595;white-space:nowrap;content:attr(data-label);pointer-events:none;visibility:hidden}.word-part[data-part=header],.word-part[data-part=footer]{border-bottom:1px dashed transparent;cursor:default}.word-part:hover{border-color:#ccd5e2}.word-part:hover:before,.word-part[data-active=true]:before{visibility:visible}.word-part[data-active=true]{border-color:#6496df}.word-part[data-active=true]:before{color:#3975c8}[data-hcd-node-hash][contenteditable]{white-space:pre-wrap;outline:0;min-width:2px;cursor:text}[data-hcd-node-hash][contenteditable]:empty{display:inline-block;min-width:12px;min-height:1em}[data-hcd-node-hash][contenteditable]:focus{background:#f0f6ff;outline:1px solid #acc9f0}[data-hcd-node-hash][data-peer]{box-shadow:0 2px var(--peer-color)}[data-peer-name]{position:absolute;z-index:3;pointer-events:none;color:white;font:10px/16px system-ui;padding:0 3px;border-radius:2px;white-space:nowrap}.word-body-window[data-dimmed=true]{opacity:.42}[data-hcd-word-field-path]{cursor:default;background:#f2f3f5} .word-part:not([data-active=true]) .word-unbound{visibility:hidden}.word-unbound{font:11px/22px system-ui;color:#9aa5b7} p{orphans:2;widows:2}img{max-width:100%;height:auto}`
  const measuredIds=wordMeasuredStoryIds(layout,sectionIndex-1)
  const measurements=current.stories.filter(value=>{const region=value.page.wordRegion;if(!region)return false;const id=region.id??layout.stories.find(story=>story.kind===region.kind&&story.sourcePart===region.sourcePart)?.id;return !!id&&measuredIds.has(id)}).map(value=>{const root=new DOMParser().parseFromString(value.page.html,'text/html').body;for(const element of root.querySelectorAll('*'))for(const attribute of Array.from(element.attributes))if(attribute.name.startsWith('data-hcd-')||attribute.name==='id')element.removeAttribute(attribute.name);return `<aside class="word-measure" aria-hidden="true" data-story-kind="${value.page.wordRegion!.kind}">${root.innerHTML}</aside>`}).join('')
  const raw={...current.body.page,html:`<main id="word-paper">${measurements}<section class="word-part" data-part="header">${headerPage?.page.html??`<span class="word-unbound">${t(headerResult.ambiguous?'wordParityUnknown':'wordNoHeader')}</span>`}</section><div class="word-body-window"><div id="word-body" data-part="body">${current.body.page.html}</div></div><section class="word-part" data-part="footer">${footerPage?.page.html??`<span class="word-unbound">${t(footerResult.ambiguous?'wordParityUnknown':'wordNoFooter')}</span>`}</section></main>`}
  return pageDocument(raw,`${stylesheet}\n${css}`,locale)
 },[current,headerPage,footerPage,stylesheet,locale,layout,sectionIndex,headerResult.ambiguous,footerResult.ambiguous,geometry.width,geometry.height,geometry.left,geometry.right,geometry.top,geometry.bottom,geometry.header,geometry.footer,geometry.bodyWidth,geometry.bodyHeight])
 const context=useRef({mode,pageIndex,editable,peers,current,headerPage,footerPage,onInteraction,onSelection,onUndoRedo,onStopCapture,onImage,onSave,onPageCount,labels,activate});context.current={mode,pageIndex,editable,peers,current,headerPage,footerPage,onInteraction,onSelection,onUndoRedo,onStopCapture,onImage,onSave,onPageCount,labels,activate}
 useEffect(()=>{refresh.current()},[generation,mode,pageIndex,editable,peers,source,labels.header,labels.footer])
 useEffect(()=>()=>cleanup.current(),[])
 if(error)return <div className="presentation-load-error" role="alert">{t('wordLayoutUnavailable')} <button onClick={()=>setAttempt(value=>value+1)}>{t('retry')}</button></div>
 if(!current)return <div className="presentation-empty">{t('loadingSection')}</div>
 return <>{tools&&createPortal(<><button className="presentation-ribbon-tool" aria-pressed={mode==='header'} aria-label={t('wordEditHeader')} title={t(headerResult.ambiguous?'wordParityUnknown':'wordPaperHint')} onClick={()=>activate('header')}>{t('headerRegion')}</button><button className="presentation-ribbon-tool" aria-pressed={mode==='footer'} aria-label={t('wordEditFooter')} title={t(footerResult.ambiguous?'wordParityUnknown':'wordPaperHint')} onClick={()=>activate('footer')}>{t('footerRegion')}</button>{mode!=='body'&&<button className="presentation-ribbon-tool" onClick={()=>activate('body')}>{t('wordCloseStories')}</button>}<span className="presentation-tool-caption">{t('wordHeaderFooter')}</span>{ambiguous&&<span className="word-parity-notice" role="status">{t('wordParityUnknown')}</span>}</>,tools)}<div className="word-page-workspace" style={{minWidth:geometry.width*scale+48}}>
  {storyNotice&&<div className="word-region-error word-paper-notice" role="status">{t(storyNotice==='parity'?'wordParityUnknown':storyNotice==='header'?'wordMissingHeaderNotice':'wordMissingFooterNotice')} <button type="button" aria-label={t('close')} onClick={()=>setStoryNotice(null)}>×</button></div>}
  {drafts.entries().filter(([,draft])=>draft.remote||draft.stale).map(([id,draft])=><div className="presentation-conflict" role="alert" key={id}><p>{t(draft.stale?'draftNeedsRefresh':'textDraftConflict')}</p><blockquote>{draft.text}</blockquote>{draft.remote&&!draft.stale&&<><blockquote>{draft.remote.text}</blockquote><button disabled={pending||!editable} onClick={()=>drafts.resolve(draft.remote!,loaded.revision,false)}>{t('useRemoteText')}</button><button disabled={pending||!editable} onClick={()=>drafts.resolve(draft.remote!,loaded.revision,true)}>{t('keepLocalText')}</button></>}{draft.stale&&<button disabled={pending} onClick={()=>drafts.discard(id)}>{t('discardDraftText')}</button>}</div>)}
  <div className="word-paper-space" style={{width:geometry.width*scale,height:geometry.height*scale}}>
   <iframe ref={frame} title={t('wordPaperCanvas')} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={source} style={{width:geometry.width,height:geometry.height,transform:`scale(${scale})`}} onLoad={()=>{
    cleanup.current();const document=frame.current?.contentDocument;if(!document?.body)return
    const body=document.getElementById('word-body')!,window=document.querySelector<HTMLElement>('.word-body-window')!
    const runs=new Map([context.current.current?.body,context.current.headerPage,context.current.footerPage].flatMap(value=>value?value.page.runs.map(run=>[run.nodeId,{run,value}] as const):[]))
    const runFor=(element:Element|null)=>{const node=element?.closest<HTMLElement>('[data-hcd-node-hash]'),found=runs.get(node?.getAttribute('data-hcd-id')??'');return node&&found?{node,...found}:undefined}
    let composing=false,closed=false
    const measure=()=>{if(closed||context.current.current?.key!==key||document.hidden||body.clientWidth<1||body.clientHeight<1)return;const total=Math.max(1,Math.ceil((body.scrollWidth-1)/geometry.bodyWidth)),last=pendingLastPage.current;pendingLastPage.current=false;context.current.onPageCount(total);setPageIndex(value=>last?total-1:Math.min(value,total-1))}
    refresh.current=()=>{
     for(const part of document.querySelectorAll<HTMLElement>('[data-part]')){const kind=part.dataset.part as Region;part.dataset.active=String(kind===context.current.mode);if(kind==='header'||kind==='footer')part.dataset.label=context.current.labels[kind]}
     window.dataset.dimmed=String(context.current.mode!=='body')
     // Reserve the largest bound story in this section for every column. A
     // first/even/default switch must never change body break positions.
     let headerHeight=26,footerHeight=26
     for(const element of document.querySelectorAll<HTMLElement>('.word-measure')){if(element.dataset.storyKind==='header')headerHeight=Math.max(headerHeight,element.scrollHeight);else footerHeight=Math.max(footerHeight,element.scrollHeight)}
     const bodyTop=Math.max(geometry.top,geometry.header+headerHeight+12),bodyBottom=Math.max(geometry.bottom,geometry.footer+footerHeight+12)
     window.style.top=`${bodyTop}px`;window.style.height=`${Math.max(48,geometry.height-bodyTop-bodyBottom)}px`;body.style.height=window.style.height
     // scrollLeft preserves DOM coordinates/selection unlike cloning each page.
     window.scrollLeft=context.current.pageIndex*geometry.bodyWidth
     for(const element of document.querySelectorAll<HTMLElement>('[data-hcd-node-hash]')){
      const found=runFor(element);if(!found)continue
      const text=drafts.get(found.run.nodeId)?.text??drafts.currentRun(found.run,loaded.revision).text
      if(element!==document.activeElement&&element.textContent!==text)element.textContent=text
      const enabled=context.current.editable&&element.closest('[data-part]')?.getAttribute('data-part')===context.current.mode
      if(enabled){element.setAttribute('contenteditable','plaintext-only');element.setAttribute('role','textbox');element.setAttribute('aria-label',`${context.current.labels[context.current.mode]} · ${found.run.text.slice(0,28)||t('emptyTextObject')}`)}else{element.removeAttribute('contenteditable');element.removeAttribute('role');element.removeAttribute('aria-label')}
      element.removeAttribute('data-peer')
     }
     document.querySelectorAll('[data-peer-name]').forEach(node=>node.remove())
     const groups=new Map<string,FixedPeer[]>()
     for(const peer of context.current.peers){if(!wordPeerOnPaper(peer,active.firstSequence,context.current.pageIndex+1,loaded.revision)||!peer.selection)continue;const found=runs.get(peer.selection.nodeId);if(!found||found.value.group.firstSequence!==peer.selection.page)continue;const entries=groups.get(peer.selection.nodeId)??[];entries.push(peer);groups.set(peer.selection.nodeId,entries)}
     for(const [id,peers]of groups){const element=Array.from(document.querySelectorAll<HTMLElement>('[data-hcd-node-hash]')).find(element=>element.getAttribute('data-hcd-id')===id);if(!element)continue;const rect=element.getClientRects()[0];if(!rect||rect.right<geometry.left||rect.left>geometry.width-geometry.right)continue;const color=/^#[a-f0-9]{6}$/i.test(peers[0].color)?peers[0].color:'#3478c0';element.dataset.peer='true';element.style.setProperty('--peer-color',color);const badge=document.createElement('span');badge.dataset.peerName='true';badge.textContent=peers.map(peer=>peer.name).join(' · ');badge.style.cssText=`left:${Math.max(0,rect.left)}px;top:${Math.max(0,rect.top-16)}px;background:${color}`;document.body.append(badge)}
     measure()
    }
    const select=(event:Event)=>{const image=(event.target as Element)?.closest('[data-hcd-node-hash]'),imageId=image?.getAttribute('data-hcd-id');if(imageId){const part=[context.current.current?.body,context.current.headerPage,context.current.footerPage].find(value=>value?.page.images.some(value=>value.nodeId===imageId));if(part){context.current.onImage(part.group.firstSequence,imageId);return}}const found=runFor(event.target as Element);if(found){if(found.value.page.wordRegion?.kind==='body'&&context.current.mode!=='body')setMode('body');context.current.onSelection({page:found.value.group.firstSequence,nodeId:found.run.nodeId,kind:'text'})}}
    const interact=()=>context.current.onInteraction()
    const doubleClick=(event:MouseEvent)=>{const region=(event.target as Element)?.closest('[data-part]')?.getAttribute('data-part') as Region|undefined;if(region)context.current.activate(region,event.target as Element)}
    const input=(event:Event)=>{if(composing)return;const found=runFor(event.target as Element);if(found&&found.node.isContentEditable)drafts.edit(found.run,loaded.revision,found.node.innerText,found.value.group.firstSequence);measure()}
    const compositionStart=()=>{composing=true},compositionEnd=(event:Event)=>{composing=false;input(event)}
    const onKeyDown=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();context.current.onSave();return}if(event.key==='Escape'){event.preventDefault();setMode('body')}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();context.current.onStopCapture();context.current.onUndoRedo(event.shiftKey?'redo':'undo')}}
    const blur=()=>context.current.onStopCapture()
    const links=(event:MouseEvent)=>{if((event.target as Element)?.closest('a'))event.preventDefault()}
    for(const event of ['pointerdown','wheel','touchstart','keydown'])document.addEventListener(event,interact,{capture:true,passive:true})
    document.addEventListener('focusin',select);document.addEventListener('click',select);document.addEventListener('click',links);document.addEventListener('dblclick',doubleClick);document.addEventListener('input',input);document.addEventListener('keydown',onKeyDown);document.addEventListener('focusout',blur);document.addEventListener('compositionstart',compositionStart);document.addEventListener('compositionend',compositionEnd)
    const imageLoaded=()=>refresh.current();document.addEventListener('visibilitychange',imageLoaded);const observer=new ResizeObserver(()=>refresh.current());observer.observe(body);for(const image of document.images)image.addEventListener('load',imageLoaded)
    refresh.current()
    cleanup.current=()=>{closed=true;document.removeEventListener('visibilitychange',imageLoaded);observer.disconnect();refresh.current=()=>{};for(const event of ['pointerdown','wheel','touchstart','keydown'])document.removeEventListener(event,interact,true);document.removeEventListener('focusin',select);document.removeEventListener('click',select);document.removeEventListener('click',links);document.removeEventListener('dblclick',doubleClick);document.removeEventListener('input',input);document.removeEventListener('keydown',onKeyDown);document.removeEventListener('focusout',blur);document.removeEventListener('compositionstart',compositionStart);document.removeEventListener('compositionend',compositionEnd);for(const image of document.images)image.removeEventListener('load',imageLoaded)}
   }}/>
  </div>
 </div></>
}
