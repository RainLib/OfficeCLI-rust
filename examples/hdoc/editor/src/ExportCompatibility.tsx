import {useEffect,useId,useRef,useState} from 'react'
import {useI18n,type MessageKey} from './i18n.tsx'
import {exportCapabilitySummary,exportRepresentation,type ExportCapabilities} from './exportCapabilities.ts'
export function ExportCompatibility({report,format,source}:{report:ExportCapabilities;format:string;source:boolean}){
 const {t}=useI18n()
 const id=useId(),trigger=useRef<HTMLButtonElement>(null),popover=useRef<HTMLDivElement>(null),[open,setOpen]=useState(false),[position,setPosition]=useState({left:12,top:12,width:360,maxHeight:320})
 useEffect(()=>{popover.current?.hidePopover()},[report.revision,format,source])
 useEffect(()=>{
  if(!open)return
  const close=(event:Event)=>{if(!(event.target instanceof Node&&popover.current?.contains(event.target)))popover.current?.hidePopover()}
  // A scrolled ribbon no longer shares the trigger's original screen position.
  window.addEventListener('resize',close);window.addEventListener('scroll',close,true)
  return()=>{window.removeEventListener('resize',close);window.removeEventListener('scroll',close,true)}
 },[open])
 if(!report.features.length)return null
 const {kind,count}=exportCapabilitySummary(report,format,source)
 const resources=report.features.reduce((sum,feature)=>sum+(feature.resourceCount??0),0)
 const summary:Record<typeof kind,MessageKey>={native:'exportBusinessNative',unsupported:'exportBusinessSourceUnsupported','static-omitted':'exportBusinessStatic','static-embedded':'exportBusinessEmbedded',mixed:'exportBusinessConversions'}
 const labels={extension_inline:'exportFeatureInline',extension_block:'exportFeatureBlock',reference:'exportFeatureReference',custom_mark:'exportFeatureMark'} as const
 const support:Record<string,MessageKey>={native:'exportSupportNative',semantic:'exportSupportSemantic',static:'exportSupportStatic',unsupported:'exportSupportUnsupported'}
 const retention:Record<string,MessageKey>={native:'exportDataNative',embedded:'exportDataEmbedded',omitted:'exportDataOmitted'}
 return <div className="export-compatibility">
  <button type="button" ref={trigger} className="export-compatibility-trigger" popoverTarget={id} aria-expanded={open} aria-controls={id}>{resources&&format!=='hcdz'&&kind!=='unsupported'?t('exportNodeResourcesWarning',{count:resources}):t(summary[kind],{count})}</button>
  <div id={id} ref={popover} popover="auto" role="note" className="export-compatibility-content" style={position} onToggle={event=>setOpen(event.newState==='open')} onBeforeToggle={event=>{
   if(event.newState!=='open'||!trigger.current)return
   const box=trigger.current.getBoundingClientRect(),width=Math.min(360,window.innerWidth-24),below=window.innerHeight-box.bottom-20
   setPosition({left:Math.max(12,Math.min(box.left,window.innerWidth-width-12)),top:below>=120?box.bottom+6:12,width,maxHeight:Math.max(80,below>=120?below:box.top-24)})
  }}>
   {report.features.map(feature=>{const conversion=exportRepresentation(feature,format,source);return <section key={feature.kind}><strong>{t(labels[feature.kind])} · {feature.count}</strong><p>{t(support[conversion.support])} · {t(retention[conversion.dataRetention])}</p>{!!feature.resourceCount&&<p>{t(format==='hcdz'?'exportNodeResourcesNative':'exportNodeResources',{count:feature.resourceCount})}{feature.resourceExamples?.length?` ${feature.resourceExamples.join('；')}`:''}</p>}{feature.examples.length>0&&<p className="export-compatibility-examples">{feature.examples.join('；')}</p>}</section>})}
   <p>{t(format==='hcdz'?'exportBusinessNativeArchive':'exportBusinessNativeBundle')}</p>
  </div>
 </div>
}
