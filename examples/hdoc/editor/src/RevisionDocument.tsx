import {wordRegionVersion} from './wordRegions.ts'
import {useEffect,useMemo,useRef,useState} from 'react'
import {api,type Session} from './api.ts'
import {createPageLoader,pageDocument,type Manifest,type Descriptor,type RenderedPage} from './fixedPages.ts'
import {FlowCanvas} from './FlowCanvas.tsx'
import {useI18n} from './i18n.tsx'
import type {HistoricalReferenceNavigation} from './ReferencePanel.tsx'
type Snapshot={revision:number;stylesheet:string;descriptors:Descriptor[];manifest:Manifest;loader:ReturnType<typeof createPageLoader>}
/** Read immutable native chunks, including their versioned assets. This does
 * not mount an editable Tiptap/Yjs document or reuse the live editor state. */
export function RevisionDocument({session,revision,referenceNavigation,onReferenceLocated}:{session:Session;revision:number;referenceNavigation?:HistoricalReferenceNavigation;onReferenceLocated?:(requestId:string,found:boolean)=>void}){
 const {locale,t}=useI18n(),[snapshot,setSnapshot]=useState<Snapshot|null>(null),[error,setError]=useState(false),[indexPage,setIndexPage]=useState(0),tail=useRef<HTMLDivElement>(null)
 useEffect(()=>{
  const controller=new AbortController();setSnapshot(null);setError(false);setIndexPage(0)
  void Promise.all([api(session,`?revision=${revision}`,{signal:controller.signal}).then(response=>response.json()),api(session,`/styles?revision=${revision}`,{signal:controller.signal}).then(response=>response.text())]).then(([manifest,stylesheet]:[Manifest,string])=>{
   if(manifest.revision!==revision||!Number.isSafeInteger(manifest.indexPageCount)||manifest.indexPageCount<0)throw new Error('Snapshot revision differs')
   if(!controller.signal.aborted)setSnapshot({revision,stylesheet,manifest,descriptors:[],loader:createPageLoader({...session,flowLayoutVersion:wordRegionVersion(manifest)},locale,controller.signal)})
  }).catch(()=>{if(!controller.signal.aborted)setError(true)})
  return()=>controller.abort()
 },[session,revision,locale])
 useEffect(()=>{
  if(!snapshot||indexPage>=snapshot.manifest.indexPageCount)return
  const controller=new AbortController()
  const load=()=>{void api(session,`/index/${indexPage}?revision=${revision}`,{signal:controller.signal}).then(response=>response.json()).then((index:{revision:number;chunks:Descriptor[]})=>{
   if(index.revision!==revision)throw new Error('Index revision differs')
   if(!controller.signal.aborted){setSnapshot(previous=>previous&&previous.revision===revision?{...previous,descriptors:[...previous.descriptors,...index.chunks]}:previous);setIndexPage(indexPage+1)}
  }).catch(()=>{if(!controller.signal.aborted)setError(true)})}
  if(indexPage===0||referenceNavigation?.revision===revision&&indexPage<=referenceNavigation.indexPage){load();return()=>controller.abort()}
  const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();load()}},{rootMargin:'1200px'})
  if(tail.current)observer.observe(tail.current)
  return()=>{observer.disconnect();controller.abort()}
 },[session,revision,snapshot?.manifest,indexPage,referenceNavigation])
 useEffect(()=>{if(referenceNavigation&&snapshot&&(referenceNavigation.chunkSequence>=snapshot.manifest.chunkCount||referenceNavigation.indexPage>=snapshot.manifest.indexPageCount||indexPage>=snapshot.manifest.indexPageCount&&!snapshot.descriptors.some(item=>item.sequence===referenceNavigation.chunkSequence)))onReferenceLocated?.(referenceNavigation.requestId,false)},[referenceNavigation,snapshot,indexPage])
 if(error)return <p role="alert">{t('revisionPreviewUnavailable')}</p>
 if(!snapshot)return <p role="status">{t('loadingRevision')}</p>
 return <section className="hcd-revision-document" aria-label={t('revisionContent',{revision})}>{snapshot.descriptors.map(descriptor=><RevisionChunk key={descriptor.sequence} snapshot={snapshot} descriptor={descriptor} referenceNavigation={referenceNavigation?.revision===revision&&referenceNavigation.chunkSequence===descriptor.sequence?referenceNavigation:undefined} onReferenceLocated={onReferenceLocated}/>)}<div ref={tail}/>{indexPage<snapshot.manifest.indexPageCount&&<p role="status">{t('loadingRevision')}</p>}</section>
}
function RevisionChunk({snapshot,descriptor,referenceNavigation,onReferenceLocated}:{snapshot:Snapshot;descriptor:Descriptor;referenceNavigation?:HistoricalReferenceNavigation;onReferenceLocated?:(requestId:string,found:boolean)=>void}){
 const {locale,t}=useI18n(),root=useRef<HTMLDivElement>(null),[page,setPage]=useState<RenderedPage|null>(null),[height,setHeight]=useState(300),[width,setWidth]=useState(650),[failed,setFailed]=useState(false)
 useEffect(()=>{
  let alive=true;const load=()=>{void snapshot.loader({firstSequence:descriptor.sequence,region:descriptor.region,sequences:[descriptor.sequence]},snapshot.revision).then(value=>{if(alive)setPage(value)}).catch(()=>{if(alive){setFailed(true);if(referenceNavigation)onReferenceLocated?.(referenceNavigation.requestId,false)}})}
  if(referenceNavigation){load();return()=>{alive=false}}
  const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();load()}},{rootMargin:'900px'})
  if(root.current)observer.observe(root.current)
  return()=>{alive=false;observer.disconnect()}
 },[snapshot.loader,snapshot.revision,descriptor.sequence,descriptor.region,referenceNavigation])
 useEffect(()=>{const observer=new ResizeObserver(entries=>{const value=Math.floor(entries[0]?.contentRect.width??0);if(value>0)setWidth(value)});if(root.current)observer.observe(root.current);return()=>observer.disconnect()},[])
 const source=useMemo(()=>page?pageDocument(page,snapshot.stylesheet,locale):'',[page,snapshot.stylesheet,locale])
 return <div ref={root} className="hcd-revision-chunk" style={{minHeight:page?undefined:300}}>{failed?<p role="alert">{t('revisionPreviewUnavailable')}</p>:page?<FlowCanvas srcDoc={source} title={t('revisionSection',{revision:snapshot.revision,section:descriptor.sequence+1})} width={width} height={height} scale={1} referenceNavigation={referenceNavigation} onReferenceLocated={onReferenceLocated} selected="" onSelect={()=>{}} onHeight={setHeight}/>:<p>{t('loadingRevision')}</p>}</div>
}
