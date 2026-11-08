import {useCallback,useEffect,useState} from 'react'
import {api,type Session} from './api.ts'
import {useI18n,type MessageKey} from './i18n.tsx'
import {readWordLayout,wordRegionSections,wordVariantInherited,type WordLayout,type WordRegion} from './wordRegions.ts'
import {wordPageValue} from './wordPageValues.ts'
type State={layout:WordLayout;revision:number}|'loading'|'failed'|null
export function useWordLayout(session:Session,revision:number|null){
 const [attempt,setAttempt]=useState(0),retry=useCallback(()=>setAttempt(value=>value+1),[])
 const [state,setState]=useState<State>(null)
 useEffect(()=>{
  if(!session.flowLayoutVersion||revision===null){setState(null);return}
  const controller=new AbortController();setState('loading')
  void api(session,`/word/layout?revision=${revision}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)])}).then(response=>response.json()).then(value=>{const layout=readWordLayout(value,revision,session.flowLayoutVersion!);if(!controller.signal.aborted)setState({layout,revision})}).catch(()=>{if(!controller.signal.aborted)setState('failed')})
  return()=>controller.abort()
 },[session.documentId,session.token,session.apiUrl,session.flowLayoutVersion,revision,attempt])
 return {state:state!==null&&typeof state==='object'&&state.revision!==revision?'loading' as const:state,retry}
}
export function wordRegionLabel(kind:string,t:(key:MessageKey,values?:Record<string,string|number>)=>string){return t(kind==='header'?'headerRegion':kind==='footer'?'footerRegion':kind==='footnote'?'footnoteRegion':kind==='endnote'?'endnoteRegion':'wordBodyRegion')}
export function WordRegionProperties({state,region,onRetry,previewSection,onPreviewSection}:{state:State;region?:WordRegion;onRetry:()=>void;previewSection?:number;onPreviewSection:(section:number)=>void}){
 const {t,locale}=useI18n()
 if(state==='failed')return <p role="status">{t('wordLayoutUnavailable')} <button type="button" onClick={onRetry}>{t('retry')}</button></p>
 if(!state||state==='loading'||!region)return <p role="status">{t('loadingSection')}</p>
 const uses=wordRegionSections(state.layout,region),number=new Intl.NumberFormat(locale,{maximumFractionDigits:1})
 return <section className="word-region-properties"><h3>{wordRegionLabel(region.kind,t)}</h3>{uses.length>1&&<label className="word-preview-section">{t('wordPreviewSection')}<select value={previewSection??uses[0].section} aria-label={t('wordPreviewSection')} onChange={event=>onPreviewSection(Number(event.target.value))}>{uses.map(use=><option key={use.section} value={use.section}>{t('wordSection',{count:use.section})}</option>)}</select></label>}{!uses.length&&region.kind!=='body'&&<p>{t('wordUnboundStory')}</p>}{uses.map(use=>{
  const section=state.layout.sections[use.section-1],page=section.page
  return <div key={use.section}><strong>{t('wordSection',{count:use.section})}</strong>{use.variants.length>0&&<p>{use.variants.map(variant=>`${t(variant==='first'?'wordFirstPageVariant':variant==='even'?'wordEvenPageVariant':'wordDefaultPages')}${wordVariantInherited(state.layout,use.section-1,region.kind,variant)?` · ${t('wordLinkedPrevious')}`:''}`).join(' / ')}</p>}<dl>{page.widthTwips&&page.heightTwips&&<><dt>{t('wordPaperSize')}</dt><dd>{number.format(page.widthTwips/20)} × {number.format(page.heightTwips/20)} pt</dd></>}<dt>{t('wordFirstPage')}</dt><dd>{t(section.differentFirstPage?'wordEnabled':'wordDisabled')}</dd><dt>{t('wordEvenPages')}</dt><dd>{t(state.layout.evenAndOddHeaders?'wordEnabled':'wordDisabled')}</dd><dt>{t('wordPageNumberStart')}</dt><dd>{wordPageValue('numberStart',page.numberStart??null,t,locale)}</dd><dt>{t('wordTopologyNumberFormat')}</dt><dd>{wordPageValue('numberFormat',page.numberFormat??null,t,locale)}</dd></dl></div>
 })}<p className="word-region-limit">{t('wordRegionSettingsHint')}</p></section>
}
