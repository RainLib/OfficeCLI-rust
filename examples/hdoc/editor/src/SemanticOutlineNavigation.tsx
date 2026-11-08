import {useEffect,useMemo,useRef,useState} from 'react'
import {filterSemanticOutline,semanticOutlineExcerpt,type SemanticOutlineEntry} from './semanticOutline.ts'
import {useI18n} from './i18n.tsx'

const batch=80
export function SemanticOutlineNavigation({entries,onClose,onLocate,onInsert,canInsert=false}:{entries:readonly SemanticOutlineEntry[];onClose:()=>void;onLocate:(entry:SemanticOutlineEntry)=>void;onInsert?:()=>void;canInsert?:boolean}){
 const {t,locale}=useI18n(),root=useRef<HTMLElement|null>(null),tail=useRef<HTMLDivElement|null>(null),[query,setQuery]=useState(''),[limit,setLimit]=useState(batch)
 const filtered=useMemo(()=>filterSemanticOutline(entries,query,locale,t('untitledHeading')),[entries,query,locale,t]),visible=filtered.slice(0,limit),more=visible.length<filtered.length
 useEffect(()=>{if(!more||!tail.current||!root.current||typeof IntersectionObserver==='undefined')return;const observer=new IntersectionObserver(values=>{if(values.some(value=>value.isIntersecting))setLimit(value=>Math.min(filtered.length,value+batch))},{root:root.current,rootMargin:'120px'});observer.observe(tail.current);return()=>observer.disconnect()},[more,visible.length,filtered.length])
 return <aside ref={root} className="outline-panel" aria-label={t('outline')}><div className="panel-head"><h2>☷ {t('outline')}</h2><button type="button" className="panel-close" aria-label={t('hideOutline')} onClick={onClose}>×</button></div>
  <label className="semantic-outline-search">{t('wordOutlineSearch')}<input type="search" value={query} onChange={event=>{setQuery(event.target.value);setLimit(batch)}}/></label>
  {onInsert&&<><button type="button" className="semantic-outline-insert" disabled={!canInsert||!entries.length} onMouseDown={event=>event.preventDefault()} onClick={onInsert} title={t('wordOutlineSnapshotHint')}>{t('wordOutlineSnapshotInsert')}</button><p>{t('wordOutlineSnapshotHint')}</p></>}
  {visible.length?<nav>{visible.map(item=><button type="button" key={`${item.key??'position'}:${item.pos}`} className={`outline-level-${item.level}${query.trim()?' semantic-outline-match':''}`} onClick={()=>onLocate(item)} title={item.text||t('untitledHeading')}>{semanticOutlineExcerpt(item.text||t('untitledHeading'),query,locale)}</button>)}</nav>:<p>{t(query.trim()?'wordOutlineNoResults':'noOutline')}</p>}
  {more&&<div ref={tail}><button type="button" className="semantic-outline-more" onClick={()=>setLimit(value=>Math.min(filtered.length,value+batch))}>{t('wordOutlineMore',{shown:visible.length,total:filtered.length})}</button></div>}
 </aside>
}
