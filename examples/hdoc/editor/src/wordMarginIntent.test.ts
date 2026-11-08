import {test} from 'node:test'
import assert from 'node:assert/strict'
import {wordMarginIntent} from './wordMarginIntent.ts'
import {matchesWordLayoutTransition} from './wordLayoutTransition.ts'
import type {WordLayout} from './wordRegions.ts'
const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`,layoutHash='a'.repeat(64)
function layout():WordLayout{return{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{widthTwips:12240,marginsTwips:{top:1440,left:200}},headers:{},footers:{}},{id:id(2),differentFirstPage:true,page:{marginsTwips:{top:720,header:360}},headers:{},footers:{}}],stories:[]}}
test('document margins preserve section baselines, unset explicitly and leave other page settings intact',()=>{
 const source=layout(),before=structuredClone(source),result=wordMarginIntent({layout:source,layoutHash,revision:4,target:{kind:'document'},margins:{top:1000,left:null,footer:300}})
 assert.deepEqual(source,before);assert.deepEqual(result.affectedSections,[id(1),id(2)]);assert.deepEqual(result.intent!.changes,[{sectionId:id(1),field:'marginTop',expected:1440,value:1000},{sectionId:id(1),field:'marginLeft',expected:200,value:null},{sectionId:id(1),field:'marginFooter',expected:null,value:300},{sectionId:id(2),field:'marginTop',expected:720,value:1000},{sectionId:id(2),field:'marginFooter',expected:null,value:300}])
 const request={schemaVersion:'hcd-word-layout-transaction/1' as const,documentId:'doc',transactionId:'b'.repeat(32),baseRevision:4,expectedRevision:4,actor:{userId:'alice',displayName:'Alice'},edits:result.intent!};assert.equal(matchesWordLayoutTransition(before,result.preview,request),true)
 assert.equal(result.preview.sections[0].page.widthTwips,12240);assert.equal(result.preview.sections[1].page.marginsTwips?.header,360)
})
test('one section, no-op and invalid margins fail safely',()=>{
 const source=layout(),result=wordMarginIntent({layout:source,layoutHash,revision:4,target:{kind:'section',sectionId:id(1)},margins:{top:1440,left:null}});assert.deepEqual(result.preview.sections[1],source.sections[1]);assert.deepEqual(result.affectedSections,[id(1)]);assert.equal(wordMarginIntent({layout:result.preview,layoutHash,revision:4,target:{kind:'section',sectionId:id(1)},margins:{top:1440,left:null}}).intent,null)
 for(const margins of [{right:-1},{header:200001},{top:-200001},{left:1.5},{left:undefined},{unknown:10},{}])assert.throws(()=>wordMarginIntent({layout:source,layoutHash,revision:4,target:{kind:'document'},margins} as never),/word-margin-invalid/)
 assert.throws(()=>wordMarginIntent({layout:source,layoutHash,revision:4,target:{kind:'section',sectionId:id(9)},margins:{top:100}}),/section-unavailable/)
 const many=layout();many.sections=Array.from({length:513},(_,i)=>({id:id(i+1),differentFirstPage:false,page:{},headers:{},footers:{}}));assert.throws(()=>wordMarginIntent({layout:many,layoutHash,revision:4,target:{kind:'document'},margins:{top:100,left:100}}),/word-margin-limit/)
})
