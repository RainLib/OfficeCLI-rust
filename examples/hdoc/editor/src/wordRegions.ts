import {EditorDocumentError,documentProblem} from './documentProblems.ts'
export type WordRegionVersion=1|2
export function wordRegionVersion(manifest:unknown,options?:{wordLayoutV2?:boolean}):WordRegionVersion|undefined{
 const value=manifest as {source?:{format?:unknown};profile?:unknown;capabilities?:{flowLayout?:unknown;wordLayoutEdits?:unknown}}
 // Only an explicitly negotiated layout-aware client may accept these heads.
 // The obsolete story marker 2 and unknown models remain incompatible.
 const marker=value?.capabilities?.wordLayoutEdits
 if(marker!==undefined&&(!options?.wordLayoutV2||value.capabilities?.flowLayout!==2||marker!==1&&marker!==3))throw new EditorDocumentError(documentProblem('HCD-DOC-1026'))
 const version=value?.capabilities?.flowLayout
 if(version===undefined)return undefined
 if((version!==1&&version!==2)||value?.source?.format!=='docx'||value.profile!=='semantic-flow')throw new EditorDocumentError(documentProblem('HCD-DOC-1026'))
 return version
}
export type WordStoryBindings={default?:string;first?:string;even?:string}
export type WordSection={id:string;differentFirstPage:boolean;breakType?:string;page:{widthTwips?:number;heightTwips?:number;orientation?:string;marginsTwips?:Record<string,number>;numberStart?:number;numberFormat?:string};headers:WordStoryBindings;footers:WordStoryBindings}
export type WordStory={id:string;kind:'header'|'footer';sourcePart:string}
export type WordLayout={schemaVersion:'hcd-flow-layout/1'|'hcd-flow-layout/2';evenAndOddHeaders:boolean;sections:WordSection[];stories:WordStory[]}
export type WordRegion={id?:string;kind:'body'|'header'|'footer';sourcePart:string}
/** Each page variant has its own link to the previous section. */
export function wordVariantInherited(layout:WordLayout,section:number,kind:WordRegion['kind'],variant:'default'|'first'|'even'){
 if(kind==='body'||section<=0||section>=layout.sections.length)return false
 const bindings=kind==='header'?layout.sections[section].headers:layout.sections[section].footers
 return bindings[variant]===undefined
}
const id=/^n_[0-9a-f]{32}$/
export function readWordLayout(value:unknown,revision:number,version:WordRegionVersion):WordLayout{
 const response=value as {revision?:unknown;layout?:WordLayout;layoutHash?:unknown},layout=response?.layout
 const fail=()=>{throw new EditorDocumentError(documentProblem('HCD-DOC-3001','content'))}
 if(response?.revision!==revision||!layout||layout.schemaVersion!==`hcd-flow-layout/${version}`||typeof response.layoutHash!=='string'||!/^[a-f0-9]{64}$/.test(response.layoutHash)||typeof layout.evenAndOddHeaders!=='boolean'||!Array.isArray(layout.sections)||!layout.sections.length||layout.sections.length>4096||!Array.isArray(layout.stories)||layout.stories.length>8192)fail()
 const ids=new Set<string>(),parts=new Set<string>(),stories=new Map<string,WordStory>()
 for(const story of layout!.stories){
  const part=story?.sourcePart
  if(!story||typeof story.id!=='string'||!id.test(story.id)||ids.has(story.id)||!['header','footer'].includes(story.kind)||typeof part!=='string'||part.length>1024||!part.startsWith('word/')||!part.endsWith('.xml')||part==='word/document.xml'||new TextEncoder().encode(part).length>1024||/[\\\u0000-\u001f\u007f-\u009f?#:]/u.test(part)||part.split('/').some(segment=>!segment||segment==='.'||segment==='..')||parts.has(part))fail()
  ids.add(story.id);parts.add(part);stories.set(story.id,story)
 }
 for(const section of layout!.sections){
  if(!section||!id.test(section.id)||ids.has(section.id)||typeof section.differentFirstPage!=='boolean'||!section.page||typeof section.page!=='object')fail();ids.add(section.id)
  for(const size of [section.page.widthTwips,section.page.heightTwips])if(size!==undefined&&(!Number.isSafeInteger(size)||size<=0||size>200_000))fail()
  if(section.breakType!==undefined&&!['nextPage','continuous','evenPage','oddPage','nextColumn'].includes(section.breakType))fail()
  if(section.page.orientation!==undefined&&!['portrait','landscape'].includes(section.page.orientation))fail()
  const margins=section.page.marginsTwips
  if(margins!==undefined){if(!margins||typeof margins!=='object'||Array.isArray(margins))fail();for(const [key,amount] of Object.entries(margins))if(!['top','right','bottom','left','header','footer','gutter'].includes(key)||!Number.isSafeInteger(amount)||amount < (key==='top'||key==='bottom'?-200_000:0)||amount>200_000)fail()}
  if(section.page.numberStart!==undefined&&(!Number.isSafeInteger(section.page.numberStart)||section.page.numberStart<0||section.page.numberStart>2_147_483_647))fail()
  if(section.page.numberFormat!==undefined&&(typeof section.page.numberFormat!=='string'||!/^[a-zA-Z0-9_]{1,64}$/.test(section.page.numberFormat)))fail()
  for(const [kind,bindings]of [['header',section.headers],['footer',section.footers]] as const){if(!bindings||typeof bindings!=='object'||Array.isArray(bindings))fail();for(const key of ['default','first','even'] as const){const target=bindings[key];if(target!==undefined&&stories.get(target)?.kind!==kind)fail()}}
 }
 return layout!
}
export function wordRegionForElement(element:Element|null):WordRegion|undefined{
 const node=element?.closest('[data-hcd-region]'),kind=node?.getAttribute('data-hcd-region'),sourcePart=node?.getAttribute('data-hcd-source-part'),identity=node?.getAttribute('data-hcd-flow-region')
 if(!['body','header','footer'].includes(kind??'')||!sourcePart)return undefined
 if(identity&&!id.test(identity))throw new Error('Invalid Word region identity')
 return{kind:kind as WordRegion['kind'],sourcePart,...(identity?{id:identity}:{})}
}
export function wordRegionSections(layout:WordLayout,region:WordRegion):Array<{section:number;variants:Array<'default'|'first'|'even'>;inherited:boolean}>{
 if(region.kind==='body')return region.sourcePart==='word/document.xml'?layout.sections.flatMap((section,index)=>region.id===section.id?[{section:index+1,variants:[],inherited:false}]:[]):[]
 const story=layout.stories.find(story=>region.id?story.id===region.id:story.sourcePart===region.sourcePart)
 if(!story||story.kind!==region.kind||story.sourcePart!==region.sourcePart)return[]
 const effective:WordStoryBindings={};return layout.sections.flatMap((section,index)=>{
  const declared=region.kind==='header'?section.headers:section.footers
  for(const variant of ['default','first','even'] as const)if(declared[variant]!==undefined)effective[variant]=declared[variant]
  const variants=(['default','first','even'] as const).filter(variant=>effective[variant]===story.id)
  return variants.length?[{section:index+1,variants,inherited:variants.every(variant=>declared[variant]===undefined)}]:[]
 })
}
/** Read-only boundaries apply to descendants too, including computed caches,
 * tracked deletions and opaque business nodes. Native validation remains final. */
export function editableFlowElement(element:Element):boolean{
 return !element.closest('[data-hcd-editable="false"],[data-hcd-word-field-path],[data-hcd-extension],[data-hcd-reference]')
}
