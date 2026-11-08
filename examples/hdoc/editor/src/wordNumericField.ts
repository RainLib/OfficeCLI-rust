import type {Session} from './api.ts'
import {nodeExportFormats,type NodeExportSnapshot} from './extensionPortable.ts'
import type {NodeExtensionDefinition} from './extensionTypes.ts'
import type {CommandLabel} from './commands/types.ts'

export const wordNumericFieldType='officecli.word.numeric_field'
export const wordNumericFieldVersion='inline-v1'
export const wordNumericKinds=['PAGE','NUMPAGES','SECTIONPAGES'] as const
export const wordNumericFormats=['inherit','arabic','upperRoman','lowerRoman','upperLetter','lowerLetter'] as const
export type WordNumericFieldData={kind:typeof wordNumericKinds[number];format:typeof wordNumericFormats[number]}
const label=(en:string,cn:string,tw=cn):CommandLabel=>({'en-US':en,'en-GB':en,'zh-CN':cn,'zh-TW':tw,'zh-HK':tw})
const labels={
 title:label('Page field','页码域','頁碼欄位'),
 kind:label('Field type','页码类型','頁碼類型'),
 format:label('Number format','编号格式','編號格式'),
 hint:label('This is a placeholder. Page numbers are calculated by compatible Word applications after export; this editor has not calculated them.','当前显示占位。导出后由兼容的 Word 应用计算，本编辑器尚未计算页码。','目前顯示佔位。匯出後由相容的 Word 應用程式計算，本編輯器尚未計算頁碼。'),
 sectionHint:label('Section page counts require support for the SECTIONPAGES field in the target application; some compatible readers may keep the placeholder.','本节页数需要目标应用支持相应域；部分兼容阅读器可能保留占位。','本節頁數需要目標應用程式支援對應欄位；部分相容閱讀器可能保留佔位。'),
 kinds:[label('Page number','页码','頁碼'),label('Total pages','总页数','總頁數'),label('Pages in section','本节页数','本節頁數')],
 formats:[label('Use section default','使用分节默认','使用分節預設'),label('1, 2, 3','1, 2, 3'),label('I, II, III','I, II, III'),label('i, ii, iii','i, ii, iii'),label('A, B, C','A, B, C'),label('a, b, c','a, b, c')],
 pending:label('not calculated','待计算','待計算'),
}
function localized(value:CommandLabel,locale:string){return typeof value==='string'?value:value[locale]??value['en-US']??''}
export function wordNumericFieldHint(data:Readonly<Record<string,unknown>>,locale:string){return localized(labels.hint,locale)+(checked(data).kind==='SECTIONPAGES'?' '+localized(labels.sectionHint,locale):'')}
export function validWordNumericFieldData(data:Readonly<Record<string,unknown>>):data is WordNumericFieldData {
 return Object.keys(data).sort().join(',')==='format,kind'&&wordNumericKinds.includes(data.kind as WordNumericFieldData['kind'])&&wordNumericFormats.includes(data.format as WordNumericFieldData['format'])
}
function checked(data:Readonly<Record<string,unknown>>):WordNumericFieldData {if(!validWordNumericFieldData(data))throw Error('nodeExtensionInvalidData');return data}
export function wordNumericFieldFallback(data:Readonly<Record<string,unknown>>){return `[${checked(data).kind}]`}
export const wordNumericFieldDefinition:NodeExtensionDefinition={
 type:wordNumericFieldType,version:1,display:'inline',label:labels.title,description:label('Not calculated here. Update fields in a compatible Word app after export. Some readers may keep section page counts as placeholders.','本编辑器尚未计算页码。导出后由支持相应域的 Word 应用更新；本节页数需目标应用支持，部分兼容阅读器可能保留占位。','本編輯器尚未計算頁碼。匯出後由支援對應欄位的 Word 應用程式更新；本節頁數需目標應用程式支援，部分相容閱讀器可能保留佔位。'),icon:'№',allowResources:false,
 defaultData:{kind:'PAGE',format:'inherit'},validate:validWordNumericFieldData,fallback:wordNumericFieldFallback,
 properties:[
  {key:'kind',label:labels.kind,kind:'select',required:true,options:wordNumericKinds.map((value,index)=>({value,label:labels.kinds[index]}))},
  {key:'format',label:labels.format,kind:'select',required:true,options:wordNumericFormats.map((value,index)=>({value,label:labels.formats[index]}))},
 ],
 exportAdapters:Object.fromEntries(nodeExportFormats.map(format=>[format,({data}:{data:Readonly<Record<string,unknown>>}):NodeExportSnapshot=>({support:format==='docx'?'semantic':'static',blocks:[{kind:'paragraph',runs:[{text:wordNumericFieldFallback(data)}]}]})])),
 mountView(element,{node,locale}){
  const data=checked(node.data),name=localized(labels.kinds[wordNumericKinds.indexOf(data.kind)],locale),hint=wordNumericFieldHint(data,locale)
  element.classList.add('hcd-word-numeric-field');element.textContent=`${name} · ${localized(labels.pending,locale)}`;element.title=hint;element.setAttribute('aria-label',`${name} · ${hint}`)
  return()=>{element.classList.remove('hcd-word-numeric-field')}
 },
}
/** Native capability, Word mode and negotiated room must agree. No declaration
 * from an old or unknown service version can enable creation. */
export function wordNumericFieldsEnabled(session:Pick<Session,'format'|'flowLayoutVersion'|'collaborationProtocol'|'wordNumericFields'>|undefined){return session?.format==='docx'&&session.flowLayoutVersion===2&&session.collaborationProtocol==='hcd-word-regions/2'&&session.wordNumericFields===wordNumericFieldVersion}
export function builtinWordNodes(session:Pick<Session,'format'|'flowLayoutVersion'|'collaborationProtocol'|'wordNumericFields'>|undefined):readonly NodeExtensionDefinition[]{return wordNumericFieldsEnabled(session)?[wordNumericFieldDefinition]:[]}
