import {readWordLayout,type WordLayout} from './wordRegions.ts'
import {wordPaperIntent,type WordPaperSize,type WordPaperTarget} from './wordPaperIntent.ts'
import {wordMarginIntent,type WordMargins} from './wordMarginIntent.ts'
import {wordNumberingIntent,type WordNumbering} from './wordNumberingIntent.ts'

/** Prepare paper and margin edits as one atomic layout request. It is a pure
 * preview: the trusted coordinator must authenticate and submit the intent. */
export function wordPageIntent(input:{layout:WordLayout;layoutHash:string;revision:number;target:WordPaperTarget;paper?:WordPaperSize;margins?:WordMargins;numbering?:WordNumbering}){
 if(!input.paper&&!input.margins&&!input.numbering)throw Error('word-page-invalid')
 const source=structuredClone(readWordLayout({layout:input.layout,layoutHash:input.layoutHash,revision:input.revision},input.revision,2))
 const paper=input.paper?wordPaperIntent({...input,layout:source,paper:input.paper}):undefined
 const margins=input.margins?wordMarginIntent({...input,layout:paper?.preview??source,margins:input.margins}):undefined
 const numbering=input.numbering?wordNumberingIntent({...input,layout:margins?.preview??paper?.preview??source,numbering:input.numbering}):undefined
 const changes=[...(paper?.intent?.changes??[]),...(margins?.intent?.changes??[]),...(numbering?.intent?.changes??[])]
 if(changes.length>1024)throw Error('word-page-limit')
 const intent={schemaVersion:'hcd-word-layout-edits/1' as const,baseLayoutHash:input.layoutHash,changes}
 if(new TextEncoder().encode(JSON.stringify(intent)).length>256*1024)throw Error('word-page-limit')
 const changed=new Set([...(paper?.affectedSections??[]),...(margins?.affectedSections??[]),...(numbering?.affectedSections??[])])
 return{intent:changes.length?intent:null,affectedSections:source.sections.filter(section=>changed.has(section.id)).map(section=>section.id),preview:numbering?.preview??margins?.preview??paper?.preview??source}
}
