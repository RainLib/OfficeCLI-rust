import {readWordLayout,type WordLayout} from './wordRegions.ts'

export const wordNumberFormats=['decimal','upperRoman','lowerRoman','upperLetter','lowerLetter'] as const
export type WordNumberFormat=typeof wordNumberFormats[number]
export type WordNumbering={sectionId:string;start?:number|null;format?:WordNumberFormat|null}
export type WordNumberingChange={sectionId:string;field:'numberStart'|'numberFormat';expected:number|string|null;value:number|string|null}
/** Existing source formats may be outside the small UI catalogue. A durable
 * original request retains every native-valid identifier without coercion. */
export function validWordNumberingValue(field:string,value:unknown){
 if(field==='numberStart')return value===null||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=2_147_483_647
 if(field==='numberFormat')return value===null||typeof value==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(value)
 return false
}
export function wordNumberStartInput(value:string){if(!/^\d{1,10}$/.test(value.trim()))throw Error('word-numbering-invalid');const number=Number(value.trim());if(!validWordNumberingValue('numberStart',number))throw Error('word-numbering-invalid');return number}
/** Numbering is scoped to one explicit section, independently of a document-
 * wide paper change. Null removes a setting; omitted properties preserve it. */
export function wordNumberingIntent(input:{layout:WordLayout;layoutHash:string;revision:number;numbering:WordNumbering}){
 const {numbering}=input
 if(!Number.isSafeInteger(input.revision)||input.revision<0||!numbering||typeof numbering!=='object'||Array.isArray(numbering)||typeof numbering.sectionId!=='string')throw Error('word-numbering-invalid')
 const keys=Object.keys(numbering);if(keys.some(key=>!['sectionId','start','format'].includes(key))||keys.length<2)throw Error('word-numbering-invalid')
 if(Object.hasOwn(numbering,'start')&&!validWordNumberingValue('numberStart',numbering.start)||Object.hasOwn(numbering,'format')&&numbering.format!==null&&!(wordNumberFormats as readonly unknown[]).includes(numbering.format))throw Error('word-numbering-invalid')
 const preview=structuredClone(readWordLayout({layout:input.layout,layoutHash:input.layoutHash,revision:input.revision},input.revision,2)),section=preview.sections.find(value=>value.id===numbering.sectionId)
 if(!section)throw Error('word-numbering-section-unavailable')
 const changes:WordNumberingChange[]=[]
 for(const [key,field]of [['start','numberStart'],['format','numberFormat']] as const){if(!Object.hasOwn(numbering,key))continue;const expected=section.page[field]??null,value=numbering[key] as number|string|null;if(value===expected)continue;changes.push({sectionId:section.id,field,expected,value});if(value===null)delete section.page[field];else Object.assign(section.page,{[field]:value})}
 return{intent:changes.length?{schemaVersion:'hcd-word-layout-edits/1' as const,baseLayoutHash:input.layoutHash,changes}:null,affectedSections:changes.length?[section.id]:[],preview}
}
