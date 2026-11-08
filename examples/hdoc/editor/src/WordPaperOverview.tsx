import {useEffect,useId,useRef,useState} from 'react'
import {useI18n} from './i18n.tsx'
import {wordPaperFormat,wordPaperGeometry} from './wordPaper.ts'
import type {WordLayout} from './wordRegions.ts'
import {WordPageSetup,type WordPageSetupSubmit} from './WordPageSetup.tsx'

export const wordPaperOverviewPageSize=40
export function wordPaperOverviewPage(total:number,section:number|null){
 const index=section===null||!Number.isSafeInteger(section)?0:Math.max(0,Math.min(section,Math.max(0,total-1)))
 return Math.floor(index/wordPaperOverviewPageSize)
}
/** Displays the effective preview dimensions without changing document data. */
export function WordPaperOverview({layout,section,onClose,editing,startEditing=false}:{layout:WordLayout;section:number|null;onClose:()=>void;editing?:{layoutHash:string;revision:number;submit:WordPageSetupSubmit};startEditing?:boolean}){
 const {t,locale}=useI18n(),title=useId(),list=useRef<HTMLUListElement>(null),previous=useRef<HTMLButtonElement>(null),next=useRef<HTMLButtonElement>(null),close=useRef<HTMLButtonElement>(null),number=new Intl.NumberFormat(locale,{minimumFractionDigits:1,maximumFractionDigits:1})
 const [page,setPage]=useState(()=>wordPaperOverviewPage(layout.sections.length,section)),[setup,setSetup]=useState(startEditing)
 useEffect(()=>setPage(wordPaperOverviewPage(layout.sections.length,section)),[layout.sections.length,section])
 const pages=Math.max(1,Math.ceil(layout.sections.length/wordPaperOverviewPageSize)),current=Math.min(page,pages-1),start=current*wordPaperOverviewPageSize,shown=layout.sections.slice(start,start+wordPaperOverviewPageSize)
 const changePage=(value:number)=>{if(list.current)list.current.scrollTop=0;setPage(value)}
 useEffect(()=>{if(section===null||wordPaperOverviewPage(layout.sections.length,section)!==current)return;const frame=requestAnimationFrame(()=>list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({block:'nearest'}));return()=>cancelAnimationFrame(frame)},[current,layout.sections.length,section])
 if(setup&&editing&&section!==null&&section>=0&&section<layout.sections.length)return <WordPageSetup layout={layout} layoutHash={editing.layoutHash} revision={editing.revision} section={section} onClose={()=>setSetup(false)} onSubmit={editing.submit}/>
 return <div className="hcd-dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><div className="hcd-dialog word-paper-overview" role="dialog" aria-modal="true" aria-labelledby={title} onKeyDown={event=>{
  event.stopPropagation()
  if(event.key==='Escape'){event.preventDefault();onClose()}
  else if(event.key==='Tab'){const choices=[list.current,previous.current,next.current,close.current].filter((element):element is HTMLUListElement|HTMLButtonElement=>!!element&&!('disabled' in element&&element.disabled));const index=choices.findIndex(element=>element===event.target);if(choices.length){event.preventDefault();choices[(index+(event.shiftKey?-1:1)+choices.length)%choices.length].focus()}}
 }}><h2 id={title}>{t('wordPaperOverview')}</h2><p>{t('wordPaperOverviewHint')}</p><ul ref={list} tabIndex={0} aria-label={t('wordPaperOverview')}>{shown.map((item,offset)=>{const index=start+offset,size=wordPaperGeometry(layout,index),format=wordPaperFormat(size.width,size.height);return <li key={item.id} aria-current={index===section?'true':undefined}><strong>{t('wordSection',{count:index+1})}</strong><span>{format??t('wordPaperSize')} · {t(size.width>size.height?'wordLandscape':'wordPortrait')} · {number.format(size.width*25.4/96)} × {number.format(size.height*25.4/96)} mm</span></li>})}</ul>{pages>1&&<nav aria-label={t('wordPaperOverviewPages')}><span>{t('wordPaperOverviewRange',{from:start+1,to:start+shown.length,total:layout.sections.length})}</span> <button ref={previous} type="button" disabled={current===0} onClick={()=>changePage(current-1)}>{t('fixedRecoveryPrevious')}</button> <button ref={next} type="button" disabled={current+1>=pages} onClick={()=>changePage(current+1)}>{t('fixedRecoveryNext')}</button></nav>}{editing&&section!==null?<p><button type="button" onClick={()=>setSetup(true)}>{t('wordPageSetupTitle')}</button></p>:<p>{t('wordPaperEditingUnavailable')}</p>}<div className="hcd-dialog-actions"><button ref={close} type="button" autoFocus onClick={onClose}>{t('close')}</button></div></div></div>
}
