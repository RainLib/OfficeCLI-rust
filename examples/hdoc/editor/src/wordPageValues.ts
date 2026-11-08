import type {MessageKey} from './i18n.tsx'
import type {WordNumberFormat} from './wordNumberingIntent.ts'
export const wordNumberFormatLabels:Record<WordNumberFormat,MessageKey>={decimal:'wordNumberFormatDecimal',upperRoman:'wordNumberFormatUpperRoman',lowerRoman:'wordNumberFormatLowerRoman',upperLetter:'wordNumberFormatUpperLetter',lowerLetter:'wordNumberFormatLowerLetter'}
type Translate=(key:MessageKey,values?:Record<string,string|number>)=>string
/** Page numbers are counts, not twips. All confirmation and recovery surfaces
 * share the same field-aware presentation. Unknown source format names stay. */
export function wordPageValue(field:string,value:string|number|boolean|null,t:Translate,locale:string){
 if(field==='numberStart')return value===null?t('wordPageNumberContinue'):new Intl.NumberFormat(locale,{maximumFractionDigits:0}).format(Number(value))
 if(field==='numberFormat')return value===null?t('wordPageNumberDefault'):Object.hasOwn(wordNumberFormatLabels,String(value))?t(wordNumberFormatLabels[value as WordNumberFormat]):String(value)
 if(value===null)return t('wordTopologyUnset')
 if(typeof value==='boolean')return t(value?'wordTopologyEnabled':'wordTopologyDisabled')
 if(typeof value==='number'&&(field.endsWith('Twips')||field.startsWith('margin')))return `${new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(value*25.4/1440)} mm`
 return value==='portrait'?t('wordPortrait'):value==='landscape'?t('wordLandscape'):String(value)
}
