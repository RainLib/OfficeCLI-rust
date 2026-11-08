export const exportFormats=['docx','xlsx','pptx','pdf','html','md','txt'] as const
export type ExportRepresentation={support:'native'|'semantic'|'static'|'unsupported';dataRetention:'native'|'embedded'|'omitted'}
export type ExportFeature={kind:'extension_inline'|'extension_block'|'reference'|'custom_mark';count:number;examples:string[];resourceCount?:number;resourceExamples?:string[];formats:Record<typeof exportFormats[number],ExportRepresentation>;source:ExportRepresentation;nativeBundle:ExportRepresentation}
export type ExportCapabilities={schemaVersion:'hcd-export-capabilities/1';scope:'business-nodes';documentId:string;revision:number;features:ExportFeature[]}
export type ScopedExportCapabilities={value:ExportCapabilities;token:string;apiUrl:string|undefined;refreshKey:number}
export function currentExportCapabilities(scoped:ScopedExportCapabilities|null,documentId:string,revision:number|null,token:string,apiUrl:string|undefined,refreshKey:number):ExportCapabilities|null{
 return scoped?.value.revision===revision&&scoped.value.documentId===documentId&&scoped.token===token&&scoped.apiUrl===apiUrl&&scoped.refreshKey===refreshKey?scoped.value:null
}
function representation(value:unknown):ExportRepresentation{
 const item=value as ExportRepresentation
 if(!item||!['native','semantic','static','unsupported'].includes(item.support)||!['native','embedded','omitted'].includes(item.dataRetention)||item.support==='native'&&item.dataRetention!=='native')throw new Error('exportCapabilitiesInvalid')
 return{support:item.support,dataRetention:item.dataRetention}
}
export function readExportCapabilities(value:unknown,documentId:string,revision:number):ExportCapabilities{
 const report=value as ExportCapabilities
 if(!report||report.schemaVersion!=='hcd-export-capabilities/1'||report.scope!=='business-nodes'||report.documentId!==documentId||report.revision!==revision||!Number.isSafeInteger(revision)||revision<0||!Array.isArray(report.features)||report.features.length>4)throw new Error('exportCapabilitiesInvalid')
 const seen=new Set<string>(),features=report.features.map(feature=>{
  if(!feature||!['extension_inline','extension_block','reference','custom_mark'].includes(feature.kind)||seen.has(feature.kind)||!Number.isInteger(feature.count)||feature.count<1||feature.count>10000||!Array.isArray(feature.examples)||feature.examples.length>3||feature.examples.some(text=>typeof text!=='string'||!text.trim()||text.length>320))throw new Error('exportCapabilitiesInvalid')
  if(feature.resourceCount!==undefined&&(!Number.isSafeInteger(feature.resourceCount)||feature.resourceCount<0||feature.resourceCount>160000)||feature.resourceExamples!==undefined&&(!Array.isArray(feature.resourceExamples)||feature.resourceExamples.length>3||feature.resourceExamples.some(name=>typeof name!=='string'||new TextEncoder().encode(name).length>256)))throw new Error('exportCapabilitiesInvalid')
  seen.add(feature.kind)
  const formats=Object.fromEntries(exportFormats.map(format=>[format,representation(feature.formats?.[format])])) as ExportFeature['formats']
  return{kind:feature.kind,count:feature.count,examples:[...feature.examples],...(feature.resourceCount!==undefined?{resourceCount:feature.resourceCount,resourceExamples:[...(feature.resourceExamples??[])]}:{}),formats,source:representation(feature.source),nativeBundle:representation(feature.nativeBundle)}
 })
 if(features.filter(feature=>feature.kind!=='reference').reduce((sum,feature)=>sum+feature.count,0)>10000)throw new Error('exportCapabilitiesInvalid')
 return{schemaVersion:report.schemaVersion,scope:report.scope,documentId,revision,features}
}
export function exportRepresentation(feature:ExportFeature,format:string,source:boolean){
 if(format==='hcdz'&&!source)return feature.nativeBundle
 if(!exportFormats.includes(format as typeof exportFormats[number]))throw new Error('exportCapabilitiesInvalid')
 return source?feature.source:feature.formats[format as typeof exportFormats[number]]
}
export function exportCapabilitySignature(report:ExportCapabilities,format:string,source:boolean){
 return JSON.stringify(report.features.map(feature=>({kind:feature.kind,count:feature.count,resourceCount:feature.resourceCount??0,...exportRepresentation(feature,format,source)})).sort((a,b)=>a.kind.localeCompare(b.kind)))
}
export function exportCapabilityBlocked(report:ExportCapabilities,format:string,source:boolean){return report.features.some(feature=>exportRepresentation(feature,format,source).support==='unsupported')}

/** Recheck the actual saved revision before making a file request. Ordinary
 * text edits do not need a second review; new losses or changed retention do. */
export function exportCapabilityDecision(previousSignature:string|null,report:ExportCapabilities,format:string,source:boolean):'blocked'|'review'|'download'{
 if(exportCapabilityBlocked(report,format,source))return 'blocked'
 return report.features.length&&exportCapabilitySignature(report,format,source)!==previousSignature?'review':'download'
}
export function exportCapabilitySummary(report:ExportCapabilities,format:string,source:boolean){
 const conversions=report.features.map(feature=>exportRepresentation(feature,format,source)),count=report.features.reduce((sum,feature)=>sum+feature.count,0)
 const kind=format==='hcdz'&&conversions.every(item=>item.support==='native'&&item.dataRetention==='native')?'native':conversions.some(item=>item.support==='unsupported')?'unsupported':conversions.length&&conversions.every(item=>item.support==='static'&&item.dataRetention==='omitted')?'static-omitted':conversions.length&&conversions.every(item=>item.support==='static'&&item.dataRetention==='embedded')?'static-embedded':'mixed'
 return{kind,count} as const
}
