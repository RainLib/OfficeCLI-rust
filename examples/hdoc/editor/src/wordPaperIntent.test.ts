import {test} from 'node:test'
import assert from 'node:assert/strict'
import {wordPaperIntent} from './wordPaperIntent.ts'
import {matchesWordLayoutTransition} from './wordLayoutTransition.ts'
import type {WordLayout} from './wordRegions.ts'

const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`,layoutHash='a'.repeat(64),paper={widthTwips:11906,heightTwips:16838,orientation:'portrait' as const}
function layout():WordLayout{return{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{widthTwips:12240,heightTwips:15840,orientation:'portrait',marginsTwips:{top:1440}},headers:{},footers:{}},{id:id(2),differentFirstPage:true,page:{},headers:{},footers:{}}],stories:[]}}
function prepare(target:{kind:'document'}|{kind:'section';sectionId:string},value=layout()){return wordPaperIntent({layout:value,layoutHash,revision:4,target,paper})}
test('whole-document paper intent preserves each section baseline and untouched settings',()=>{
 const source=layout(),before=structuredClone(source),result=prepare({kind:'document'},source);assert.deepEqual(source,before);assert.deepEqual(result.affectedSections,[id(1),id(2)])
 assert.deepEqual(result.intent!.changes,[{sectionId:id(1),field:'widthTwips',expected:12240,value:11906},{sectionId:id(1),field:'heightTwips',expected:15840,value:16838},{sectionId:id(2),field:'widthTwips',expected:null,value:11906},{sectionId:id(2),field:'heightTwips',expected:null,value:16838},{sectionId:id(2),field:'orientation',expected:null,value:'portrait'}])
 assert.deepEqual(result.preview.sections[0].page.marginsTwips,{top:1440});assert.equal(result.preview.sections[1].differentFirstPage,true)
 const request={schemaVersion:'hcd-word-layout-transaction/1' as const,documentId:'doc',transactionId:'b'.repeat(32),baseRevision:4,expectedRevision:4,actor:{userId:'alice',displayName:'Alice'},edits:result.intent!};assert.equal(matchesWordLayoutTransition(before,result.preview,request),true)
 const forged=structuredClone(result.preview);forged.sections[1].differentFirstPage=false;assert.equal(matchesWordLayoutTransition(before,forged,request),false)
})
test('current-section intent never changes other sections and avoids no-op transactions',()=>{
 const source=layout(),first=prepare({kind:'section',sectionId:id(1)},source);assert.deepEqual(first.affectedSections,[id(1)]);assert.deepEqual(first.preview.sections[1],source.sections[1]);assert.deepEqual(prepare({kind:'section',sectionId:id(1)},first.preview).intent,null)
 assert.throws(()=>prepare({kind:'section',sectionId:id(9)}),/section-unavailable/)
})
test('invalid dimensions, stale identities and oversized changes fail before a request is built',()=>{
 const source=layout();for(const value of [0,-1,200001,1.5,Number.NaN])assert.throws(()=>wordPaperIntent({layout:source,layoutHash,revision:4,target:{kind:'document'},paper:{...paper,widthTwips:value}}),/word-paper-invalid/)
 assert.throws(()=>wordPaperIntent({layout:source,layoutHash:'bad',revision:4,target:{kind:'document'},paper}))
 const many=layout();many.sections=Array.from({length:342},(_,i)=>({id:id(i+1),differentFirstPage:false,page:{},headers:{},footers:{}}));assert.throws(()=>prepare({kind:'document'},many),/word-paper-limit/)
})
