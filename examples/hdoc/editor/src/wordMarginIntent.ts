import {readWordLayout,type WordLayout} from './wordRegions.ts'
import type {WordPaperTarget} from './wordPaperIntent.ts'

const fields={top:'marginTop',right:'marginRight',bottom:'marginBottom',left:'marginLeft',header:'marginHeader',footer:'marginFooter',gutter:'marginGutter'} as const
type Margin=keyof typeof fields
export type WordMargins=Partial<Record<Margin,number|null>>
export type WordMarginChange={sectionId:string;field:typeof fields[Margin];expected:number|null;value:number|null}
/** Build a field-level, reviewable margin intent. Null removes a source value;
 * omitted keys leave it unchanged. Submitting still requires the coordinator. */
export function wordMarginIntent(input:{layout:WordLayout;layoutHash:string;revision:number;target:WordPaperTarget;margins:WordMargins}){
 const {layoutHash,revision,target,margins}=input
 if(!Number.isSafeInteger(revision)||revision<0||!target||!['section','document'].includes(target.kind)||!margins||typeof margins!=='object'||Array.isArray(margins))throw Error('word-margin-invalid')
 const keys=Object.keys(margins) as Margin[]
 if(!keys.length||keys.some(key=>!Object.hasOwn(fields,key)))throw Error('word-margin-invalid')
 for(const key of keys){const value=margins[key];if(value!==null&&(!Number.isSafeInteger(value)||value!<(key==='top'||key==='bottom'?-200_000:0)||value!>200_000))throw Error('word-margin-invalid')}
 const layout=structuredClone(readWordLayout({layout:input.layout,layoutHash,revision},revision,2)),selected=target.kind==='document'?layout.sections:layout.sections.filter(section=>section.id===target.sectionId)
 if(!selected.length)throw Error('word-margin-section-unavailable')
 const changes:WordMarginChange[]=[],affectedSections:string[]=[]
 for(const section of selected){let changed=false;const values={...section.page.marginsTwips}
  // A stable field order makes confirmation and request digests reproducible.
  for(const key of Object.keys(fields) as Margin[]){if(!Object.hasOwn(margins,key))continue;const expected=values[key]??null,value=margins[key] as number|null;if(expected===value)continue;changes.push({sectionId:section.id,field:fields[key],expected,value});if(value===null)delete values[key];else values[key]=value;changed=true}
  if(changed){affectedSections.push(section.id);if(Object.keys(values).length)section.page.marginsTwips=values;else delete section.page.marginsTwips}
 }
 if(changes.length>1024)throw Error('word-margin-limit')
 const intent={schemaVersion:'hcd-word-layout-edits/1' as const,baseLayoutHash:layoutHash,changes}
 if(new TextEncoder().encode(JSON.stringify(intent)).length>256*1024)throw Error('word-margin-limit')
 return{intent:changes.length?intent:null,affectedSections,preview:layout}
}
