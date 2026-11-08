import {useEffect,useRef,useState} from 'react'
import type {WordRegionStore} from './wordRegionStore.ts'
import type {WordLayout} from './wordRegions.ts'
import {wordOutline,type WordOutlineEntry} from './wordOutline.ts'
import {useI18n} from './i18n.tsx'

const batch=80
export function WordOutlineNavigation({model,layout,section,current,onSection,onLocate,onClose,onInsert,canInsert}:{model:WordRegionStore;layout:WordLayout;section:number;current:string|null;onSection:(index:number)=>void;onLocate:(entry:WordOutlineEntry)=>void;onClose:()=>void;onInsert:()=>void;canInsert:boolean}){
 const {t,locale}=useI18n(),root=useRef<HTMLElement|null>(null),tail=useRef<HTMLDivElement|null>(null)
 const [entries,setEntries]=useState<WordOutlineEntry[]>([]),[query,setQuery]=useState(''),[limit,setLimit]=useState(batch),[failed,setFailed]=useState(false),[hasHeadings,setHasHeadings]=useState(false)
 useEffect(()=>{
  let frame=0,closed=false,last=''
  const update=()=>{frame=0;if(closed)return;try{let has=false;const next=wordOutline(layout,model.structure.project(),{search:{term:query,locale,untitled:t('untitledHeading')},onHeading:()=>{has=true}}),stamp=JSON.stringify(next);if(stamp!==last){last=stamp;setEntries(next)}setHasHeadings(has);setFailed(false)}catch{setEntries([]);setHasHeadings(false);setFailed(true)}}
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(update)}
  model.document.on('update',schedule);schedule()
  return()=>{closed=true;cancelAnimationFrame(frame);model.document.off('update',schedule)}
 },[model,layout,query,locale,t])
 const filtered=entries
 const visible=filtered.slice(0,limit),more=visible.length<filtered.length,sections=new Map(layout.sections.map((value,index)=>[value.id,index]))
 useEffect(()=>{
  if(!more||!tail.current||!root.current||typeof IntersectionObserver==='undefined')return
  const observer=new IntersectionObserver(values=>{if(values.some(value=>value.isIntersecting))setLimit(value=>Math.min(filtered.length,value+batch))},{root:root.current,rootMargin:'120px'})
  observer.observe(tail.current);return()=>observer.disconnect()
 },[more,visible.length,filtered.length])
 return <aside ref={root} className="word-region-navigation" aria-label={t('outline')}>
  <div className="word-outline-heading"><h2>{t('outline')}</h2><button type="button" aria-label={t('hideOutline')} onClick={onClose}>×</button></div>
  <nav aria-label={t('wordSections')} className="word-outline-sections">{layout.sections.map((entry,index)=><button type="button" key={entry.id} aria-current={index===section?'page':undefined} onClick={()=>onSection(index)}>{t('wordSection',{count:index+1})}</button>)}</nav>
  <label className="word-outline-search">{t('wordOutlineSearch')}<input type="search" value={query} onChange={event=>{setQuery(event.target.value);setLimit(batch)}}/></label>
  <button type="button" disabled={!canInsert||failed||!hasHeadings} onClick={onInsert} title={t('wordOutlineSnapshotHint')}>{t('wordOutlineSnapshotInsert')}</button><p>{t('wordOutlineSnapshotHint')}</p>
  {failed?<p role="status">{t('wordOutlineUnavailable')}</p>:<><ol className="word-outline-list">{visible.map(entry=><li key={entry.key}><button type="button" aria-current={current===entry.key?'location':undefined} style={{paddingInlineStart:8+(entry.level-1)*10}} onClick={()=>onLocate(entry)} title={entry.text||t('untitledHeading')}><small>{t('wordSection',{count:(sections.get(entry.sectionId)??0)+1})}</small><span>{entry.text||t('untitledHeading')}</span></button></li>)}</ol>{!filtered.length&&<p>{t(query?'wordOutlineNoResults':'noOutline')}</p>}{more&&<div ref={tail}><button type="button" className="word-outline-more" onClick={()=>setLimit(value=>value+batch)}>{t('wordOutlineMore',{shown:visible.length,total:filtered.length})}</button></div>}</>}
 </aside>
}
