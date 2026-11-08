import {wordPageValue} from './wordPageValues.ts'
import {useI18n,type MessageKey} from './i18n.tsx'
import type {WordTopologyChangeData} from './wordTopologyRecoveryClient.ts'
const fieldKeys:Record<string,MessageKey>={widthTwips:'wordTopologyWidth',heightTwips:'wordTopologyHeight',orientation:'wordTopologyOrientation',marginTop:'wordTopologyMarginTop',marginRight:'wordTopologyMarginRight',marginBottom:'wordTopologyMarginBottom',marginLeft:'wordTopologyMarginLeft',marginHeader:'wordTopologyMarginHeader',marginFooter:'wordTopologyMarginFooter',marginGutter:'wordTopologyMarginGutter',numberStart:'wordTopologyNumberStart',numberFormat:'wordTopologyNumberFormat',differentFirstPage:'wordTopologyFirstDifferent',evenAndOddHeaders:'wordTopologyEvenDifferent'}
export function WordTopologyChange({change}:{change:WordTopologyChangeData}){
 const {t,locale}=useI18n()
 const format=(field:string,value:string|number|boolean|null)=>wordPageValue(field,value,t,locale)
 if('field'in change)return <>{change.section===null?t('wordTopologyDocument'):t('wordSection',{count:change.section})} · {t(fieldKeys[change.field])}: {format(change.field,change.before)} → {format(change.field,change.after)}</>
 return <>{t('wordSection',{count:change.section})} · {t(change.kind==='header'?'headerRegion':'footerRegion')} · {t(change.variant==='first'?'wordFirstPageVariant':change.variant==='even'?'wordEvenPageVariant':'wordDefaultPages')} · {'operation'in change?<>{t(change.sourceSection===null?'wordTopologyLinkNoSource':'wordTopologyLinkSource',{section:change.sourceSection??0})} · {t(change.contentChanged?'wordTopologyLinkContentChanges':'wordTopologyLinkContentSame')} · {t('wordTopologyLinkRetained')}</>:t(change.inherited?'wordTopologyCopiesInherited':'wordTopologyCreatesBlank',{count:change.blockCount})}</>
}
