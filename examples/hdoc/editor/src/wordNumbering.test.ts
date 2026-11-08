import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {wordNumberingIntent,wordNumberStartInput,validWordNumberingValue,type WordNumbering} from './wordNumberingIntent.ts'
import {wordPageIntent} from './wordPageIntent.ts'
import {wordPageValue} from './wordPageValues.ts'
import {matchesWordLayoutTransition} from './wordLayoutTransition.ts'
import {WordPageTransaction,readWordPageRecord} from './wordPageTransaction.ts'
import {WordLayoutAttempts,readWordLayoutAction,type StoppedLayoutAction} from './wordLayoutAttempt.ts'
import {openWordStoryRequestStore} from './wordStoryRequestStore.ts'
import {WordPageSetup} from './WordPageSetup.tsx'
import {WordRegionProperties} from './WordRegionProperties.tsx'
import {I18nProvider,translate,type MessageKey} from './i18n.tsx'
import type {WordLayout} from './wordRegions.ts'
import type {Session} from './api.ts'
const id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),hash='a'.repeat(64)
const layout:WordLayout={schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,stories:[],sections:[{id:id(1),differentFirstPage:false,page:{widthTwips:12240,heightTwips:15840,numberStart:1,numberFormat:'decimal',marginsTwips:{left:1440}},headers:{},footers:{}},{id:id(2),differentFirstPage:false,page:{numberStart:4,numberFormat:'hindiNumbers'},headers:{},footers:{}}]}
const session:Session={documentId:'doc',token:'owned-test',format:'docx',scope:'write',userId:'alice',displayName:'Alice',collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2',apiUrl:'/v1/documents',collabUrl:'ws://owned.test'}
const base='https://owned.test/editor',t=(key:MessageKey,values?:Record<string,string|number>)=>translate('zh-CN',key,values)
test('section numbering composes with whole-document paper without resetting other section formats',()=>{
 const before=structuredClone(layout),result=wordPageIntent({layout,layoutHash:hash,revision:2,target:{kind:'document'},paper:{widthTwips:11906,heightTwips:16838,orientation:'portrait'},numbering:{sectionId:id(1),start:8,format:'upperRoman'}})
 assert.deepEqual(layout,before);assert.deepEqual(result.preview.sections[1].page.numberFormat,'hindiNumbers');assert.equal(result.preview.sections[1].page.numberStart,4)
 assert.deepEqual(result.intent!.changes.filter(change=>change.field==='numberStart'||change.field==='numberFormat'),[{sectionId:id(1),field:'numberStart',expected:1,value:8},{sectionId:id(1),field:'numberFormat',expected:'decimal',value:'upperRoman'}])
 assert.equal(matchesWordLayoutTransition(before,result.preview,{schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'b'.repeat(32),baseRevision:2,expectedRevision:2,actor:{userId:'alice',displayName:'Alice'},edits:result.intent!}),true)
})
test('continue/default remove only explicit numbering properties; omitted fields and zero are retained',()=>{
 const cleared=wordNumberingIntent({layout,layoutHash:hash,revision:2,numbering:{sectionId:id(2),start:null,format:null}})
 assert.deepEqual(cleared.preview.sections[1].page,{});assert.equal(cleared.intent!.changes[1].expected,'hindiNumbers')
 assert.equal(wordNumberingIntent({layout:cleared.preview,layoutHash:hash,revision:2,numbering:{sectionId:id(2),start:null,format:null}}).intent,null)
 const zero=wordNumberingIntent({layout,layoutHash:hash,revision:2,numbering:{sectionId:id(2),start:0}});assert.equal(zero.preview.sections[1].page.numberStart,0);assert.equal(zero.preview.sections[1].page.numberFormat,'hindiNumbers')
 assert.deepEqual(cleared.preview.sections[0],layout.sections[0]);assert.deepEqual(layout.sections[1].page,{numberStart:4,numberFormat:'hindiNumbers'})
})
test('numbering rejects invalid values and foreign sections without coercion or mutating layout',()=>{
 const before=structuredClone(layout)
 for(const bad of [{sectionId:id(9),start:1},{sectionId:id(1)},{sectionId:id(1),start:-1},{sectionId:id(1),start:2_147_483_648},{sectionId:id(1),start:1.5},{sectionId:id(1),start:'3'},{sectionId:id(1),start:undefined},{sectionId:id(1),format:undefined},{sectionId:id(1),format:'unknown'},{sectionId:id(1),format:'decimal',extra:1}])assert.throws(()=>wordNumberingIntent({layout,layoutHash:hash,revision:2,numbering:bad as WordNumbering}))
 assert.deepEqual(layout,before);assert.equal(validWordNumberingValue('numberFormat','hindiNumbers'),true);assert.equal(validWordNumberingValue('unknown',null),false)
})
test('page-number input accepts decimal integers only and never treats an empty field as zero',()=>{
 assert.equal(wordNumberStartInput(' 008 '),8);assert.equal(wordNumberStartInput('0'),0);assert.equal(wordNumberStartInput('2147483647'),2147483647)
 for(const bad of ['', ' ', '-1','1.5','1e2','Infinity','三','2147483648'])assert.throws(()=>wordNumberStartInput(bad))
})
test('review and recovery format numbering as counts and labels rather than millimetres',()=>{
 assert.equal(wordPageValue('numberStart',8,t,'zh-CN'),'8');assert.equal(wordPageValue('numberFormat','upperRoman',t,'zh-CN'),'I, II, III, …');assert.equal(wordPageValue('numberFormat','hindiNumbers',t,'zh-CN'),'hindiNumbers')
 assert.equal(wordPageValue('numberStart',null,t,'zh-CN'),'继续上一节');assert.equal(wordPageValue('numberFormat',null,t,'zh-CN'),'文档默认（未指定）');assert.equal(wordPageValue('marginLeft',1440,t,'zh-CN'),'25.4 mm')
})
test('a numbering-only normal page request is durable across reopen and rejects malformed counts',async()=>{
 const factory=new IDBFactory(),store=()=>openWordStoryRequestStore('numbering-normal',factory,'word-page'),intent=wordPageIntent({layout,layoutHash:hash,revision:2,target:{kind:'section',sectionId:id(2)},numbering:{sectionId:id(2),start:null,format:'lowerRoman'}}).intent!
 const tx=await WordPageTransaction.open(session,base,{storage:await store()})
 try{await tx.prepare(2,intent,layout);const record=tx.record!,raw=tx.backup;assert.deepEqual(readWordPageRecord(record,session),record);tx.dispose();const reopened=await WordPageTransaction.open(session,base,{storage:await store()});try{assert.equal(reopened.backup,raw);assert.deepEqual(reopened.record,record);for(const value of [-1,1.5,'4',2_147_483_648]){const bad=structuredClone(record);bad.request.edits.changes[0].value=value;assert.throws(()=>readWordPageRecord(bad,session))}}finally{reopened.dispose()}}finally{tx.dispose()}
})
test('stopped numbering requests preserve exact null and format values through device reopening',async()=>{
 const factory=new IDBFactory(),store=()=>openWordStoryRequestStore('numbering-stopped',factory,'word-layout'),intent=wordPageIntent({layout,layoutHash:hash,revision:2,target:{kind:'section',sectionId:id(2)},numbering:{sectionId:id(2),start:null,format:'lowerRoman'}}).intent!,action:StoppedLayoutAction={kind:'layout',sections:[{id:id(2),number:2}],body:{epoch:1,operation:'apply',revision:2,reviewHash:hash,transactionId:'c'.repeat(32),edits:intent}},tx=await WordLayoutAttempts.open(session,base,{storage:await store()})
 try{await tx.prepare(action,true);const raw=tx.backup;tx.dispose();const reopened=await WordLayoutAttempts.open(session,base,{storage:await store()});try{assert.equal(reopened.backup,raw);assert.deepEqual(reopened.record!.actions[0],action);const bad=structuredClone(action);bad.body.edits.changes[1].value='invalid format';assert.throws(()=>readWordLayoutAction(bad,session))}finally{reopened.dispose()}}finally{tx.dispose()}
})
test('page setup exposes explicit section numbering scope and states preview limits',()=>{
 const markup=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordPageSetup,{layout,layoutHash:hash,revision:2,section:1,onClose:()=>{}})}))
 assert.match(markup,/页码编号 · 第 2 节/);assert.match(markup,/与上方纸张作用范围独立/);assert.match(markup,/hindiNumbers/);assert.match(markup,/不会自动插入页码域/);assert.match(markup,/保持原设置/)
})

test('read-only properties retain a zero start and unknown source numbering format',()=>{
 const source=structuredClone(layout);source.sections[1].page.numberStart=0
 const render=()=>renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordRegionProperties,{state:{layout:source,revision:2},region:{kind:'body',id:id(2),sourcePart:'word/document.xml'},onRetry:()=>{},onPreviewSection:()=>{}})}))
 assert.match(render(),/<dd>0<\/dd>/);assert.match(render(),/<dd>hindiNumbers<\/dd>/)
 delete source.sections[1].page.numberStart;delete source.sections[1].page.numberFormat
 assert.match(render(),/继续上一节/);assert.match(render(),/文档默认（未指定）/)
})
