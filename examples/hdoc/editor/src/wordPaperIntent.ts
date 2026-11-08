import {readWordLayout,type WordLayout} from './wordRegions.ts'

export type WordPaperSize={widthTwips:number;heightTwips:number;orientation:'portrait'|'landscape'}
export type WordPaperTarget={kind:'section';sectionId:string}|{kind:'document'}
export type WordPaperChange={sectionId:string;field:'widthTwips'|'heightTwips'|'orientation';expected:number|string|null;value:number|string}
export type WordPaperIntent={schemaVersion:'hcd-word-layout-edits/1';baseLayoutHash:string;changes:WordPaperChange[]}

/** Build a reviewable layout-only intent, without mutating or saving the room.
 * The caller must submit it through the authenticated layout coordinator. */
export function wordPaperIntent(input:{layout:WordLayout;layoutHash:string;revision:number;target:WordPaperTarget;paper:WordPaperSize}):{intent:WordPaperIntent|null;affectedSections:string[];preview:WordLayout}{
 const {layoutHash,revision}=input
 if(!Number.isSafeInteger(revision)||revision<0)throw Error('word-paper-invalid')
 const layout=structuredClone(readWordLayout({layout:input.layout,layoutHash,revision},revision,2)),target=input.target,paper=input.paper
 if(!target||!['section','document'].includes(target.kind)||!paper||!['portrait','landscape'].includes(paper.orientation)||![paper.widthTwips,paper.heightTwips].every(size=>Number.isSafeInteger(size)&&size>0&&size<=200_000))throw Error('word-paper-invalid')
 const selected=target.kind==='document'?layout.sections:layout.sections.filter(section=>section.id===target.sectionId)
 if(!selected.length)throw Error('word-paper-section-unavailable')
 const changes:WordPaperChange[]=[],affectedSections:string[]=[]
 for(const section of selected){
  let changed=false
  for(const field of ['widthTwips','heightTwips','orientation'] as const){const expected=section.page[field]??null,value=paper[field];if(expected===value)continue;changes.push({sectionId:section.id,field,expected,value});changed=true}
  if(changed)affectedSections.push(section.id)
 }
 if(changes.length>1024)throw Error('word-paper-limit')
 const intent:WordPaperIntent={schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:layoutHash,changes}
 if(new TextEncoder().encode(JSON.stringify(intent)).length>256*1024)throw Error('word-paper-limit')
 const changedIds=new Set(affectedSections);for(const section of selected)if(changedIds.has(section.id)){section.page.widthTwips=paper.widthTwips;section.page.heightTwips=paper.heightTwips;section.page.orientation=paper.orientation}
 return{intent:changes.length?intent:null,affectedSections,preview:layout}
}
