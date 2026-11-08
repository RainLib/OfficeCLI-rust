import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {ExportCompatibility} from './ExportCompatibility.tsx'
import {I18nProvider} from './i18n.tsx'
import {exportFormats,readExportCapabilities,currentExportCapabilities,exportRepresentation,exportCapabilityBlocked,exportCapabilitySignature,exportCapabilityDecision,exportCapabilitySummary,type ExportCapabilities} from './exportCapabilities.ts'
function report(revision=3,count=2){return{schemaVersion:'hcd-export-capabilities/1',scope:'business-nodes',documentId:'doc',revision,features:[{kind:'extension_inline',count,examples:['Readable'],formats:Object.fromEntries(exportFormats.map(format=>[format,{support:'static',dataRetention:format==='html'?'embedded':'omitted'}])),source:{support:'unsupported',dataRetention:'omitted'},nativeBundle:{support:'native',dataRetention:'native'}}]}}
test('only the current document, version, session and source refresh can enable a preview',()=>{
 const value=readExportCapabilities(report(),'doc',3),scoped={value,token:'token-a',apiUrl:'/api',refreshKey:1}
 assert.equal(currentExportCapabilities(scoped,'doc',3,'token-a','/api',1),value)
 assert.equal(currentExportCapabilities(scoped,'other',3,'token-a','/api',1),null)
 assert.equal(currentExportCapabilities(scoped,'doc',4,'token-a','/api',1),null)
 assert.equal(currentExportCapabilities(scoped,'doc',3,'token-b','/api',1),null)
 assert.equal(currentExportCapabilities(scoped,'doc',3,'token-a','/other',1),null)
 assert.equal(currentExportCapabilities(scoped,'doc',3,'token-a','/api',2),null)
})
test('business conversion declarations are bound to the exact saved document revision',()=>{
 const value=readExportCapabilities(report(),'doc',3)
 assert.equal(exportRepresentation(value.features[0],'docx',false).dataRetention,'omitted')
 assert.equal(exportRepresentation(value.features[0],'html',false).dataRetention,'embedded')
 assert.equal(exportCapabilityBlocked(value,'docx',true),true)
 assert.equal(exportCapabilityBlocked(value,'docx',false),false)
 assert.throws(()=>readExportCapabilities(report(),'another',3));assert.throws(()=>readExportCapabilities(report(),'doc',4))
})
test('changed saved counts or conversion mode require a new preview; ordinary version/text changes do not',()=>{
 const first=readExportCapabilities(report(),'doc',3),later=readExportCapabilities(report(4),'doc',4),extra=readExportCapabilities(report(4,3),'doc',4)
 assert.equal(exportCapabilitySignature(first,'pdf',false),exportCapabilitySignature(later,'pdf',false))
 assert.notEqual(exportCapabilitySignature(first,'pdf',false),exportCapabilitySignature(extra,'pdf',false))
 assert.notEqual(exportCapabilitySignature(first,'pdf',false),exportCapabilitySignature(first,'html',false))
 assert.notEqual(exportCapabilitySignature(first,'docx',true),exportCapabilitySignature(first,'docx',false))
})
test('malformed, oversized, duplicate or unsupported declarations fail rather than claiming retention',()=>{
 const mutations:Array<(value:any)=>void>=[value=>value.schemaVersion='future/2',value=>value.features[0].count=10001,value=>value.features.push(value.features[0]),value=>value.features[0].examples=['x'.repeat(321)],value=>delete value.features[0].formats.pdf,value=>value.features[0].formats.pdf.support='unverified',value=>value.features[0].nativeBundle.dataRetention='omitted']
 for(const mutate of mutations){const value=report();mutate(value);assert.throws(()=>readExportCapabilities(value,'doc',3))}
 const empty={...report(),features:[]} as ExportCapabilities;assert.equal(exportCapabilityBlocked(empty,'docx',true),false)
})

test('download is gated by the saved conversion declaration, including source mode and first load',()=>{
 const first=readExportCapabilities(report(),'doc',3),signature=exportCapabilitySignature(first,'docx',false)
 assert.equal(exportCapabilityDecision(signature,readExportCapabilities(report(4),'doc',4),'docx',false),'download')
 assert.equal(exportCapabilityDecision(signature,readExportCapabilities(report(4,3),'doc',4),'docx',false),'review')
 assert.equal(exportCapabilityDecision(null,first,'docx',false),'review')
 assert.equal(exportCapabilityDecision(signature,first,'docx',true),'blocked')
 assert.equal(exportCapabilityDecision(signature,{...first,features:[]},'docx',false),'download')
})
test('summary follows declared support and data retention rather than assuming all adapters are static',()=>{
 const value=readExportCapabilities(report(),'doc',3)
 assert.deepEqual(exportCapabilitySummary(value,'docx',false),{kind:'static-omitted',count:2})
 assert.deepEqual(exportCapabilitySummary(value,'html',false),{kind:'static-embedded',count:2})
 assert.deepEqual(exportCapabilitySummary(value,'docx',true),{kind:'unsupported',count:2})
 value.features[0].formats.docx={support:'native',dataRetention:'native'}
 assert.deepEqual(exportCapabilitySummary(value,'docx',false),{kind:'mixed',count:2})
 value.features[0].formats.docx={support:'semantic',dataRetention:'omitted'}
 assert.deepEqual(exportCapabilitySummary(value,'docx',false),{kind:'mixed',count:2})
})

test('resource reference count changes require review even if the business node count is unchanged',()=>{const original=readExportCapabilities(report(),'doc',3),next=report(4) as any;next.features[0].resourceCount=3;next.features[0].resourceExamples=['notes.bin'];const updated=readExportCapabilities(next,'doc',4);assert.equal(updated.features[0].resourceCount,3);assert.equal(exportCapabilityDecision(exportCapabilitySignature(original,'docx',false),updated,'docx',false),'review');next.features[0].resourceCount=-1;assert.throws(()=>readExportCapabilities(next,'doc',4))})

test('native offline archive keeps business envelopes and resources without borrowing a semantic adapter',()=>{
 const value=readExportCapabilities(report(),'doc',3);value.features[0].resourceCount=3;
 assert.deepEqual(exportRepresentation(value.features[0],'hcdz',false),{support:'native',dataRetention:'native'});
 assert.equal(exportCapabilityBlocked(value,'hcdz',false),false);assert.deepEqual(exportCapabilitySummary(value,'hcdz',false),{kind:'native',count:2});
 assert.notEqual(exportCapabilitySignature(value,'hcdz',false),exportCapabilitySignature(value,'docx',false));assert.throws(()=>exportRepresentation(value.features[0],'hcdz',true));
 const old=exportCapabilitySignature(value,'hcdz',false);value.features[0].resourceCount=4;assert.equal(exportCapabilityDecision(old,value,'hcdz',false),'review')
})

test('resource loss is visible before opening conversion details, while HCDZ retains its native summary',()=>{
 const value=readExportCapabilities(report(),'doc',3);value.features[0].resourceCount=1;value.features[0].resourceExamples=['attachment.txt']
 const render=(format:string)=>renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(ExportCompatibility,{report:value,format,source:false})}))
 const docx=render('docx');assert.match(docx,/1 处资源可能无法全部导出/);assert.match(docx,/使用离线 HCDZ 归档保留附件字节/)
 const hcdz=render('hcdz');assert.match(hcdz,/2 项扩展内容及其归档资源将完整保留/);assert.doesNotMatch(hcdz,/处资源可能无法全部导出/)
})
